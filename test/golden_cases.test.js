// Runs every case in data/golden_cases.json through the real pipeline with a carrier-like fake Shippo.
// Cases are DATA: adding a failing listing never requires touching code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildItemProfile, DEFAULTS } = require('../lib/itemProfile');
const { compileResult } = require('../lib/pipeline');
const { TTLCache } = require('../lib/rates');
const { makeFakeShippo } = require('./helpers');
const { cases } = require('../data/golden_cases.json');

const packageVolume = dimensions => dimensions.split(' x ').slice(0, 3).reduce((a, s) => a * parseFloat(s), 1);

for (const c of cases) {
  test(`golden: ${c.id} (${c.source})`, async () => {
    const profile = c.profile
      ? { ...DEFAULTS, ...c.profile, compression: 1, unitsPerListing: 1, source: 'golden', confidence: 0.9, weightSource: 'golden', notes: [] }
      : await buildItemProfile({ title: c.title, categoryPath: c.categoryPath, weight: c.weight, scrapedDimensions: c.scrapedDimensions }, {});

    const r = await compileResult({
      profile, qty: c.qty || 1, pageShippingCost: c.pageShippingCost ?? null, shippo: makeFakeShippo(),
      rateCache: new TTLCache(), from: { zip: '27045' }, to: { zip: '94556' }
    });

    const e = c.expect || {};
    const why = `${r.boxModel} ${r.dimensions} | ${r.explain.packing} | ${r.liveRate} | profile=${r.profileSource}`;
    assert.equal(r.success, true);
    if (e.kind) assert.equal(/Mailer/.test(r.boxModel) ? 'flexible' : 'rigid', e.kind, why);
    if (e.maxVolume) assert.ok(packageVolume(r.dimensions) <= e.maxVolume, `volume ${packageVolume(r.dimensions)} > ${e.maxVolume}: ${why}`);
    if (e.nameMatches) assert.match(r.boxModel, new RegExp(e.nameMatches), why);
    if (e.nameNotMatches) assert.doesNotMatch(r.boxModel, new RegExp(e.nameNotMatches), why);
    if (e.maxPackageWeightOz) assert.ok(r.packageWeightOz <= e.maxPackageWeightOz, `weight ${r.packageWeightOz} > ${e.maxPackageWeightOz}: ${why}`);
  });
}
