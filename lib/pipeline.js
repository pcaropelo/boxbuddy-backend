// ItemProfile -> candidates -> fit check -> rate shop -> select -> honest response.
const { findFitting, buildCustom, pickRateShopSet, packageWarnings, defaultLibrary } = require('./packaging');
const { shopRates } = require('./rates');

const MAX_UNITS = 500;
const fmt = n => String(Number(Number(n).toFixed(2)));
const dimString = c => `${fmt(c.l)} x ${fmt(c.w)} x ${fmt(c.h)} in`;
const money = n => `$${Number(n).toFixed(2)}`;
const label = score => (score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : 'low');

async function compileResult({
  profile, qty = 1, pageShippingCost = null, from, to, shippo, rateCache,
  library = defaultLibrary, geoConfidence = 1, onError
}) {
  // qty = how many listings the buyer purchases; unitsPerSale = identical units inside each ("2 Pack").
  const units = Math.min(MAX_UNITS, Math.max(1, (profile.unitsPerSale || 1) * qty));

  let candidates = findFitting(profile, units, library);
  if (!candidates.length) candidates = [buildCustom(profile, units)];

  const shopSet = pickRateShopSet(candidates);
  // A snug custom box is also quoted when every stock option is much roomier than the goods need;
  // the carrier's real price (plus packaging cost) decides, and it must win by a clear margin.
  let customTried = null;
  if (!candidates[0].isCustom && !profile.mailerOk) {
    const snug = buildCustom(profile, units);
    if (snug.volume < 0.85 * candidates[0].volume) { customTried = snug; shopSet.push(snug); }
  }
  let quotes = await shopRates({ shippo, candidates: shopSet, from, to, cache: rateCache, onError });
  if (customTried && quotes.length) {
    const bestStock = quotes.find(q => !q.cand.isCustom);
    const cq = quotes.find(q => q.cand.isCustom);
    if (cq && bestStock && cq.total > bestStock.total - Math.max(0.5, bestStock.total * 0.03)) {
      quotes = quotes.filter(q => !q.cand.isCustom); // not worth the hassle of a custom box
    }
  }

  const best = quotes[0] || null;
  const chosen = best ? best.cand : candidates[0]; // no live rate: smallest fit, clearly labeled
  const quote = best ? best.quote : null;
  const boxName = chosen.name + (units > 1 ? ' (Multi-Item)' : '');

  const score = quote ? Math.min(profile.confidence, geoConfidence) : 0;
  const confidence = { score: Number(score.toFixed(2)), label: label(score) };

  const hasPageCost = Number(pageShippingCost) > 0;
  const savings = quote && hasPageCost ? Number(pageShippingCost) - quote.amount : null;

  let buyer;
  let seller;
  if (!quote) {
    buyer = seller = `Rate unavailable - Box: ${chosen.name}`;
  } else if (savings !== null && savings > 0.005) {
    const s = money(savings);
    const low = confidence.label === 'low';
    buyer = low ? `Est. savings up to ${s}` : `Optimized! Saved ${s} 🎉`;
    seller = low ? `Est. profit up to ${s}` : `Profit Increased by ${s} 💰`;
  } else {
    buyer = seller = `Alternative Rate: ${money(quote.amount)}`;
  }

  const quoted = new Map(quotes.map(q => [q.cand.id, q.quote]));
  return {
    success: true,
    boxModel: boxName,
    dimensions: dimString(chosen),
    liveRate: quote ? money(quote.amount) : 'Unavailable',
    carrier: quote ? quote.carrier : null,
    buttonTextBuyer: buyer,
    buttonTextSeller: seller,
    rateSource: quote ? 'shippo' : 'unavailable',
    savings: savings === null ? null : Number(savings.toFixed(2)),
    confidence,
    profileSource: profile.source,
    units,
    packageWeightOz: Math.max(1, Math.round(chosen.weightOz)),
    warnings: packageWarnings(chosen),
    alternatives: quotes.slice(1, 3).map(q => ({
      boxModel: q.cand.name, dimensions: dimString(q.cand), liveRate: money(q.quote.amount), carrier: q.quote.carrier
    })),
    // Everything needed to answer "why did it pick that box?" (returned only when the request sets debug:true)
    explain: {
      units, unitsPerSale: profile.unitsPerSale || 1, qty,
      itemWeightOz: Number((profile.weightOz * units).toFixed(2)),
      packing: { grid: chosen.arrangement || null, package: chosen.name },
      unitDimsIn: profile.dims, unitWeightOz: Number(profile.weightOz.toFixed(2)), weightSource: profile.weightSource,
      rigidity: profile.rigidity, stackFactor: profile.stackFactor, notes: profile.notes || [],
      fittingPackages: candidates.length, customBoxFallback: !!chosen.isCustom,
      quoted: shopSet.map(c => {
        const q = quoted.get(c.id);
        return { box: c.name, dims: dimString(c), weightOz: Math.round(c.weightOz), rate: q ? q.amount : null, carrier: q ? q.carrier : null };
      })
    }
  };
}

module.exports = { compileResult, MAX_UNITS };
