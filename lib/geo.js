// Location handling: US/foreign classification, ZIP resolution, buyer ZIP from IP.
// Uses global fetch (Node 18+) with hard timeouts. Every resolver returns a
// confidence so the response can say "estimated" instead of silently guessing.
const { TTLCache } = require('./cache');

const HTTP_TIMEOUT_MS = 2500;
const FALLBACK_ORIGIN_ZIP = process.env.FALLBACK_ORIGIN_ZIP || '07030';
const FALLBACK_DEST_ZIP = process.env.FALLBACK_DEST_ZIP || '90210';

const STATE_NAME_TO_CODE = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID',
  ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
  'PUERTO RICO': 'PR'
};
const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));
const US_COUNTRY = new Set(['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA', 'AMERICA']);
const FOREIGN = new Set([
  'JAPAN', 'CHINA', 'UK', 'UNITED KINGDOM', 'GREAT BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES',
  'CANADA', 'GERMANY', 'AUSTRALIA', 'HONG KONG', 'TAIWAN', 'KOREA', 'SOUTH KOREA', 'FRANCE',
  'ITALY', 'SPAIN', 'MEXICO', 'INDIA', 'BRAZIL', 'ISRAEL', 'NETHERLANDS', 'SWEDEN', 'IRELAND',
  'NEW ZEALAND', 'SINGAPORE', 'THAILAND', 'VIETNAM', 'PHILIPPINES', 'MALAYSIA', 'INDONESIA',
  'POLAND', 'PORTUGAL', 'TURKEY', 'RUSSIA', 'UKRAINE', 'SWITZERLAND', 'AUSTRIA', 'BELGIUM',
  'DENMARK', 'NORWAY', 'FINLAND', 'GREECE', 'CZECH REPUBLIC', 'HUNGARY', 'ROMANIA',
  'SOUTH AFRICA', 'UNITED ARAB EMIRATES', 'LITHUANIA', 'LATVIA', 'ESTONIA', 'BULGARIA',
  'CROATIA', 'SLOVAKIA', 'SLOVENIA', 'ARGENTINA', 'CHILE', 'COLOMBIA', 'PERU', 'EGYPT',
  'PAKISTAN', 'BANGLADESH', 'NIGERIA', 'KENYA', 'SAUDI ARABIA', 'MACAU', 'CAMBODIA'
]);

function cleanLocation(str) {
  return String(str || '').toUpperCase().replace(/[^A-Z0-9, ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const stripZip = s => s.replace(/\b\d{5}(?:\s?\d{4})?\b/g, '').replace(/\s+/g, ' ').trim();

function toStateCode(raw) {
  const s = stripZip(cleanLocation(raw));
  if (!s) return null;
  if (STATE_CODES.has(s)) return s;
  if (STATE_NAME_TO_CODE[s]) return STATE_NAME_TO_CODE[s];
  const last = s.split(' ').pop();
  return STATE_CODES.has(last) ? last : null;
}

// 'us' | 'foreign' | 'unknown'. Whole-token matching only (no substring hits like IN-DIA).
function classifyLocation(str) {
  const s = cleanLocation(str);
  if (!s) return 'unknown';
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  const last = stripZip(parts[parts.length - 1] || '');
  if (US_COUNTRY.has(last) || STATE_CODES.has(last) || STATE_NAME_TO_CODE[last]) return 'us';
  if (FOREIGN.has(last)) return 'foreign';
  if (parts.some(p => FOREIGN.has(stripZip(p)))) return 'foreign';
  if (parts.some(p => US_COUNTRY.has(stripZip(p)))) return 'us';
  if (/\b\d{5}\b/.test(s)) return 'us';
  if (STATE_CODES.has(s.split(' ').pop())) return 'us';
  return 'unknown';
}
// Unknown locations proceed (the rate step will simply be lower confidence).
const isDomestic = str => classifyLocation(str) !== 'foreign';

async function defaultHttp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const zipInfoCache = new TTLCache({ ttlMs: 24 * 3600e3, max: 5000 });
const cityZipCache = new TTLCache({ ttlMs: 24 * 3600e3, max: 5000 });
const ipZipCache = new TTLCache({ ttlMs: 3600e3, max: 5000 });

async function lookupZip(zip, http = defaultHttp) {
  const hit = zipInfoCache.get(zip);
  if (hit !== undefined) return hit;
  const data = await http(`https://api.zippopotam.us/us/${zip}`);
  const p = data && data.places && data.places[0];
  const info = p ? { city: p['place name'], state: p['state abbreviation'] } : null;
  if (info) zipInfoCache.set(zip, info);
  return info;
}

async function lookupCityZip(city, state, http = defaultHttp) {
  const key = `${city.toLowerCase()}|${state}`;
  const hit = cityZipCache.get(key);
  if (hit !== undefined) return hit;
  const data = await http(`https://api.zippopotam.us/us/${state.toLowerCase()}/${encodeURIComponent(city)}`);
  const zip = data && data.places && data.places[0] && data.places[0]['post code'];
  if (zip) cityZipCache.set(key, zip);
  return zip || null;
}

const BAD_ZIP = /^(0{5}|0{4}1)$/;

async function resolveOrigin(locationStr, { http = defaultHttp } = {}) {
  const fallback = { zip: FALLBACK_ORIGIN_ZIP, city: null, state: null, confidence: 0.2, source: 'fallback' };
  const raw = String(locationStr || '').trim();
  if (!raw || /^(n\/a|unknown|none)$/i.test(raw)) return fallback;

  const zipMatch = raw.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zipMatch && !BAD_ZIP.test(zipMatch[1])) {
    const info = await lookupZip(zipMatch[1], http);
    return { zip: zipMatch[1], city: info && info.city, state: info && info.state, confidence: 1, source: 'listing_zip' };
  }

  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const state = toStateCode(parts[1]);
    if (state) {
      const zip = await lookupCityZip(parts[0], state, http);
      if (zip) return { zip, city: parts[0], state, confidence: 0.8, source: 'city_state' };
    }
  }
  return fallback;
}

function clientIp(req) {
  let ip = req.ip || (req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '';
  if (String(ip).includes(',')) ip = String(ip).split(',')[0].trim();
  return String(ip).replace(/^::ffff:/, '');
}
const isPrivateIp = ip => !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

async function resolveDestination(req, destinationZip, { http = defaultHttp } = {}) {
  const given = destinationZip && String(destinationZip).trim();
  if (given && /^\d{5}$/.test(given) && !BAD_ZIP.test(given)) {
    return { zip: given, confidence: 1, source: 'buyer' };
  }
  const ip = clientIp(req);
  if (!isPrivateIp(ip)) {
    let zip = ipZipCache.get(ip);
    if (zip === undefined) {
      const data = await http(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,zip`);
      zip = data && data.status === 'success' && /^\d{5}/.test(data.zip || '') ? data.zip.slice(0, 5) : null;
      if (zip) ipZipCache.set(ip, zip);
    }
    if (zip) return { zip, confidence: 0.5, source: 'ip' };
  }
  return { zip: FALLBACK_DEST_ZIP, confidence: 0.2, source: 'fallback' };
}

module.exports = { classifyLocation, isDomestic, toStateCode, resolveOrigin, resolveDestination, clientIp };
