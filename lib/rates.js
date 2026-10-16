// Live rate shopping through Shippo. No made-up numbers: if we can't get a real
// quote the caller is told so and nothing is substituted.
const { TTLCache } = require('./cache');

// Carriers round weight up (to the ounce under 1 lb, to the pound above), so we
// quote at the bucket ceiling. That's accurate and makes cache entries reusable.
function weightBucketOz(oz) {
  const o = Math.max(1, Math.ceil(oz));
  return o <= 16 ? o : Math.ceil(o / 16) * 16;
}

function pickBestRate(rates) {
  let best = null;
  for (const r of rates || []) {
    const amount = parseFloat(r.amount ?? r.rate);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!best || amount < best.amount) {
      const svc = r.servicelevel ? (r.servicelevel.name || r.servicelevel) : (r.servicelevelName || '');
      best = {
        amount, currency: r.currency || 'USD', provider: r.provider || 'Carrier', service: String(svc),
        estimatedDays: r.estimatedDays ?? r.estimated_days ?? null
      };
    }
  }
  if (best) best.carrier = `${best.provider} ${best.service}`.trim();
  return best;
}

function buildShipmentRequest(cand, from, to, bucketOz) {
  const parcel = cand.template
    ? { template: cand.template, weight: String(bucketOz), massUnit: 'oz' }
    : {
        length: String(cand.l), width: String(cand.w), height: String(cand.h),
        distanceUnit: 'in', weight: String(bucketOz), massUnit: 'oz'
      };
  const addressFrom = { name: 'Seller', street1: '1 Main St', city: from.city || 'Origin', zip: from.zip, country: 'US' };
  if (from.state) addressFrom.state = from.state;
  const addressTo = { name: 'Buyer', street1: '1 Main St', zip: to.zip, country: 'US' };
  return { addressFrom, addressTo, parcels: [parcel], async: false };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`rate request timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function quoteCandidate({ shippo, cache, cand, from, to, timeoutMs = 9000, onError = () => {} }) {
  const bucket = weightBucketOz(cand.weightOz);
  const shape = cand.template || `${cand.l}x${cand.w}x${cand.h}`;
  const key = `${shape}|${bucket}|${String(from.zip).slice(0, 3)}|${String(to.zip).slice(0, 3)}`;
  const hit = cache && cache.get(key);
  if (hit) return { ...hit, cached: true };
  try {
    const shipment = await withTimeout(shippo.shipments.create(buildShipmentRequest(cand, from, to, bucket)), timeoutMs);
    const best = pickBestRate(shipment && shipment.rates);
    if (best && cache) cache.set(key, best);
    return best;
  } catch (err) {
    onError(err, cand);
    return null;
  }
}

// Quote every candidate in parallel; returns [{cand, quote, total}] cheapest first.
async function shopRates({ shippo, candidates, from, to, cache, timeoutMs, onError }) {
  if (!shippo) return [];
  const settled = await Promise.all(
    candidates.map(cand => quoteCandidate({ shippo, cache, cand, from, to, timeoutMs, onError }).then(quote => ({ cand, quote })))
  );
  return settled
    .filter(r => r.quote)
    .map(r => ({ ...r, total: r.quote.amount + (r.cand.costUsd || 0) }))
    .sort((a, b) => a.total - b.total);
}

module.exports = { shopRates, quoteCandidate, pickBestRate, weightBucketOz, buildShipmentRequest, TTLCache };
