const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers } = require('../lib/handlers');
const { makeDb, makeFakeShippo, makeRes, makeReq, fakeHttp } = require('./helpers');

const quiet = { error() {}, warn() {} };
function setup(overrides = {}) {
  const db = overrides.db || makeDb();
  const shippo = overrides.shippo === undefined ? makeFakeShippo() : overrides.shippo;
  const h = createHandlers({ db, shippo, http: fakeHttp, log: quiet, ...overrides.deps });
  return { db, shippo, h };
}
const call = async (fn, req) => { const res = makeRes(); await fn(req, res); return res; };
const shirtBody = (extra = {}) => ({
  title: 'Mens Dress Shirt Large', browserExtensionId: 'user_alice', originLocation: 'Portland, OR 97201',
  destinationZip: '94105', quantity: 1, weight: 8, itemSpecifics: { listedShippingCost: 9.99 }, ...extra
});

test('optimize: happy path charges exactly one credit', async () => {
  const { h } = setup();
  const res = await call(h.optimize, makeReq(shirtBody()));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.remainingCredits, 49);
  assert.equal(res.body.rateSource, 'shippo');
  assert.match(res.body.boxModel, /Mailer/);
  assert.ok(res.body.liveRate.startsWith('$'));
  assert.deepEqual(res.body.zipSources, { origin: 'listing_zip', destination: 'buyer' });
});

test('optimize: input validation', async () => {
  const { h } = setup();
  assert.equal((await call(h.optimize, makeReq({}))).statusCode, 400);
  assert.equal((await call(h.optimize, makeReq(shirtBody({ browserExtensionId: 'bad id!' })))).statusCode, 400);
  const guest = await call(h.optimize, makeReq(shirtBody({ browserExtensionId: undefined })));
  assert.equal(guest.statusCode, 200, 'missing id falls back to the legacy guest pool');
});

test('optimize: international origin is answered free of charge', async () => {
  const { h, shippo } = setup();
  const res = await call(h.optimize, makeReq(shirtBody({ originLocation: 'Osaka, Japan' })));
  assert.equal(res.body.boxModel, 'International Shipping Container');
  assert.equal(res.body.remainingCredits, 50);
  assert.equal(shippo.calls.length, 0);
});

test('optimize: out of credits -> requiresPayment', async () => {
  const { h, db } = setup();
  await db.users.insert({ userId: 'user_broke', credits: 0 });
  const res = await call(h.optimize, makeReq(shirtBody({ browserExtensionId: 'user_broke' })));
  assert.deepEqual(res.body, { success: false, requiresPayment: true });
});

test('credits are decremented atomically under concurrency', async () => {
  const { h, db } = setup();
  await db.users.insert({ userId: 'user_race', credits: 3 });
  const results = await Promise.all(Array.from({ length: 10 }, () => call(h.optimize, makeReq(shirtBody({ browserExtensionId: 'user_race' })))));
  assert.equal(results.filter(r => r.body.success).length, 3);
  assert.equal(results.filter(r => r.body.requiresPayment).length, 7);
  assert.equal((await db.users.findOne({ userId: 'user_race' })).credits, 0);
});

test('a pipeline fault refunds the credit', async () => {
  const { h, db } = setup();
  db.corrections.find = async () => { throw new Error('disk on fire'); };
  const res = await call(h.optimize, makeReq(shirtBody({ browserExtensionId: 'user_refund' })));
  assert.equal(res.statusCode, 500);
  assert.equal((await db.users.findOne({ userId: 'user_refund' })).credits, 50);
});

test('free-credit farming is rate limited per IP', async () => {
  const { h } = setup({ deps: { config: { maxNewUsersPerIpPerDay: 2 } } });
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await call(h.optimize, makeReq(shirtBody({ browserExtensionId: `farm_${i}` }), { ip: '192.0.2.50' }))).statusCode);
  }
  assert.deepEqual(statuses, [200, 200, 429, 429]);
});

test('unknown listing shipping cost is not replaced with an invented baseline', async () => {
  const { h } = setup();
  const res = await call(h.optimize, makeReq(shirtBody({ itemSpecifics: undefined })));
  assert.equal(res.body.savings, null);
  assert.match(res.body.buttonTextBuyer, /^Alternative Rate/);
});

test('corrections feed back into optimize', async () => {
  const { h } = setup();
  const bad = await call(h.correct, makeReq({ browserExtensionId: 'user_alice', title: 'Mens Dress Shirt Large', actual: { dims: [0, 1, 1] } }));
  assert.equal(bad.statusCode, 400);
  const ok = await call(h.correct, makeReq({
    browserExtensionId: 'user_alice', title: 'Mens Dress Shirt Large',
    actual: { dims: [14, 11, 3], weightOz: 12, rigidity: 'flexible' }
  }));
  assert.equal(ok.body.success, true);
  const res = await call(h.optimize, makeReq(shirtBody({ weight: undefined })));
  assert.equal(res.body.profileSource, 'user_correction');
});

test('credits endpoint', async () => {
  const { h } = setup();
  const res = await call(h.getCredits, makeReq({}, { query: { browserExtensionId: 'user_new' } }));
  assert.equal(res.body.credits, 50);
  assert.equal((await call(h.getCredits, makeReq({}, { query: { browserExtensionId: 'x' } }))).statusCode, 400);
});

test('checkout session carries server-defined pricing and metadata', async () => {
  let captured;
  const stripe = { checkout: { sessions: { create: async p => { captured = p; return { url: 'https://stripe.test/c' }; } } } };
  const { h } = setup({ deps: { stripe } });
  const res = await call(h.createCheckoutSession, makeReq({ browserExtensionId: 'user_alice', packageType: '50' }));
  assert.equal(res.body.url, 'https://stripe.test/c');
  assert.equal(captured.line_items[0].price_data.unit_amount, 499);
  assert.deepEqual(captured.metadata, { browserExtensionId: 'user_alice', creditsToAdd: '50' });
  await call(h.createCheckoutSession, makeReq({ browserExtensionId: 'user_alice', packageType: 'bogus' }));
  assert.equal(captured.line_items[0].price_data.unit_amount, 99, 'unknown package falls back to the smallest');
  const noStripe = setup();
  assert.equal((await call(noStripe.h.createCheckoutSession, makeReq({ browserExtensionId: 'user_alice' }))).statusCode, 503);
});

test('stripe webhook: verifies signature, grants credits once, ignores unpaid', async () => {
  const session = (id, paid = 'paid') => ({
    type: 'checkout.session.completed',
    data: { object: { id, payment_status: paid, amount_total: 499, metadata: { browserExtensionId: 'user_alice', creditsToAdd: '50' } } }
  });
  let next = session('cs_1');
  const stripe = { webhooks: { constructEvent: (body, sig) => { if (sig !== 'good') throw new Error('bad sig'); return next; } } };
  const { h, db } = setup({ deps: { stripe, stripeWebhookSecret: 'whsec_x' } });
  await db.users.insert({ userId: 'user_alice', credits: 4 });
  const hit = () => call(h.stripeWebhook, makeReq(Buffer.from('{}'), { headers: { 'stripe-signature': 'good' } }));
  const balance = async () => (await db.users.findOne({ userId: 'user_alice' })).credits;

  assert.equal((await call(h.stripeWebhook, makeReq(Buffer.from('{}'), { headers: { 'stripe-signature': 'forged' } }))).statusCode, 400);
  assert.equal(await balance(), 4);

  await hit();
  assert.equal(await balance(), 54);
  const dup = await hit();
  assert.equal(dup.body.duplicate, true);
  assert.equal(await balance(), 54, 'Stripe retries never double-credit');

  next = session('cs_2', 'unpaid');
  await hit();
  assert.equal(await balance(), 54);

  const unconfigured = setup({ deps: { stripe } });
  assert.equal((await call(unconfigured.h.stripeWebhook, makeReq(Buffer.from('{}')))).statusCode, 503);
});

test('webhook failure after recording rolls back so Stripe can retry', async () => {
  const stripe = { webhooks: { constructEvent: () => ({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_9', payment_status: 'paid', metadata: { browserExtensionId: 'user_alice', creditsToAdd: '5' } } }
  }) } };
  const { h, db } = setup({ deps: { stripe, stripeWebhookSecret: 'whsec_x' } });
  db.users.update = async () => { throw new Error('write failed'); };
  const res = await call(h.stripeWebhook, makeReq(Buffer.from('{}'), { headers: { 'stripe-signature': 'x' } }));
  assert.equal(res.statusCode, 500);
  assert.equal(await db.payments.findOne({ sessionId: 'cs_9' }), null);
});

test('weight is counted once: listing weight is per listing quantity, never multiplied twice (V6.4 bug)', async () => {
  const { h } = setup();
  // 3 tees, listing weight 6 oz each. The client must NOT pre-multiply; the server multiplies exactly once.
  const res = await call(h.optimize, makeReq(shirtBody({ title: "Hanes Men's Cotton Pocket T-Shirt", quantity: 3, weight: 6, itemSpecifics: { listedShippingCost: 0, isFreeShipping: true } })));
  assert.equal(res.body.explain.units, 3);
  assert.equal(res.body.explain.itemWeightOz, 18);
  assert.match(res.body.boxModel, /Mailer/);
  assert.ok(res.body.packageWeightOz < 25, `package weight ${res.body.packageWeightOz}`);
});

test('unknown weight stays unknown: the category estimate is used, not a phantom 16 oz', async () => {
  const { h } = setup();
  const res = await call(h.optimize, makeReq(shirtBody({ title: "Hanes Men's Cotton Pocket T-Shirt", weight: null })));
  assert.equal(res.body.explain.weightSource, 'estimated');
  assert.equal(res.body.explain.unitWeightOz, 6);
  const withUnit = await call(h.optimize, makeReq(shirtBody({ title: "Hanes Men's Cotton Pocket T-Shirt", weight: '1 lb 8 oz', browserExtensionId: 'user_bob' })));
  assert.equal(withUnit.body.explain.unitWeightOz, 24);
  assert.equal(withUnit.body.explain.weightSource, 'listing');
});

test('missing shipping cost is unknown, free shipping is zero, and neither invents savings', async () => {
  const { h } = setup();
  const unknown = await call(h.optimize, makeReq(shirtBody({ itemSpecifics: { listedShippingCost: null, isFreeShipping: false } })));
  assert.equal(unknown.body.savings, null);
  const free = await call(h.optimize, makeReq(shirtBody({ itemSpecifics: { listedShippingCost: 0, isFreeShipping: true }, browserExtensionId: 'user_carol' })));
  assert.equal(free.body.savings, null);
  const paid = await call(h.optimize, makeReq(shirtBody({ itemSpecifics: { listedShippingCost: 15 }, browserExtensionId: 'user_dave' })));
  assert.ok(paid.body.savings > 0);
});
