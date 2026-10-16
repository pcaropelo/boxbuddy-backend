// ==========================================================================
// BOXSPIN BACKEND (V7) - thin wiring only.
// Business logic lives in lib/, data (categories, packages) lives in data/.
// ==========================================================================
if (typeof window === 'undefined') global.window = global; // legacy polyfill kept from V6; remove if nothing needs it

require('dotenv').config();
const path = require('path');
const { createHandlers } = require('./lib/handlers');
const { makeLLM } = require('./lib/llm');

function buildApp(h) {
  const express = require('express');
  const cors = require('cors');
  const app = express();
  app.set('trust proxy', true);
  app.use(cors());

  // Stripe needs the RAW body to verify its signature, so this route is registered BEFORE express.json().
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    console.error('Unhandled route error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal Server Fault' });
  });
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), wrap(h.stripeWebhook));

  app.use(express.json({ limit: '100kb' }));
  app.post('/api/optimize', wrap(h.optimize));
  app.post('/api/correct', wrap(h.correct));
  app.get('/api/credits', wrap(h.getCredits));
  app.post('/api/create-checkout-session', wrap(h.createCheckoutSession));
  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}

async function main() {
  const Datastore = require('nedb-promises');
  const dir = process.env.DATA_DIR || '.';
  const open = f => Datastore.create({ filename: path.join(dir, f), autoload: true });
  const db = {
    users: open('users.db'), payments: open('payments.db'), profiles: open('profiles.db'),
    corrections: open('corrections.db'), decisions: open('decisions.db')
  };
  await db.users.ensureIndex({ fieldName: 'userId', unique: true });
  await db.payments.ensureIndex({ fieldName: 'sessionId', unique: true });
  await db.profiles.ensureIndex({ fieldName: 'key', unique: true });

  const { Shippo } = require('shippo');
  const { OpenAI } = require('openai');
  const shippo = process.env.SHIPPO_API_KEY
    ? new Shippo({ apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}` })
    : null;
  const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

  if (!shippo) console.warn('SHIPPO_API_KEY not set: responses will say "Rate unavailable".');
  if (shippo && /^shippo_test_/.test(process.env.SHIPPO_API_KEY)) {
    console.warn('Using a Shippo TEST key: test rates are not real carrier prices. Use your live key for rate shopping (fetching rates does not buy labels).');
  }

  const handlers = createHandlers({
    db, shippo, stripe,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    llm: makeLLM({ openai, serperKey: process.env.SERPER_API_KEY })
  });

  const PORT = process.env.PORT || 3000;
  buildApp(handlers).listen(PORT, () => console.log(`BoxSpin backend online on port ${PORT}`));
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
}

module.exports = { buildApp, main };
