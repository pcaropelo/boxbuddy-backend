// Packaging fit engine. Pure functions, no I/O.
//
// Packages are described by what they physically are (data/packages.json); volume,
// quantity limits and "types" are DERIVED, never hand-typed.
//
// The key physical idea for quantity: rigid goods STACK LINEARLY (n units = n x thickness),
// but soft goods squeeze, so n units are  T * (1 + stackFactor * (n - 1))  thick, and they can
// be laid side by side as well as stacked. Every package type is solved with the same
// arrangement search, so qty 1, 3 and 7 of a tee shirt follow one rule, not three special cases.
const defaultLibrary = require('../data/packages.json').packages;

const PAD = { low: 0.25, med: 0.5, high: 0.75 };      // inches of cushioning per side (rigid boxes)
const DUNNAGE_OZ = { low: 0, med: 2, high: 4 };       // filler weight added to rigid boxes
const EPS = 1e-9;
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

const sortDesc = a => [...a].sort((x, y) => y - x);
const volume = (l, w, h) => l * w * h;
const isSoft = item => item.rigidity === 'flexible';

function uniquePerms(d) {
  const seen = new Set();
  const out = [];
  for (const p of PERMS) {
    const t = [d[p[0]], d[p[1]], d[p[2]]];
    const k = t.join('x');
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

// Height of n identical units stacked on their thinnest axis.
function stackThickness(item, thickness, n) {
  if (!isSoft(item)) return thickness * n;
  return thickness * (1 + (item.stackFactor ?? 0.7) * (n - 1));
}

// The shapes ONE unit can take. Rigid goods have exactly one. Soft goods can also be folded in half
// along their long side (footprint halves, thickness doubles), which is how people really pack tees.
function unitShapes(item) {
  const [L, W, T] = sortDesc(item.dims);
  const shapes = [[L, W, T]];
  if (isSoft(item)) {
    { const f = sortDesc([L / 2, W]); shapes.push([f[0], f[1], T * 2]); } // fold once
  }
  return shapes;
}

// Every way to hold `units` items as an nx * ny footprint grid with nz layers.
//  - soft goods (and anything laid flat) lie on their thinnest axis, so only L/W rotate;
//  - rigid goods may sit on any face.
// `limit` ([x, y]) prunes grid counts that cannot fit the footprint.
function* arrangements(item, units, limit, { flat = false } = {}) {
  const lays = [];
  for (const [a, b, c] of unitShapes(item)) {
    if (isSoft(item) || flat) lays.push([a, b, c], [b, a, c]);
    else lays.push(...uniquePerms([a, b, c]));
  }
  for (const p of lays) {
    const maxX = limit ? Math.min(units, Math.floor(limit[0] / p[0] + EPS)) : units;
    for (let nx = 1; nx <= maxX; nx++) {
      const rows = Math.ceil(units / nx);
      const maxY = limit ? Math.min(rows, Math.floor(limit[1] / p[1] + EPS)) : rows;
      for (let ny = 1; ny <= maxY; ny++) {
        const nz = Math.ceil(units / (nx * ny));
        const z = isSoft(item) ? stackThickness(item, p[2], nz) : p[2] * nz;
        yield { perm: p, grid: [nx, ny, nz], size: [p[0] * nx, p[1] * ny, z] };
      }
    }
  }
}

function fitRigid(item, units, pkg) {
  const pad = PAD[item.fragility] ?? PAD.med;
  const inner = [pkg.l - 2 * pad, pkg.w - 2 * pad, pkg.h - 2 * pad];
  if (inner.some(v => v <= 0)) return null;
  // Soft goods are laid flat, but the box may be turned, so any box axis can be "up".
  const orientations = isSoft(item) ? uniquePerms(inner) : [inner];
  for (const box of orientations) {
    for (const a of arrangements(item, units, box)) {
      if (a.size[2] <= box[2] + EPS) return a;
    }
  }
  return null;
}

// Poly / bubble mailers: contents lie flat; footprint must fit the usable area, stack must fit maxThickness.
function fitMailer(item, units, pkg) {
  const soft = isSoft(item);
  const flat = !!item.mailerOk && !soft;
  const accepted = (soft && pkg.accepts.includes('soft')) || (flat && pkg.accepts.includes('flat'));
  if (!accepted) return null;
  const usable = sortDesc([pkg.l - 1, pkg.w - 0.5]); // seal + flap allowance
  let best = null;
  for (const a of arrangements(item, units, usable, { flat: true })) {
    if (a.size[2] > pkg.maxThickness + EPS) continue;
    if (!best || a.size[2] < best.size[2]) best = a;
  }
  return best ? { thickness: best.size[2], grid: best.grid } : null;
}

function toCandidate(pkg, item, units, fit) {
  const itemOz = item.weightOz * units;
  if (pkg.kind === 'flexible') {
    const h = Math.max(1, Math.ceil(fit.thickness * 2) / 2);
    return {
      id: pkg.id, name: pkg.name, kind: pkg.kind, l: pkg.l, w: pkg.w, h,
      weightOz: itemOz + pkg.tareOz, volume: volume(pkg.l, pkg.w, h),
      costUsd: pkg.costUsd || 0, template: pkg.template, isCustom: false, arrangement: fit.grid
    };
  }
  return {
    id: pkg.id, name: pkg.name, kind: pkg.kind, l: pkg.l, w: pkg.w, h: pkg.h,
    weightOz: itemOz + pkg.tareOz + (DUNNAGE_OZ[item.fragility] ?? 2),
    volume: volume(pkg.l, pkg.w, pkg.h), costUsd: pkg.costUsd || 0,
    template: pkg.template, isCustom: false, arrangement: fit.grid
  };
}

// Every library package the order physically fits in, smallest first.
function findFitting(item, units, library = defaultLibrary) {
  const out = [];
  const longest = Math.max(...item.dims);
  for (const pkg of library) {
    if (pkg.minItemLength && longest < pkg.minItemLength) continue; // specialty long boxes need long items
    if (pkg.maxPayloadOz && item.weightOz * units > pkg.maxPayloadOz) continue;
    const fit = pkg.kind === 'flexible' ? fitMailer(item, units, pkg) : fitRigid(item, units, pkg);
    if (fit) out.push(toCandidate(pkg, item, units, fit));
  }
  return out.sort((a, b) => a.volume - b.volume || a.costUsd - b.costUsd);
}

// No library package works: size a snug custom box from padded geometry.
function buildCustom(item, units) {
  const pad = PAD[item.fragility] ?? PAD.med;
  let best = null;
  for (const a of arrangements(item, units, null)) {
    const dims = a.size.map(v => v + 2 * pad);
    const vol = volume(...dims);
    if (!best || vol < best.vol) best = { dims, vol, grid: a.grid };
  }
  const [l, w, h] = sortDesc(best.dims.map(v => Math.max(1, Math.ceil(v - EPS))));
  const vol = volume(l, w, h);
  return {
    id: 'custom', name: 'Custom Box', kind: 'rigid', l, w, h, volume: vol,
    weightOz: item.weightOz * units + Math.max(3, Math.round(vol / 250)) + (DUNNAGE_OZ[item.fragility] ?? 2),
    costUsd: Math.round((1 + vol / 1200) * 100) / 100, isCustom: true, arrangement: best.grid
  };
}

// Which fitting candidates deserve a live quote. Carriers price on weight bands, dimensional
// weight and flat-rate programs, so "smallest box" alone can't rank them. Quote:
// the smallest few, the lightest (it may drop a weight band), the smallest mailer,
// and any flat-rate box that fits.
function pickRateShopSet(candidates, { n = 3 } = {}) {
  const sorted = [...candidates].sort((a, b) => a.volume - b.volume);
  const set = new Map();
  sorted.slice(0, n).forEach(c => set.set(c.id, c));
  const lightest = [...candidates].sort((a, b) => a.weightOz - b.weightOz)[0];
  if (lightest) set.set(lightest.id, lightest);
  const mailer = sorted.find(c => c.kind === 'flexible');
  if (mailer) set.set(mailer.id, mailer);
  sorted.filter(c => c.template).slice(0, 2).forEach(c => set.set(c.id, c));
  return [...set.values()].slice(0, 7);
}

function packageWarnings(c) {
  const out = [];
  const [l, w, h] = sortDesc([c.l, c.w, c.h]);
  const lengthPlusGirth = l + 2 * (w + h);
  if (lengthPlusGirth > 130) out.push('exceeds_usps_size_limit');
  else if (l > 48 || lengthPlusGirth > 108) out.push('oversize_surcharges_likely');
  if (c.weightOz > 70 * 16) out.push('exceeds_70lb');
  if (c.isCustom) out.push('custom_box_required');
  return out;
}

module.exports = {
  findFitting, buildCustom, unitShapes, pickRateShopSet, packageWarnings, fitRigid, fitMailer,
  stackThickness, PAD, defaultLibrary
};
