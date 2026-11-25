// "Find pavement" magic wand: grows a region of similar-looking pixels from a
// clicked point on the aerial image, cleans it up, and traces it into polygons.
// Pure pixel code (no DOM) so it can be tested headlessly.

export interface WandImage {
  w: number;
  h: number;
  /** Blurred CIE Lab, 3 floats per pixel. */
  lab: Float32Array;
  /** Local roughness: std-dev of unblurred lightness. Pavement is smooth, grass and roofs are not. */
  tex: Float32Array;
  /** Edge strength (Lab units per px) measured on a smoother copy, so paint stripes fade but borders stay. */
  edge: Float32Array;
}

export type Ring = [number, number][];
export interface WandShape {
  outer: Ring;
  holes: Ring[];
  areaPx: number;
}

export interface WandOptions {
  /** Max Lab color difference from the seed color (≈ 4 strict … 40 loose). */
  tolerance: number;
  /** Gaps narrower than ~2·close px (paint stripes, cracks) are bridged. */
  close: number;
  /** Leaks narrower than ~2·open px (thin driveways) are cut off. */
  open: number;
  /** Interior holes smaller than this are filled in. */
  minHolePx: number;
  /** Outline simplification tolerance, px. */
  simplifyPx: number;
  /** Weight of lightness vs tint: pavement patches vary in brightness far more than in tint. */
  lightWeight: number;
  /** Weight of surface roughness. */
  textureWeight: number;
  /** Pixels on an edge stronger than this (Lab units per px) stop the growth; 0 = off. */
  edgeStop: number;
}

export const DEFAULT_WAND: WandOptions = { tolerance: 16, close: 2, open: 2, minHolePx: 900, simplifyPx: 2.5, lightWeight: 1, textureWeight: 0, edgeStop: 2 };

// ------------------------------------------------------------------ color

function srgbToLinear(c: number) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN = new Float32Array(256).map((_, i) => srgbToLinear(i));
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

const EDGE_BLUR = 3;

export function prepareImage(rgba: Uint8ClampedArray, w: number, h: number, blur = 2): WandImage {
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = LIN[rgba[i * 4]], g = LIN[rgba[i * 4 + 1]], b = LIN[rgba[i * 4 + 2]];
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const fx = fLab(x), fy = fLab(y), fz = fLab(z);
    lab[i * 3] = 116 * fy - 16;
    lab[i * 3 + 1] = 500 * (fx - fy);
    lab[i * 3 + 2] = 200 * (fy - fz);
  }
  // roughness from E[L^2] - E[L]^2 over a small window
  const ll = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const L = lab[i * 3]; ll[i * 3] = L; ll[i * 3 + 1] = L * L; }
  const m = boxBlur3(ll, w, h, 2);
  const tex = new Float32Array(n);
  for (let i = 0; i < n; i++) tex[i] = Math.sqrt(Math.max(0, m[i * 3 + 1] - m[i * 3] * m[i * 3]));
  const soft = boxBlur3(lab, w, h, EDGE_BLUR);
  const edge = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const l = y * w + Math.max(0, x - 2), r = y * w + Math.min(w - 1, x + 2);
    const u = Math.max(0, y - 2) * w + x, d = Math.min(h - 1, y + 2) * w + x;
    let g = 0;
    for (let c = 0; c < 3; c++) {
      const gx = (soft[r * 3 + c] - soft[l * 3 + c]) / 4, gy = (soft[d * 3 + c] - soft[u * 3 + c]) / 4;
      g += gx * gx + gy * gy;
    }
    edge[i] = Math.sqrt(g);
  }
  return { w, h, lab: blur > 0 ? boxBlur3(lab, w, h, blur) : lab, tex, edge };
}

/** Separable box blur over 3 interleaved channels (smooths paint stripes and texture). */
function boxBlur3(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0, cnt = 0;
      for (let x = -r; x < w; x++) {
        const add = x + r, rem = x - r - 1;
        if (add < w) { sum += src[(y * w + add) * 3 + c]; cnt++; }
        if (rem >= 0) { sum -= src[(y * w + rem) * 3 + c]; cnt--; }
        if (x >= 0) tmp[(y * w + x) * 3 + c] = sum / cnt;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0, cnt = 0;
      for (let y = -r; y < h; y++) {
        const add = y + r, rem = y - r - 1;
        if (add < h) { sum += tmp[(add * w + x) * 3 + c]; cnt++; }
        if (rem >= 0) { sum -= tmp[(rem * w + x) * 3 + c]; cnt--; }
        if (y >= 0) out[(y * w + x) * 3 + c] = sum / cnt;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ region growing

function seedColor(img: WandImage, sx: number, sy: number) {
  let L = 0, A = 0, B = 0, T = 0, n = 0;
  for (let y = sy - 3; y <= sy + 3; y++) for (let x = sx - 3; x <= sx + 3; x++) {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    const i = (y * img.w + x) * 3;
    L += img.lab[i]; A += img.lab[i + 1]; B += img.lab[i + 2]; T += img.tex[i / 3]; n++;
  }
  return [L / n, A / n, B / n, T / n] as const;
}

/** 4-connected flood fill of pixels within `tol` of the seed color. */
function grow(img: WandImage, sx: number, sy: number, opt: WandOptions, into: Uint8Array) {
  const { w, h, lab, tex } = img;
  const [L0, A0, B0, T0] = seedColor(img, sx, sy);
  const tol2 = opt.tolerance * opt.tolerance;
  const wl = opt.lightWeight * opt.lightWeight, wt = opt.textureWeight * opt.textureWeight;
  const edge = img.edge;
  const ok = (i: number) => {
    const dl = lab[i * 3] - L0, da = lab[i * 3 + 1] - A0, db = lab[i * 3 + 2] - B0;
    const dt = Math.max(0, tex[i] - T0); // only rougher-than-seed counts against a pixel
    const d2 = wl * dl * dl + da * da + db * db + wt * dt * dt;
    if (d2 > tol2) return 0;
    // Strong edges (pavement borders) stop the growth even when the colors are close,
    // e.g. pale dry grass next to a runway. Those pixels are remembered (2) so the
    // edge band can be filled back in afterwards without crossing the border.
    return opt.edgeStop > 0 && edge[i] > opt.edgeStop ? 2 : 1;
  };
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const s = sy * w + sx;
  stack[top++] = s;
  seen[s] = 1;
  const band: number[] = [];
  while (top) {
    const i = stack[--top];
    const v = ok(i);
    if (v === 2) band.push(i);
    if (v !== 1) continue;
    into[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
    if (x < w - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
    if (y > 0 && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
    if (y < h - 1 && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
  }
  // Fill the edge band back in (color-matching pixels only), a few pixels deep.
  const cand = new Uint8Array(w * h);
  const candStack: number[] = [];
  for (const i of band) {
    const x = i % w, y = (i / w) | 0;
    for (let yy = Math.max(0, y - EDGE_FILL); yy <= Math.min(h - 1, y + EDGE_FILL); yy++)
      for (let xx = Math.max(0, x - EDGE_FILL); xx <= Math.min(w - 1, x + EDGE_FILL); xx++) {
        const j = yy * w + xx;
        if (!cand[j] && !into[j] && ok(j)) { cand[j] = 1; candStack.push(j); }
      }
  }
  for (let it = 0; it < EDGE_FILL; it++) {
    const add: number[] = [];
    for (const j of candStack) {
      if (into[j]) continue;
      const x = j % w, y = (j / w) | 0;
      if ((x > 0 && into[j - 1] === 1) || (x < w - 1 && into[j + 1] === 1) || (y > 0 && into[j - w] === 1) || (y < h - 1 && into[j + w] === 1)) add.push(j);
    }
    if (!add.length) break;
    for (const j of add) into[j] = 1;
  }
}

const EDGE_FILL = 5;

// ------------------------------------------------------------------ morphology

/** Square max (dilate) or min (erode) filter, separable. */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return src;
  const full = 2 * r + 1;
  const pass = (inp: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(inp.length);
    const lines = horizontal ? h : w, len = horizontal ? w : h;
    const at = (line: number, k: number) => (horizontal ? line * w + k : k * w + line);
    for (let line = 0; line < lines; line++) {
      let cnt = 0;
      for (let k = -r; k < len; k++) {
        const add = k + r, rem = k - r - 1;
        if (add < len) cnt += inp[at(line, add)];
        if (rem >= 0) cnt -= inp[at(line, rem)];
        if (k >= 0) {
          const lo = Math.max(0, k - r), hi = Math.min(len - 1, k + r);
          out[at(line, k)] = dilate ? (cnt > 0 ? 1 : 0) : cnt === hi - lo + 1 && hi - lo + 1 === full ? 1 : 0;
        }
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/** Keep only the 4-connected component containing pixel `s`. */
function componentAt(mask: Uint8Array, w: number, h: number, s: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  if (!mask[s]) return out;
  const stack = new Int32Array(mask.length);
  let top = 0;
  stack[top++] = s;
  out[s] = 1;
  while (top) {
    const i = stack[--top];
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && mask[j] && !out[j]) { out[j] = 1; stack[top++] = j; }
  }
  return out;
}

/** Labels background regions not connected to the image border (holes). */
function findHoles(mask: Uint8Array, w: number, h: number): { pixels: number[] }[] {
  const lab = new Int32Array(mask.length); // 0 unvisited, -1 outside, >0 hole id
  const stack = new Int32Array(mask.length);
  const flood = (s: number, id: number, collect?: number[]) => {
    let top = 0;
    stack[top++] = s;
    lab[s] = id;
    while (top) {
      const i = stack[--top];
      collect?.push(i);
      const x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !mask[j] && lab[j] === 0) { lab[j] = id; stack[top++] = j; }
    }
  };
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (!mask[i] && !lab[i]) flood(i, -1); }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (!mask[i] && !lab[i]) flood(i, -1); }
  const holes: { pixels: number[] }[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !lab[i]) {
      const pixels: number[] = [];
      flood(i, holes.length + 1, pixels);
      holes.push({ pixels });
    }
  }
  return holes;
}

// ------------------------------------------------------------------ outline tracing

/**
 * Follows the pixel-edge boundary of a 4-connected blob, clockwise (screen
 * coordinates), starting at its top-left pixel. Returns corner vertices.
 */
export function traceBoundary(mask: Uint8Array, w: number, h: number): Ring {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // directions: 0 E, 1 S, 2 W, 3 N (y down)
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  // pixel on the right / left of the edge leaving vertex (x,y) in direction d
  const RX = [0, -1, -1, 0], RY = [0, 0, -1, -1];
  const LX = [0, 0, -1, -1], LY = [-1, 0, 0, -1];
  const sx = start % w, sy = (start / w) | 0;
  // The start vertex is the top-left corner of the first pixel in raster order, so its
  // only boundary edges are the top edge (leaving east) and the left edge (arriving north).
  let x = sx, y = sy, d = 0;
  const ring: Ring = [[x, y]];
  const limit = 4 * (w + 1) * (h + 1);
  for (let steps = 0; steps < limit; steps++) {
    x += DX[d];
    y += DY[d];
    if (x === sx && y === sy) break;
    const fr = filled(x + RX[d], y + RY[d]);
    const fl = filled(x + LX[d], y + LY[d]);
    // region on the right: blocked ahead-right → turn right; region ahead-left too → turn left
    const nd = fr && fl ? (d + 3) % 4 : fr ? d : (d + 1) % 4;
    if (nd !== d) { ring.push([x, y]); d = nd; }
  }
  return ring;
}

function distToSeg(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function rdp(pts: Ring, tol: number): Ring {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), tol).slice(0, -1), ...rdp(pts.slice(idx), tol)];
}

/** Simplifies a closed ring; keeps it under `maxPts` corners. */
export function simplifyRing(ring: Ring, tol: number, maxPts = 300): Ring {
  if (ring.length < 4) return ring;
  // split at the point farthest from the first one so both halves are well-conditioned
  let far = 0, fd = 0;
  for (let i = 0; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  let t = tol;
  for (;;) {
    const a = rdp(ring.slice(0, far + 1), t);
    const b = rdp([...ring.slice(far), ring[0]], t);
    const out = [...a.slice(0, -1), ...b.slice(0, -1)];
    if (out.length <= maxPts || t > 50) return out;
    t *= 1.5;
  }
}

function ringArea(r: Ring) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

// ------------------------------------------------------------------ main entry

/**
 * Runs the wand for one or more seed points (each grows with its own seed
 * color) and returns one shape per resulting connected area.
 */
export function runWand(img: WandImage, seeds: { x: number; y: number }[], opt: WandOptions = DEFAULT_WAND): WandShape[] {
  const { w, h } = img;
  let mask: Uint8Array = new Uint8Array(w * h);
  for (const s of seeds) {
    const sx = Math.max(0, Math.min(w - 1, Math.round(s.x))), sy = Math.max(0, Math.min(h - 1, Math.round(s.y)));
    grow(img, sx, sy, opt, mask);
  }
  mask = morph(morph(mask, w, h, opt.close, true), w, h, opt.close, false); // close: bridge stripes/cracks
  mask = morph(morph(mask, w, h, opt.open, false), w, h, opt.open, true); // open: cut thin leaks
  mask = morph(mask, w, h, 1, true); // the blur pulls edges in by ~1 px; give it back

  // Each seed's connected area, deduplicated.
  const shapes: WandShape[] = [];
  const taken = new Uint8Array(w * h);
  for (const s of seeds) {
    const si = Math.round(s.y) * w + Math.round(s.x);
    if (!mask[si] || taken[si]) continue;
    const comp = componentAt(mask, w, h, si);
    for (let i = 0; i < comp.length; i++) if (comp[i]) taken[i] = 1;

    // Fill small holes; keep large ones as separate rings.
    const holes = findHoles(comp, w, h);
    const keep: number[][] = [];
    for (const hole of holes) {
      if (hole.pixels.length < opt.minHolePx) for (const i of hole.pixels) comp[i] = 1;
      else keep.push(hole.pixels);
    }
    const outer = simplifyRing(traceBoundary(comp, w, h), opt.simplifyPx);
    if (outer.length < 3) continue;
    const holeRings: Ring[] = [];
    for (const px of keep) {
      const hm = new Uint8Array(w * h);
      for (const i of px) hm[i] = 1;
      const r = simplifyRing(traceBoundary(hm, w, h), opt.simplifyPx);
      if (r.length >= 3) holeRings.push(r);
    }
    let area = 0;
    for (let i = 0; i < comp.length; i++) area += comp[i];
    shapes.push({ outer, holes: holeRings, areaPx: area });
  }
  return shapes.filter((s) => ringArea(s.outer) > 20);
}
