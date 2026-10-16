// Tiny in-memory TTL cache with a size cap (oldest entry evicted first).
class TTLCache {
  constructor({ ttlMs = 3600e3, max = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.map.delete(key); return undefined; }
    return e.value;
  }
  set(key, value) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
  }
}
module.exports = { TTLCache };
