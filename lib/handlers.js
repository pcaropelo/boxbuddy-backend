// Route handlers, written against injected dependencies so they run (and test)
// without Express, nedb, Shippo, Stripe or OpenAI being present.
const credits = require('./credits');
const { classifyLocation, resolveOrigin, resolveDestination, clientIp } = require('./geo');
const { buildItemProfile, saveCorrection, scrapedToDims, parseWeightOz } = require('./itemProfile');
const { compileResult } = require('./pipeline');
const { TTLCache } = require('./cache');
const { defaultLibrary } = require('./packaging');

const PACKS = {
  '5': { priceCents: 99, credits: 5 },
  '50': { priceCents: 499, credits: 50 },
  '100': { priceCents: 999, credits: 100 }
};

function createHandlers(deps) {
  const {
    db, shippo = null, stripe = null, stripeWebhookSecret = null, llm = null, http,
    library = defaultLibrary, rateCache = new TTLCache({ ttlMs: 6 * 3600e3, max: 3000 }),
    config = {}, log = console
  } = deps;
  const cfg = { freeCredits: 50, maxNewUsersPerIpPerDay: 5, ...config };
  const bad = (res, msg) => res.status(400).json({ success: false, error: msg });

  async function optimize(req, res) {
    const b = req.body || {};
    const title = typeof b.title === 'string' ? b.title.slice(0, 300) : '';
    const scraped = b.scrapedDimensions || null;
    if (!title && !scrapedToDims(scraped)) return bad(res, 'title or scrapedDimensions required');

    const userId = credits.validateUserId(b.browserExtensionId);
    if (!userId) return bad(res, 'invalid browserExtensionId');
    const qty = Math.min(50, Math.max(1, parseInt(b.quantity, 10) || 1));
    const ip = clientIp(req);

    let user;
    try {
      user = await credits.getOrCreateUser(db.users, userId, ip, cfg);
    } catch (err) {
      if (err.code === 'SIGNUP_LIMIT') return res.status(429).json({ success: false, error: 'Too many new accounts from this network. Try again later.' });
      throw err;
    }
    if (user.credits <= 0) return res.json({ success: false, requiresPayment: true });

    // International origins get no packaging work, so no credit is charged.
    if (classifyLocation(b.originLocation) === 'foreign') {
      return res.json({
        success: true, remainingCredits: user.credits,
        boxModel: 'International Shipping Container', dimensions: 'Carrier Package',
        liveRate: "Rates Vary by SpeedPAK / Int'l Carrier", carrier: 'eBay International Shipping',
        buttonTextBuyer: 'International Origin ✈️', buttonTextSeller: 'International Origin ✈️'
      });
    }

    if (!(await credits.reserveCredit(db.users, userId))) return res.json({ success: false, requiresPayment: true });

    try {
      const [from, to] = await Promise.all([
        resolveOrigin(b.originLocation, { http }),
        resolveDestination(req, b.destinationZip, { http })
      ]);

      const specifics = b.itemSpecifics || null;
      let pageShippingCost = null; // unknown stays unknown; we no longer invent a $21.55 baseline
      if (specifics) {
        const raw = specifics.listedShippingCost;
        const known = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(parseFloat(raw));
        if (specifics.isFreeShipping === true || (known && parseFloat(raw) === 0)) pageShippingCost = 0;
        else if (known) pageShippingCost = parseFloat(raw);
      }

      // Weight describes ONE sale (the listing), never "x quantity": the engine scales it by units itself.
      // Legacy builds that explicitly declare apiVersion 1 multiplied weight by quantity before sending; undo that.
      let weight = parseWeightOz(b.weight) ?? parseWeightOz(b.weightText);
      if (weight && b.apiVersion === 1 && qty > 1 && typeof b.weight === 'number') weight = weight / qty;

      const profile = await buildItemProfile(
        { title, categoryPath: b.categoryPath, scrapedDimensions: scraped, weight, userId, itemSpecifics: specifics },
        { corrections: db.corrections, profiles: db.profiles, llm }
      );

      const payload = await compileResult({
        profile, qty, pageShippingCost, from, to, shippo, rateCache,
        library, geoConfidence: Math.min(from.confidence, to.confidence),
        onError: err => log.warn && log.warn('Shippo quote failed:', err.message)
      });

      payload.remainingCredits = await credits.balance(db.users, userId);
      payload.zipSources = { origin: from.source, destination: to.source };

      if (db.decisions) {
        db.decisions.insert({
          ts: Date.now(), key: profile.key, qty, profileSource: profile.source, dims: profile.dims,
          weightOz: profile.weightOz, box: payload.boxModel, parcel: payload.dimensions,
          rate: payload.liveRate, carrier: payload.carrier, confidence: payload.confidence.score,
          pageShippingCost
        }).catch(() => {});
      }
      return res.json(payload);
    } catch (err) {
      await credits.refundCredit(db.users, userId).catch(() => {});
      log.error && log.error('Optimization pipeline fault:', err);
      return res.status(500).json({ success: false, error: 'Internal Server Fault' });
    }
  }

  async function getCredits(req, res) {
    const userId = credits.validateUserId(req.query && req.query.browserExtensionId);
    if (!userId) return bad(res, 'invalid browserExtensionId');
    try {
      const user = await credits.getOrCreateUser(db.users, userId, clientIp(req), cfg);
      return res.json({ credits: user.credits });
    } catch (err) {
      if (err.code === 'SIGNUP_LIMIT') return res.status(429).json({ error: 'Too many new accounts from this network.' });
      log.error && log.error('credits lookup failed:', err);
      return res.status(500).json({ error: 'Internal Server Fault' }); // never show a fake balance
    }
  }

  async function createCheckoutSession(req, res) {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured' });
    const userId = credits.validateUserId(req.body && req.body.browserExtensionId);
    if (!userId) return bad(res, 'invalid browserExtensionId');
    const pack = PACKS[String(req.body && req.body.packageType)] || PACKS['5'];
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `BoxSpin ${pack.credits} Optimization Credits` },
            unit_amount: pack.priceCents
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: 'https://ebay.com?boxspin_payment=success',
        cancel_url: 'https://ebay.com?boxspin_payment=cancel',
        client_reference_id: userId,
        metadata: { browserExtensionId: userId, creditsToAdd: String(pack.credits) }
      });
      return res.json({ url: session.url });
    } catch (err) {
      log.error && log.error('checkout failed:', err.message);
      return res.status(500).json({ error: 'Could not start checkout' });
    }
  }

  // Credits are granted ONLY here, after Stripe confirms payment. req.body must be the raw Buffer.
  async function stripeWebhook(req, res) {
    if (!stripe || !stripeWebhookSecret) return res.status(503).json({ error: 'Webhook not configured' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], stripeWebhookSecret);
    } catch {
      return res.status(400).send('Webhook signature verification failed');
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      if (s.payment_status !== 'paid') return res.json({ received: true });
      const userId = s.metadata && s.metadata.browserExtensionId;
      const amount = parseInt(s.metadata && s.metadata.creditsToAdd, 10);
      if (!userId || !(amount > 0)) {
        log.error && log.error('webhook session missing metadata:', s.id);
        return res.json({ received: true });
      }
      if (await db.payments.findOne({ sessionId: s.id })) return res.json({ received: true, duplicate: true });
      try {
        await db.payments.insert({ sessionId: s.id, userId, credits: amount, amountCents: s.amount_total, createdAt: Date.now() });
      } catch {
        return res.json({ received: true, duplicate: true }); // unique-index race
      }
      try {
        await credits.addCredits(db.users, userId, amount);
      } catch (err) {
        await db.payments.remove({ sessionId: s.id }).catch(() => {}); // let Stripe retry
        log.error && log.error('failed to add credits:', err);
        return res.status(500).json({ error: 'credit grant failed' });
      }
    }
    return res.json({ received: true });
  }

  // "Wrong size?" button: teaches the engine with data instead of code.
  async function correct(req, res) {
    const b = req.body || {};
    const userId = credits.validateUserId(b.browserExtensionId);
    if (!userId || typeof b.title !== 'string') return bad(res, 'browserExtensionId and title required');
    const actual = b.actual || {};
    try {
      await saveCorrection(db.corrections, {
        title: b.title, userId, dims: actual.dims, weightOz: actual.weightOz,
        rigidity: actual.rigidity, fragility: actual.fragility
      });
      return res.json({ success: true });
    } catch (err) {
      if (err.code === 'INVALID') return bad(res, 'actual.dims must be [l,w,h] inches (0.1-120), weightOz optional');
      throw err;
    }
  }

  return { optimize, getCredits, createCheckoutSession, stripeWebhook, correct, PACKS };
}

module.exports = { createHandlers, PACKS };
