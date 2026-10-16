// Category rules are DATA (data/categories.json), not if/else chains.
// To teach the engine a new product type, add a rule there; no code changes.
//
// Matching is whole-word/phrase (so "bat" never hits "bath"/"battery"), plural
// tolerant, and respects each rule's "none" exclusions. The listing TITLE is
// tried first; only if nothing matches do we fall back to the leaf of the
// eBay category path (top-level names like "Clothing, Shoes & Accessories"
// would otherwise match everything).
const RAW = require('../data/categories.json');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function phraseRegex(phrase) {
  const body = norm(phrase).split(' ').map(escapeRe).join('\\s+');
  return new RegExp(`\\b${body}(?:s|es)?\\b`);
}

function compile(rules) {
  return rules.map(r => ({
    ...r,
    anyRe: r.any.map(p => ({ len: norm(p).length, re: phraseRegex(p), phrase: p })),
    noneRe: (r.none || []).map(phraseRegex)
  }));
}

const DEFAULT_RULES = compile(RAW);

function leafOfPath(categoryPath) {
  const segs = String(categoryPath || '').split(/[>\/|]/).map(s => s.trim()).filter(Boolean);
  return segs.slice(-2).join(' ');
}

function bestMatch(text, rules) {
  if (!text) return null;
  let best = null;
  for (const rule of rules) {
    const matched = rule.anyRe.filter(x => x.re.test(text));
    if (!matched.length) continue;
    if (rule.noneRe.some(re => re.test(text))) continue;
    const score = rule.priority * 1000 + Math.max(...matched.map(m => m.len));
    if (!best || score > best.score) {
      best = { rule, score, matched: matched.map(m => m.phrase) };
    }
  }
  return best;
}

function matchCategory(title, categoryPath, rules = DEFAULT_RULES) {
  const byTitle = bestMatch(norm(title), rules);
  if (byTitle) return { ...byTitle, field: 'title' };
  const byPath = bestMatch(norm(leafOfPath(categoryPath)), rules);
  return byPath ? { ...byPath, field: 'category_path' } : null;
}

const BY_ID = new Map(DEFAULT_RULES.map(r => [r.id, r]));
const ruleById = id => BY_ID.get(id) || null;
// Short "id (example phrases)" lines the LLM classifier chooses from.
const archetypeHints = () => DEFAULT_RULES.map(r => `${r.id} (${r.any.slice(0, 3).join(', ')})`);

module.exports = { matchCategory, compile, norm, ruleById, archetypeHints, DEFAULT_RULES };
