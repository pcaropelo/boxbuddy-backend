// Test doubles. FakeDb mimics the small slice of the nedb-promises API the app uses.
// NOTE: this checks OUR logic; it is not proof of real nedb behavior.
class FakeDb {
  constructor({ unique = [] } = {}) { this.docs = []; this.unique = unique; this.n = 0; }
  _match(doc, q) {
    return Object.entries(q).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('$gt' in v) return doc[k] > v.$gt;
        if ('$gte' in v) return doc[k] >= v.$gte;
      }
      return doc[k] === v;
    });
  }
  async findOne(q) { return this.docs.find(d => this._match(d, q)) || null; }
  async find(q) { return this.docs.filter(d => this._match(d, q)); }
  async count(q) { return this.docs.filter(d => this._match(d, q)).length; }
  async insert(doc) {
    for (const f of this.unique) if (this.docs.some(d => d[f] === doc[f])) throw new Error(`unique violated: ${f}`);
    const d = { _id: `id${++this.n}`, ...doc };
    this.docs.push(d);
    return d;
  }
  async update(q, upd, opts = {}) {
    const hit = this.docs.find(d => this._match(d, q));
    const hasOps = Object.keys(upd).some(k => k.startsWith('$'));
    if (!hit) {
      if (!opts.upsert) return 0;
      const base = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v !== 'object'));
      const d = { _id: `id${++this.n}`, ...base };
      this.docs.push(d);
      return this._apply(d, upd, hasOps);
    }
    return this._apply(hit, upd, hasOps);
  }
  _apply(d, upd, hasOps) {
    if (!hasOps) { const id = d._id; for (const k of Object.keys(d)) delete d[k]; Object.assign(d, upd, { _id: id }); return 1; }
    for (const [k, v] of Object.entries(upd.$inc || {})) d[k] = (d[k] || 0) + v;
    Object.assign(d, upd.$set || {});
    return 1;
  }
  async remove(q) { const before = this.docs.length; this.docs = this.docs.filter(d => !this._match(d, q)); return before - this.docs.length; }
}

function makeDb() {
  return {
    users: new FakeDb({ unique: ['userId'] }), payments: new FakeDb({ unique: ['sessionId'] }),
    profiles: new FakeDb(), corrections: new FakeDb(), decisions: new FakeDb()
  };
}

// Fake Shippo that prices like a real carrier: weight bands + dimensional weight
// above 1 cu ft; flat-rate templates ignore size/weight. Records every request.
function makeFakeShippo({ fail = false } = {}) {
  const calls = [];
  const FLAT = { USPS_SmallFlatRateBox: 10.4, USPS_MediumFlatRateBox1: 18.2, USPS_LargeFlatRateBox: 24.9 };
  return {
    calls,
    shipments: {
      async create(req) {
        calls.push(req);
        if (fail) throw new Error('shippo down');
        const p = req.parcels[0];
        if (p.template) return { rates: [{ amount: String(FLAT[p.template]), provider: 'USPS', servicelevel: { name: 'Priority Mail Flat Rate' } }] };
        const vol = p.length * p.width * p.height;
        const lb = Number(p.weight) / 16;
        const billable = Math.max(lb, vol > 1728 ? vol / 166 : 0);
        const amount = 4.1 + 0.9 * Math.ceil(billable) + (billable > 1 ? 2.5 : 0);
        return { rates: [{ amount: amount.toFixed(2), provider: 'USPS', servicelevel: { name: 'Ground Advantage' } }] };
      }
    }
  };
}

function makeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; }
  };
}
const makeReq = (body = {}, extra = {}) => ({ body, headers: {}, query: {}, ip: '203.0.113.9', socket: {}, ...extra });
const fakeHttp = async () => null; // geo lookups all "fail" -> deterministic fallbacks

module.exports = { FakeDb, makeDb, makeFakeShippo, makeRes, makeReq, fakeHttp };
