// Credit accounting. Works against any nedb-style collection
// (findOne / count / insert / update / remove).
const GUEST = 'anonymous_user_guest';
const ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;

// Missing id -> shared guest pool (legacy behavior). Malformed id -> null (reject).
function validateUserId(raw) {
  if (raw == null || raw === '') return GUEST;
  return ID_PATTERN.test(String(raw)) ? String(raw) : null;
}

async function getOrCreateUser(users, userId, ip, { freeCredits = 50, maxNewUsersPerIpPerDay = 5 } = {}) {
  const existing = await users.findOne({ userId });
  if (existing) return existing;
  if (userId !== GUEST && ip) {
    // Mitigation only: client-supplied ids are farmable, so cap fresh signups per IP.
    const recent = await users.count({ signupIp: ip, createdAt: { $gt: Date.now() - 24 * 3600e3 } });
    if (recent >= maxNewUsersPerIpPerDay) throw Object.assign(new Error('signup limit'), { code: 'SIGNUP_LIMIT' });
  }
  try {
    return await users.insert({ userId, credits: freeCredits, signupIp: ip || null, createdAt: Date.now() });
  } catch (err) {
    const again = await users.findOne({ userId }); // lost a creation race
    if (again) return again;
    throw err;
  }
}

// Atomic: only decrements when credits > 0. Returns true if a credit was taken.
async function reserveCredit(users, userId) {
  const n = await users.update({ userId, credits: { $gt: 0 } }, { $inc: { credits: -1 } });
  return Number(n) > 0;
}
const refundCredit = (users, userId) => users.update({ userId }, { $inc: { credits: 1 } });
const addCredits = (users, userId, amount) => users.update({ userId }, { $inc: { credits: amount } }, { upsert: true });
async function balance(users, userId) {
  const u = await users.findOne({ userId });
  return u ? u.credits : 0;
}

module.exports = { GUEST, validateUserId, getOrCreateUser, reserveCredit, refundCredit, addCredits, balance };
