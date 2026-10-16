// Builds an ItemProfile: what ONE unit physically is, where we learned it, and how much to trust it.
// Sources, in priority order:
//   1. user corrections   (the submitter immediately; everyone else once 2+ users agree)
//   2. listing dimensions (scraped from the page, cross-checked against the category prior)
//   3. category rules     (data/categories.json)
//   4. LLM                (a CLASSIFIER into our archetypes first, a measurer only when nothing matches)
//   5. generic default
//
// Units: dims and weightOz describe ONE unit. A listing can contain several identical units
// ("2 Pack"): unitsPerSale. A buyer can purchase several listings: qty. Packed units = unitsPerSale * qty.
const { matchCategory, norm, ruleById } = require('./categories');

const FRAGILITY = ['low', 'med', 'high'];
const DEFAULTS = Object.freeze({
  dims: [12, 9, 4], weightOz: 16, rigidity: 'rigid', fragility: 'med',
  stackFactor: 1, mailerOk: false, pieces: 1
});

function sanitizeTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*\|\s*ebay\s*$/i, '')
    .replace(/\b(NWT|NWOB|MINT|L@@K|LOOK|FAST SHIP|FREE SHIPPING|GREAT CONDITION|MUST SEE|AUTHENTIC|RARE|VINTAGE)\b/gi, '')
    .replace(/[^\w\s-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const normalizeKey = title => sanitizeTitle(title).toLowerCase().slice(0, 140);

const vol3 = d => d[0] * d[1] * d[2];
// Valid dims -> sorted longest-first, else null.
function cleanDims(arr) {
  if (!Array.isArray(arr) || arr.length !== 3) return null;
  const n = arr.map(Number);
  if (n.some(v => !Number.isFinite(v) || v < 0.1 || v > 120)) return null;
  return n.sort((a, b) => b - a);
}
const scrapedToDims = s => (s ? cleanDims([s.length, s.width, s.height]) : null);

// "1 lb 4 oz", "12 oz", "2.5 lbs", "340 g", "1.2 kg", 16, "16" -> ounces. Unknown -> null (never a guess).
function parseWeightOz(raw) {
  if (raw == null || raw === '') return null;
  const ok = n => (Number.isFinite(n) && n > 0 && n <= 2400 ? n : null);
  if (typeof raw === 'number') return ok(raw);
  const s = String(raw).toLowerCase().replace(/,/g, '').trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return ok(parseFloat(s));
  let oz = 0;
  let found = false;
  const lb = s.match(/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/);
  const o = s.match(/(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/);
  if (lb) { oz += parseFloat(lb[1]) * 16; found = true; }
  if (o) { oz += parseFloat(o[1]); found = true; }
  if (!found) {
    const kg = s.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilograms?|kilos?)\b/);
    const g = s.match(/(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/);
    if (kg) { oz = parseFloat(kg[1]) * 35.274; found = true; }
    else if (g) { oz = parseFloat(g[1]) * 0.035274; found = true; }
  }
  return found ? ok(oz) : null;
}

// Identical units inside ONE sale: "2 Pack", "(4 Pack)", "Pack of 3", "Lot of 5", "Set of 6", "3 pairs".
// Deliberately NOT "12 piece" (a set of different things, not N copies of one thing).
function parseUnitsPerSale(title) {
  const t = norm(title);
  const patterns = [/\b(\d{1,3}) ?(?:pack|pk)\b/, /\bpack of (\d{1,3})\b/, /\b(?:lot|set|bundle) of (\d{1,3})\b/, /\b(\d{1,3}) pairs?\b/];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 2 && n <= 24) return { units: n, matched: m[0] };
    }
  }
  return { units: 1, matched: null };
}

function fromRule(rule) {
  return {
    dims: cleanDims(rule.dims), weightOz: rule.weightOz, rigidity: rule.rigidity, fragility: rule.fragility,
    stackFactor: rule.stackFactor ?? (rule.rigidity === 'flexible' ? 0.7 : 1),
    mailerOk: !!rule.mailerOk, pieces: rule.pieces || 1
  };
}

// Breakdown items (two-piece fishing rods etc.): ship the longest piece.
function applyPieces(p) {
  if (p.pieces > 1) {
    const d = [...p.dims];
    d[0] = Math.ceil(d[0] / p.pieces);
    p.dims = d.sort((a, b) => b - a);
  }
  return p;
}

// LLM output is untrusted. Valid = a known archetype and/or sane measurements.
function validateLLM(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const archetype = typeof raw.archetype === 'string' && ruleById(raw.archetype) ? raw.archetype : null;
  const dims = cleanDims([raw.lengthIn ?? raw.baseLength, raw.widthIn ?? raw.baseWidth, raw.heightIn ?? raw.baseHeight]);
  const weightOz = Number(raw.weightOz ?? raw.baseWeightOunces);
  const weightOk = Number.isFinite(weightOz) && weightOz >= 0.1 && weightOz <= 2400;
  const density = dims && weightOk ? weightOz / vol3(dims) : null;
  const measured = !!(dims && weightOk && density >= 0.003 && density <= 4.5); // rejects "0.2 oz, 40 inch bat"
  if (!archetype && !measured) return null;
  const rigidity = raw.rigidity === 'flexible' ? 'flexible' : 'rigid';
  const sf = Number(raw.stackFactor);
  return {
    archetype,
    dims: measured ? dims : null,
    weightOz: measured ? weightOz : null,
    rigidity,
    fragility: FRAGILITY.includes(raw.fragility) ? raw.fragility : 'med',
    stackFactor: rigidity === 'rigid' ? 1 : (sf >= 0.3 && sf <= 1 ? sf : 0.7),
    pieces: Math.min(6, Math.max(1, Math.round(Number(raw.pieces)) || 1)),
    confidence: Math.min(0.7, Math.max(0.2, Number(raw.confidence) || 0.5))
  };
}

// Where we hold a prior (a matching archetype), the LLM only classifies: its numbers are NOT used,
// because models routinely report shipping-box dimensions instead of item dimensions.
// Resolved at read time, so editing a rule in data/ also corrects previously cached answers.
function profileFromLLM(data) {
  const rule = data.archetype ? ruleById(data.archetype) : null;
  if (rule) return { ...fromRule(rule), confidence: Math.min(0.65, data.confidence ?? 0.5), llmArchetype: rule.id };
  return {
    ...DEFAULTS, dims: data.dims, weightOz: data.weightOz, rigidity: data.rigidity, fragility: data.fragility,
    stackFactor: data.stackFactor ?? 1, pieces: data.pieces || 1, confidence: Math.min(0.7, data.confidence ?? 0.5)
  };
}

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function findCorrection(db, key, userId) {
  const docs = await db.find({ key });
  if (!docs.length) return null;
  const own = docs.find(d => d.userId === userId);
  if (own) return own;
  if (new Set(docs.map(d => d.userId)).size < 2) return null; // one stranger is not consensus
  const latest = [...docs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return {
    dims: [0, 1, 2].map(i => median(docs.map(d => d.dims[i]))),
    weightOz: median(docs.map(d => d.weightOz).filter(Boolean)) || null,
    rigidity: latest.rigidity, fragility: latest.fragility, stackFactor: latest.stackFactor
  };
}

// A correction describes ONE unit (dims in inches, weight in ounces).
async function saveCorrection(db, { title, userId, dims, weightOz, rigidity, fragility }) {
  const key = normalizeKey(title);
  const d = cleanDims(dims);
  if (!key || !d) throw Object.assign(new Error('invalid correction'), { code: 'INVALID' });
  const w = weightOz == null ? null : parseWeightOz(weightOz);
  if (weightOz != null && !w) throw Object.assign(new Error('invalid weight'), { code: 'INVALID' });
  const soft = rigidity === 'flexible';
  const doc = {
    key, userId, dims: d, weightOz: w, rigidity: soft ? 'flexible' : 'rigid',
    fragility: FRAGILITY.includes(fragility) ? fragility : 'med', stackFactor: soft ? 0.7 : 1, updatedAt: Date.now()
  };
  await db.update({ key, userId }, doc, { upsert: true });
  return doc;
}

async function buildItemProfile(input, deps = {}) {
  const { title, categoryPath, scrapedDimensions, weight, userId, itemSpecifics } = input;
  const { corrections, profiles, llm } = deps;
  const key = normalizeKey(title);
  const notes = [];
  const match = matchCategory(title, categoryPath);
  const pack = parseUnitsPerSale(title);
  if (pack.matched) notes.push(`${pack.units} units per sale parsed from "${pack.matched}"`);
  let profile = null;
  let correctionHasWeight = false;

  // 1. corrections
  if (key && corrections) {
    const c = await findCorrection(corrections, key, userId);
    if (c) {
      const soft = c.rigidity === 'flexible';
      profile = {
        ...DEFAULTS, dims: cleanDims(c.dims), weightOz: c.weightOz || DEFAULTS.weightOz,
        rigidity: soft ? 'flexible' : 'rigid', fragility: c.fragility || 'med',
        stackFactor: soft ? (c.stackFactor || 0.7) : 1, source: 'user_correction', confidence: 0.9
      };
      correctionHasWeight = !!c.weightOz;
    }
  }

  // 2. listing dimensions, cross-checked against the category prior: two independent sources that
  //    disagree by more than 4x in volume means one of them is wrong, and the prior is the safer one.
  if (!profile) {
    const d = scrapedToDims(scrapedDimensions);
    if (d) {
      const prior = match ? cleanDims(match.rule.dims) : null;
      const ratio = prior ? vol3(d) / vol3(prior) : 1;
      if (prior && (ratio > 4 || ratio < 0.25)) {
        notes.push(`listing dimensions ${d.join('x')} ignored: ${ratio.toFixed(1)}x the "${match.rule.id}" prior`);
      } else {
        const base = match ? fromRule(match.rule) : { ...DEFAULTS, fragility: 'low' };
        profile = { ...base, dims: d, pieces: 1, source: 'listing_dimensions', confidence: 0.85 };
      }
    }
  }

  // 3. category rule
  if (!profile && match) {
    profile = { ...fromRule(match.rule), source: `category_rule:${match.rule.id}`, confidence: match.rule.priority >= 50 ? 0.6 : 0.5 };
    notes.push(`matched "${match.matched.join(', ')}" in ${match.field}`);
  }

  // 4. LLM (cached per normalized title)
  if (!profile && key) {
    const cached = profiles ? await profiles.findOne({ key }) : null;
    const stored = cached && cached.data;
    // Re-check at read time: a rule may have been removed or renamed since the answer was cached.
    let data = stored && ((stored.archetype && ruleById(stored.archetype)) || (stored.dims && stored.weightOz)) ? stored : null;
    const fromCache = !!data;
    if (!data && llm) {
      let raw = null;
      try { raw = await llm({ title, categoryPath, itemSpecifics }); } catch { /* fall through to default */ }
      data = validateLLM(raw);
      if (data && profiles) await profiles.update({ key }, { key, data, createdAt: Date.now() }, { upsert: true }).catch(() => {});
      else if (!data && raw) notes.push('llm output rejected by validation');
    }
    if (data) {
      profile = { ...profileFromLLM(data), source: fromCache ? 'llm_cache' : 'llm' };
      if (profile.llmArchetype) notes.push(`llm classified as "${profile.llmArchetype}"`);
    }
  }

  // 5. default
  if (!profile) profile = { ...DEFAULTS, source: 'default', confidence: 0.2 };

  // Weight. The listing weight describes the whole sale, so per-unit = listing / unitsPerSale.
  const listingWeight = parseWeightOz(weight);
  if (correctionHasWeight) {
    profile.weightSource = 'correction';
  } else if (listingWeight) {
    profile.weightOz = listingWeight / pack.units;
    profile.weightSource = 'listing';
    if (profile.source !== 'listing_dimensions' && profile.source !== 'user_correction') {
      profile.confidence = Math.min(1, profile.confidence + 0.1);
    }
  } else {
    profile.weightSource = 'estimated';
  }

  applyPieces(profile);
  return { ...profile, key, notes, unitsPerSale: pack.units, unitsPerListing: pack.units };
}

module.exports = {
  buildItemProfile, saveCorrection, findCorrection, validateLLM, profileFromLLM, normalizeKey, sanitizeTitle,
  cleanDims, parseWeightOz, parseUnitsPerSale, parsePackCount: t => parseUnitsPerSale(t).units, scrapedToDims, DEFAULTS
};
