// Geometry helpers. All course geometry is stored in a local tangent plane
// measured in FEET: x = east, y = north, relative to the project's geo origin.

export interface Pt {
  x: number;
  y: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_FT = 20_925_646;
const DEG = Math.PI / 180;

export function toLocal(ll: LatLng, origin: LatLng): Pt {
  return {
    x: (ll.lng - origin.lng) * DEG * EARTH_RADIUS_FT * Math.cos(origin.lat * DEG),
    y: (ll.lat - origin.lat) * DEG * EARTH_RADIUS_FT,
  };
}

export function toLatLng(p: Pt, origin: LatLng): LatLng {
  return {
    lat: origin.lat + p.y / EARTH_RADIUS_FT / DEG,
    lng: origin.lng + p.x / (EARTH_RADIUS_FT * Math.cos(origin.lat * DEG)) / DEG,
  };
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const norm = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Left-hand perpendicular of a direction vector. */
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
export const heading = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
export const fromAngle = (ang: number): Pt => ({ x: Math.cos(ang), y: Math.sin(ang) });

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from p to a polyline (open) or polygon edge (closed). */
export function distToPath(p: Pt, pts: Pt[], closed: boolean): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  return best;
}

/** Distance from p to a shape; 0 if inside a closed polygon. */
export function distToShape(p: Pt, pts: Pt[], closed: boolean): number {
  if (closed && pts.length >= 3 && pointInPolygon(p, pts)) return 0;
  return distToPath(p, pts, closed);
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}

export function bbox(pts: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function pathLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** Centripetal Catmull-Rom spline through control points, then resampled at `step` feet. */
export function smoothPath(ctrl: Pt[], step = 2): Pt[] {
  if (ctrl.length < 2) return ctrl.slice();
  const pts = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const dense: Pt[] = [];
  for (let i = 0; i < pts.length - 3; i++) {
    const [p0, p1, p2, p3] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
    const segLen = dist(p1, p2);
    const n = Math.max(2, Math.ceil(segLen / 1));
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), 1e-3);
    const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), 1e-3);
    const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), 1e-3);
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const A1 = lerp(p0, p1, (t - t0) / (t1 - t0));
      const A2 = lerp(p1, p2, (t - t1) / (t2 - t1));
      const A3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const B1 = lerp(A1, A2, (t - t0) / (t2 - t0));
      const B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
      dense.push(lerp(B1, B2, (t - t1) / (t2 - t1)));
    }
  }
  dense.push(ctrl[ctrl.length - 1]);
  return resample(dense, step);
}

export function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    if (seg === 0) continue;
    let t = step - carry;
    while (t <= seg) {
      out.push(lerp(a, b, t / seg));
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push(last);
  return out;
}

/** Signed radius of the circle through a, b, c (positive = left turn). Infinity when straight. */
export function signedRadius(a: Pt, b: Pt, c: Pt): number {
  const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(cross) < 1e-9) return Infinity;
  return (ab * bc * ca) / (2 * cross);
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  const left = simplify(pts.slice(0, idx + 1), tol);
  const right = simplify(pts.slice(idx), tol);
  return [...left.slice(0, -1), ...right];
}

/** Shoelace sign: positive when points run counter-clockwise. */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  return a / 2;
}

/** Deterministic PRNG so generated courses are reproducible from a seed. */
export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FT_PER_S_PER_MPH = 5280 / 3600;
export const G_FT = 32.174;
