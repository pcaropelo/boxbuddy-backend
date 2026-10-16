// Golden tests for the deterministic core. Add a case here whenever a real listing comes out wrong,
// then fix the DATA (data/categories.json, data/packages.json), not the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchCategory } = require('../lib/categories');
const { classifyLocation, resolveOrigin, resolveDestination } = require('../lib/geo');
const { buildItemProfile, validateLLM, saveCorrection } = require('../lib/itemProfile');
const { findFitting, buildCustom, pickRateShopSet, packageWarnings } = require('../lib/packaging');
const { compileResult } = require('../lib/pipeline');
const { weightBucketOz, pickBestRate, TTLCache } = require('../lib/rates');
const { FakeDb, makeFakeShippo, fakeHttp } = require('./helpers');

const ruleId = (title, path) => { const m = matchCategory(title, path); return m ? m.rule.id : null; };
const profileFor = (title, extra = {}) => buildItemProfile({ title, ...extra }, {});

test('category matching: whole words, exclusions, title before path', () => {
  const cases = [
    ['Golf Polo Shirt Mens Large', null, 'apparel_generic'],
    ['Bath Towel Set', null, null],
    ['Acrobat Reader Software Disc', null, null],
    ['Combat Boots Size 10', null, 'boots'],
    ['Rawlings Baseball Bat 33in', null, 'baseball_bat'],
    ['Wilson Tennis Racket', null, 'racket'],
    ['Wilson Racket Bag', null, null],
    ['Callaway Golf Club Driver 10.5', null, 'golf_clubs'],
    ['Titleist TSR3 Driver', 'Sporting Goods > Golf > Golf Clubs & Equipment > Drivers', 'golf_clubs'],
    ['Callaway Golf Bag Stand', 'Sporting Goods > Golf > Golf Clubs & Equipment > Golf Bags', null],
    ['Mens Dress Shirt', "Clothing, Shoes & Accessories > Men > Men's Clothing > Casual Shirts", 'apparel_generic'],
    ['Nike Air Max', "Clothing, Shoes & Accessories > Men > Men's Shoes > Athletic Shoes", 'shoes'],
    ['Polo Ralph Lauren Mens Shoes', null, 'shoes'],
    ['Apple Watch Series 7 45mm', null, 'watch'],
    ['Apple Watch Band 42mm', null, null],
    ['Apple iPhone 13 128GB', null, 'smartphone'],
    ['iPhone 13 Case', null, null],
    ['Pokemon Cards Lot Holo', null, 'trading_cards'],
    ['Hardcover Book First Edition', null, 'books'],
    ['Reading Book Light', null, null]
  ];
  for (const [title, path, expected] of cases) {
    assert.equal(ruleId(title, path), expected, `"${title}" -> expected ${expected}`);
  }
});

test('location classification has no substring false positives', () => {
  const cases = {
    'Mumbai, India': 'foreign', 'Yukon, OK': 'us', 'Portland, OR': 'us',
    'Portland, Oregon, United States': 'us', 'Osaka, Japan': 'foreign', 'Sao Paulo, Brazil': 'foreign',
    'London, United Kingdom': 'foreign', '90210': 'us', '': 'unknown', 'Springfield, IL 62704': 'us',
    'Toronto, ON, Canada': 'foreign', 'Hong Kong': 'foreign', 'Indianapolis, IN': 'us',
    // regressions: V6.4's substring regex called these international (INDIA in INDIANA, CHINA, UK in YUKON)
    'Indianapolis, Indiana, United States': 'us', 'China Grove, North Carolina, United States': 'us',
    'Yukon, Oklahoma, United States': 'us', 'Moonachie, New Jersey, United States': 'us',
    'Piscataway, NJ, United States': 'us'
  };
  for (const [loc, expected] of Object.entries(cases)) assert.equal(classifyLocation(loc), expected, loc);
});

test('origin ZIP resolution reports confidence instead of silently guessing', async () => {
  const zip = await resolveOrigin('Beverly Hills, CA 90210', { http: fakeHttp });
  assert.deepEqual([zip.zip, zip.confidence, zip.source], ['90210', 1, 'listing_zip']);
  const none = await resolveOrigin('Portland, OR', { http: fakeHttp });
  assert.equal(none.source, 'fallback');
  assert.ok(none.confidence <= 0.2);
  const ok = await resolveOrigin('Eugene, OR', { http: async () => ({ places: [{ 'post code': '97401' }] }) });
  assert.deepEqual([ok.zip, ok.confidence, ok.state], ['97401', 0.8, 'OR']);
  assert.equal((await resolveOrigin('00000', { http: fakeHttp })).source, 'fallback');
});

test('destination ZIP: buyer > IP > fallback', async () => {
  const req = ip => ({ ip, headers: {}, socket: {} });
  assert.equal((await resolveDestination(req('198.51.100.1'), '94105', { http: fakeHttp })).source, 'buyer');
  assert.equal((await resolveDestination(req('10.0.0.5'), null, { http: fakeHttp })).source, 'fallback');
  const viaIp = await resolveDestination(req('198.51.100.77'), null, { http: async () => ({ status: 'success', zip: '60601' }) });
  assert.deepEqual([viaIp.zip, viaIp.source, viaIp.confidence], ['60601', 'ip', 0.5]);
});

test('LLM output is validated, not trusted', () => {
  const good = { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20, rigidity: 'rigid', fragility: 'low', confidence: 0.99 };
  const v = validateLLM(good);
  assert.equal(v.confidence, 0.7, 'confidence is capped below deterministic sources');
  assert.deepEqual(v.dims, [10, 8, 4]);
  assert.equal(validateLLM({ lengthIn: 40, widthIn: 3, heightIn: 3, weightOz: 0.2 }), null, '0.2 oz 40-inch bat rejected');
  assert.equal(validateLLM({ lengthIn: 0, widthIn: 3, heightIn: 3, weightOz: 5 }), null);
  assert.equal(validateLLM({ lengthIn: 'abc', widthIn: 3, heightIn: 3, weightOz: 5 }), null);
  assert.equal(validateLLM({ ...good, fragility: 'extreme' }).fragility, 'med');
  assert.equal(validateLLM(null), null);
});

test('profile ladder: listing dims > rule > LLM(cached) > default', async () => {
  const listing = await profileFor('Rawlings Baseball Bat', { scrapedDimensions: { length: 34, width: 3, height: 3 } });
  assert.equal(listing.source, 'listing_dimensions');

  const rule = await profileFor('Rawlings Baseball Bat');
  assert.equal(rule.source, 'category_rule:baseball_bat');

  const def = await profileFor('Mystery Gadget 9000');
  assert.equal(def.source, 'default');
  assert.ok(def.confidence <= 0.2);

  const profiles = new FakeDb();
  let calls = 0;
  const llm = async () => { calls++; return { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20, rigidity: 'rigid', fragility: 'low', confidence: 0.6 }; };
  const first = await buildItemProfile({ title: 'Mystery Gadget 9000' }, { profiles, llm });
  const second = await buildItemProfile({ title: 'mystery   gadget 9000!!' }, { profiles, llm });
  assert.equal(first.source, 'llm');
  assert.equal(second.source, 'llm_cache');
  assert.equal(calls, 1, 'same product never asks the LLM twice');
  assert.deepEqual(first.dims, second.dims);

  const garbage = await buildItemProfile({ title: 'Other Thing' }, { profiles: new FakeDb(), llm: async () => ({ lengthIn: 40, widthIn: 3, heightIn: 3, weightOz: 0.1 }) });
  assert.equal(garbage.source, 'default');

  const withWeight = await profileFor('Mystery Gadget 9000', { weight: '33' });
  assert.equal(withWeight.weightOz, 33);
  assert.equal(withWeight.weightSource, 'listing');
});

test('multi-piece items ship their longest piece', async () => {
  const rod = await profileFor('Shimano Fishing Rod 7ft Spinning Rod');
  assert.equal(rod.dims[0], 42);
});

test('corrections: own correction applies immediately; strangers need consensus', async () => {
  const corrections = new FakeDb();
  const title = 'Rawlings Baseball Bat';
  await saveCorrection(corrections, { title, userId: 'alice', dims: [36, 4, 4], weightOz: 28 });
  const alice = await buildItemProfile({ title, userId: 'alice' }, { corrections });
  assert.equal(alice.source, 'user_correction');
  assert.deepEqual(alice.dims, [36, 4, 4]);
  const bob = await buildItemProfile({ title, userId: 'bob' }, { corrections });
  assert.equal(bob.source, 'category_rule:baseball_bat', 'one stranger is not consensus');
  await saveCorrection(corrections, { title, userId: 'carol', dims: [36, 4, 4], weightOz: 30 });
  const dave = await buildItemProfile({ title, userId: 'dave' }, { corrections });
  assert.equal(dave.source, 'user_correction');
  assert.equal(dave.weightOz, 29);
  await assert.rejects(saveCorrection(corrections, { title, userId: 'x', dims: [0, 1, 1] }), { code: 'INVALID' });
});

test('fit: every archetype lands in a physically sensible package', async () => {
  const shirt = await profileFor('Mens Dress Shirt');
  assert.ok(findFitting(shirt, 1).some(c => c.kind === 'flexible'), 'a shirt can go in a mailer');
  assert.ok(findFitting(shirt, 3).some(c => c.kind === 'flexible'), 'three shirts can still go in a mailer');
  assert.ok(findFitting(shirt, 3).every(c => c.kind !== 'flexible' || c.h <= 6), 'mailer thickness stays within its limit');

  const racket = await profileFor('Wilson Tennis Racket');
  const racketBox = findFitting(racket, 1)[0];
  assert.equal(racketBox.id, 'flat_30x13x4');
  assert.ok(racketBox.volume < 1728, 'stays under the 1 cu ft dimensional-weight line');

  const club = await profileFor('Callaway Golf Club Driver');
  assert.equal(findFitting(club, 1)[0].id, 'tube_48');

  const custom = buildCustom(club, 2);
  assert.equal(custom.isCustom, true);
  assert.ok(custom.l >= 45 && custom.volume > 0);
  const stockFits = findFitting(club, 2);
  assert.ok(stockFits.every(c => c.volume > custom.volume * 1.25), 'any stock fit for two clubs wastes a lot of space (end to end in a 96 inch tube)');

  const book = await profileFor('Hardcover Book First Edition');
  assert.ok(findFitting(book, 1).some(c => c.kind === 'flexible'), 'flat rigid goods may use padded mailers');
  const phone = await profileFor('Apple iPhone 13 128GB');
  assert.ok(findFitting(phone, 1).every(c => c.kind === 'rigid'), 'fragile electronics never go in mailers');
  const shoes = await profileFor('Nike Air Max Mens Shoes');
  assert.ok(findFitting(shoes, 1).every(c => c.kind === 'rigid'));
});

test('weight and size limits', async () => {
  const heavy = { dims: [8, 6, 5], weightOz: 320, rigidity: 'rigid', fragility: 'low', compression: 1, mailerOk: false };
  const set = pickRateShopSet(findFitting(heavy, 1));
  assert.ok(set.some(c => c.template), 'flat-rate boxes that fit are always quoted');
  const huge = { dims: [100, 6, 6], weightOz: 40, rigidity: 'rigid', fragility: 'med', compression: 1 };
  assert.deepEqual(findFitting(huge, 1), []);
  assert.ok(packageWarnings(buildCustom(huge, 1)).includes('custom_box_required'));
});

test('rate shopping lets the carrier pick: sub-cubic-foot box beats the roomier one', async () => {
  const racket = await profileFor('Wilson Tennis Racket', { weight: 12 });
  const shippo = makeFakeShippo();
  const r = await compileResult({
    profile: racket, qty: 1, pageShippingCost: 21.55, shippo, rateCache: new TTLCache(),
    from: { zip: '97401', confidence: 1 }, to: { zip: '94105', confidence: 1 }, geoConfidence: 1
  });
  assert.equal(r.boxModel, 'Flat Equipment Box 30x13x4');
  assert.equal(r.rateSource, 'shippo');
  const rate = parseFloat(r.liveRate.slice(1));
  const stockAlternatives = r.alternatives.filter(a => !/Custom/.test(a.boxModel));
  assert.ok(stockAlternatives.length > 0);
  assert.ok(stockAlternatives.every(a => parseFloat(a.liveRate.slice(1)) > rate), 'bigger stock boxes cost more at the carrier');
  assert.match(r.buttonTextBuyer, new RegExp(`Saved \\$${(21.55 - rate).toFixed(2).replace('.', '\\.')}`));
  assert.ok(r.explain.quoted.length > 1, 'the carrier was asked about several boxes, not just the smallest');
});

test('flat-rate box wins on heavy dense items when the carrier says so', async () => {
  const brick = { dims: [8, 6, 5], weightOz: 320, rigidity: 'rigid', fragility: 'low', compression: 1, mailerOk: false, confidence: 0.85, source: 'listing_dimensions' };
  const r = await compileResult({
    profile: brick, qty: 1, pageShippingCost: 40, shippo: makeFakeShippo(), rateCache: new TTLCache(),
    from: { zip: '97401' }, to: { zip: '10001' }
  });
  assert.match(r.carrier, /Flat Rate/);
  assert.match(r.boxModel, /Flat Rate Box/);
});

test('no made-up rates: Shippo failure is reported honestly', async () => {
  const profile = await profileFor('Mens Dress Shirt');
  const r = await compileResult({
    profile, qty: 1, pageShippingCost: 21.55, shippo: makeFakeShippo({ fail: true }), rateCache: new TTLCache(),
    from: { zip: '97401' }, to: { zip: '94105' }
  });
  assert.equal(r.liveRate, 'Unavailable');
  assert.equal(r.carrier, null);
  assert.equal(r.rateSource, 'unavailable');
  assert.equal(r.confidence.score, 0);
  assert.equal(r.savings, null);
  assert.doesNotMatch(r.buttonTextBuyer, /Saved|Optimized/);

  const noClient = await compileResult({ profile, qty: 1, shippo: null, from: { zip: '97401' }, to: { zip: '94105' } });
  assert.equal(noClient.rateSource, 'unavailable');
});

test('low-confidence inputs never claim firm savings; unknown page cost never invents a baseline', async () => {
  const profile = await profileFor('Wilson Tennis Racket');
  const base = { profile, qty: 1, shippo: makeFakeShippo(), from: { zip: '97401' }, to: { zip: '94105' } };
  const low = await compileResult({ ...base, pageShippingCost: 21.55, geoConfidence: 0.2, rateCache: new TTLCache() });
  assert.equal(low.confidence.label, 'low');
  assert.match(low.buttonTextBuyer, /^Est\. savings up to/);
  const unknown = await compileResult({ ...base, pageShippingCost: null, rateCache: new TTLCache() });
  assert.equal(unknown.savings, null);
  assert.match(unknown.buttonTextBuyer, /^Alternative Rate: \$/);
});

test('rate cache: identical lookups do not hit Shippo twice', async () => {
  const profile = await profileFor('Wilson Tennis Racket', { weight: 12 });
  const shippo = makeFakeShippo();
  const cache = new TTLCache();
  const args = { profile, qty: 1, shippo, rateCache: cache, from: { zip: '97401' }, to: { zip: '94105' } };
  await compileResult(args);
  const first = shippo.calls.length;
  assert.ok(first > 0);
  await compileResult(args);
  assert.equal(shippo.calls.length, first);
});

test('rate helpers', () => {
  assert.equal(weightBucketOz(0.2), 1);
  assert.equal(weightBucketOz(15.1), 16);
  assert.equal(weightBucketOz(16.1), 32);
  assert.equal(weightBucketOz(33), 48);
  const best = pickBestRate([
    { amount: '0', provider: 'X', servicelevel: { name: 'Free?' } },
    { amount: 'abc', provider: 'Y', servicelevel: { name: 'Junk' } },
    { rate: '9.10', provider: 'USPS', servicelevel: { name: 'Priority' } },
    { amount: '6.40', provider: 'UPS', servicelevel: { name: 'Ground' } }
  ]);
  assert.equal(best.carrier, 'UPS Ground');
  assert.equal(best.amount, 6.4);
  assert.equal(pickBestRate([]), null);
});

test('weight parsing: units understood, unknown stays unknown (never a phantom 16 oz)', () => {
  const { parseWeightOz } = require('../lib/itemProfile');
  assert.equal(parseWeightOz('1 lb 8 oz'), 24);
  assert.equal(parseWeightOz('2.5 lbs'), 40);
  assert.equal(parseWeightOz('6 pounds'), 96);
  assert.ok(Math.abs(parseWeightOz('1.5 kg') - 52.911) < 0.01);
  assert.ok(Math.abs(parseWeightOz('450 g') - 15.87) < 0.01);
  assert.equal(parseWeightOz('12 oz'), 12);
  assert.equal(parseWeightOz(48), 48);
  assert.equal(parseWeightOz('48'), 48);
  for (const unknown of [null, undefined, '', 'n/a', 0, -3, 'heavy', 9999]) {
    assert.equal(parseWeightOz(unknown), null, String(unknown));
  }
});

test('pack counts in titles become physical units', () => {
  const { parsePackCount } = require('../lib/itemProfile');
  const cases = {
    'Supreme Hanes Crew Socks (4 Pack) Black': 4, 'True Classic Tee - 2 Pack': 2, 'Lot of 6 T-Shirts': 6,
    'Set of 3 Mugs': 3, 'Hanes 5-Pack Tees': 5, '2 Pair Wool Socks': 2,
    'Cast Iron Pan 10.5"': 1, 'Backpack Large': 1, '1000 Piece Puzzle': 1, 'Nike Air Force 1 Size 11': 1
  };
  for (const [title, n] of Object.entries(cases)) assert.equal(parsePackCount(title), n, title);
});

test('soft goods scale with quantity by tiling and layering, not by multiplying a box', async () => {
  const tee = await profileFor("Hanes Men's Cotton Pocket T-Shirt");
  assert.equal(tee.source, 'category_rule:tshirts');
  const ladder = {};
  for (const qty of [1, 2, 3, 6, 7, 12]) {
    const r = await compileResult({
      profile: tee, qty, pageShippingCost: 0, shippo: makeFakeShippo(), rateCache: new TTLCache(),
      from: { zip: '27045' }, to: { zip: '94556' }
    });
    ladder[qty] = r;
    assert.match(r.boxModel, /Mailer/, `qty ${qty} stays in a mailer: got ${r.boxModel}`);
    assert.ok(!/XL|Custom|Freight|Heavy/.test(r.boxModel), `qty ${qty}: ${r.boxModel}`);
    assert.equal(r.explain.units, qty);
    assert.equal(r.explain.itemWeightOz, 6 * qty, 'weight is counted once');
  }
  const vol = r => r.dimensions.split(' x ').slice(0, 3).reduce((a, s) => a * parseFloat(s), 1);
  assert.ok(vol(ladder[3]) < 3 * vol(ladder[1]) + 1, 'three tees do not need three times the package');
  assert.ok(vol(ladder[7]) <= 1600, `7 tees: ${ladder[7].dimensions}`);
});

test('multi-pack listings multiply units once; listing weight is per listing', async () => {
  const socks = await profileFor('Supreme Hanes Crew Socks (4 Pack) Black Size OS (Shoe Size 6-12)', {
    categoryPath: "Clothing, Shoes & Accessories > Men > Men's Shoes > Athletic Shoes", weight: 12
  });
  assert.equal(socks.source, 'category_rule:socks_underwear', 'sock title beats the Shoes in the category path');
  assert.equal(socks.unitsPerListing, 4);
  assert.equal(socks.weightOz, 3, '12 oz listing / 4 units');
  const r = await compileResult({
    profile: socks, qty: 2, pageShippingCost: 15, shippo: makeFakeShippo(), rateCache: new TTLCache(),
    from: { zip: '80538' }, to: { zip: '94556' }
  });
  assert.equal(r.explain.units, 8);
  assert.equal(r.explain.itemWeightOz, 24);
  assert.match(r.boxModel, /Mailer/);
});

test('soft goods fold: a thick stack can use a smaller footprint', async () => {
  const { unitShapes } = require('../lib/packaging');
  const tee = await profileFor("Hanes Men's Cotton Pocket T-Shirt");
  const shapes = unitShapes(tee);
  assert.ok(shapes.length > 1);
  assert.ok(shapes.some(s => Math.min(...s.slice(0, 2)) < 8), 'a folded variant has a smaller footprint');
  const rigid = await profileFor('Wilson Tennis Racket');
  assert.equal(unitShapes(rigid).length, 1, 'rigid goods have exactly one shape');
});

test('odd shapes: a snug custom box beats an oversized stock box only when the carrier price justifies it', async () => {
  const club = await profileFor('Callaway Golf Club Driver', { weight: 14 });
  const base = { pageShippingCost: 30, shippo: makeFakeShippo(), from: { zip: '32030' }, to: { zip: '94556' } };
  const one = await compileResult({ ...base, profile: club, qty: 1, rateCache: new TTLCache() });
  assert.equal(one.boxModel, 'Tube Box 48x6x6', 'one club: stock tube, no custom box');
  const two = await compileResult({ ...base, profile: club, qty: 2, rateCache: new TTLCache() });
  assert.match(two.boxModel, /Custom Box/, 'two clubs: stock options are all oversized, custom wins on real rate');
  assert.ok(two.warnings.includes('custom_box_required'));

  const racket = await profileFor('Wilson Tennis Racket', { weight: 12 });
  const r = await compileResult({ ...base, profile: racket, qty: 1, rateCache: new TTLCache() });
  assert.equal(r.boxModel, 'Flat Equipment Box 30x13x4', 'a custom box that saves nothing at the carrier is not recommended');
});

test('legacy profiles.db entries (V6.x schema) are ignored, not merged into defaults', async () => {
  const profiles = new FakeDb();
  await profiles.insert({ key: 'mystery gadget 9000', data: { packagingType: 'standard', baseLength: 46, baseWidth: 6, baseHeight: 6, baseWeightOunces: 16 } });
  let calls = 0;
  const llm = async () => { calls++; return { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20, rigidity: 'rigid', fragility: 'low' }; };
  const p = await buildItemProfile({ title: 'Mystery Gadget 9000' }, { profiles, llm });
  assert.equal(calls, 1);
  assert.equal(p.source, 'llm');
  assert.deepEqual(p.dims, [10, 8, 4]);
  const again = await buildItemProfile({ title: 'Mystery Gadget 9000' }, { profiles, llm });
  assert.equal(again.source, 'llm_cache', 'the new entry replaced the legacy one');
  assert.equal(calls, 1);
});
