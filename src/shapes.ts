// Zone shape editing: cut away, add, straighten an edge, smooth jagged edges.
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { dist, polygonArea, simplify, type Pt } from "./geo";
import { uid, type Feature, type FeatureKind } from "./model";

const ring = (pts: Pt[]): [number, number][] => {
  const r = pts.map((p) => [p.x, p.y] as [number, number]);
  r.push([pts[0].x, pts[0].y]);
  return r;
};
const toPoly = (pts: Pt[]): Polygon => [ring(pts)];
const fromRing = (r: [number, number][]): Pt[] => {
  const pts = r.map(([x, y]) => ({ x, y }));
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  return pts;
};

/** Turns a boolean-op result into features: outer rings keep the original's kind, holes become Don't-use (for course areas). */
function piecesToFeatures(mp: MultiPolygon, like: Feature, minArea = 25): Feature[] {
  const out: Feature[] = [];
  let first = true;
  for (const poly of mp) {
    const outer = fromRing(poly[0]);
    if (outer.length < 3 || polygonArea(outer) < minArea) continue;
    out.push({ ...like, id: first ? like.id : uid("f"), pts: outer, closed: true });
    first = false;
    if (like.kind === "paved") {
      for (const h of poly.slice(1)) {
        const hp = fromRing(h);
        if (hp.length >= 3 && polygonArea(hp) >= minArea) out.push({ id: uid("f"), kind: "nogo", pts: hp, closed: true, label: "Island" });
      }
    }
  }
  return out;
}

const overlaps = (a: Pt[], b: Pt[]) => polygonClipping.intersection(toPoly(a), toPoly(b)).length > 0;

/**
 * Removes the drawn shape from the target zones. Targets: the given ids, or all zones of
 * `kind` the shape touches. Returns the new feature list and how many zones changed.
 */
export function cutAway(features: Feature[], shape: Pt[], targetIds: string[] | null, kind: FeatureKind = "paved") {
  let changed = 0;
  const next: Feature[] = [];
  const existing = new Set(features.map((f) => f.id));
  for (const f of features) {
    const isTarget = !f.locked && f.closed && f.pts.length >= 3 && (targetIds ? targetIds.includes(f.id) : f.kind === kind) && overlaps(f.pts, shape);
    if (!isTarget) { next.push(f); continue; }
    changed++;
    next.push(...piecesToFeatures(polygonClipping.difference(toPoly(f.pts), toPoly(shape)), f));
  }
  // Don't-use islands that were inside the removed part go with it.
  const cleaned = kind === "paved" && changed
    ? next.filter((f) => !(existing.has(f.id) && !f.locked && f.kind === "nogo" && f.label?.startsWith("Island") && polygonClipping.difference(toPoly(f.pts), toPoly(shape)).length === 0))
    : next;
  return { features: cleaned, changed };
}

/** Merges the drawn shape into the target zone(s): the given ids, or every zone of `kind` it touches. Creates a new zone if it touches none. */
export function addArea(features: Feature[], shape: Pt[], targetIds: string[] | null, kind: FeatureKind = "paved") {
  const targets = features.filter((f) => !f.locked && f.closed && f.pts.length >= 3 && (targetIds ? targetIds.includes(f.id) : f.kind === kind && overlaps(f.pts, shape)));
  if (!targets.length) {
    const nf: Feature = { id: uid("f"), kind, pts: shape, closed: true };
    return { features: [...features, nf], changed: 0, created: nf.id };
  }
  const merged = polygonClipping.union(toPoly(shape), ...targets.map((t) => toPoly(t.pts)));
  const pieces = piecesToFeatures(merged, targets[0]);
  // Islands now covered by the added area are no longer off limits.
  const rest = features.filter((f) => !targets.includes(f) && !(!f.locked && f.kind === "nogo" && f.label?.startsWith("Island") && polygonClipping.difference(toPoly(f.pts), toPoly(shape)).length === 0));
  return { features: [...rest, ...pieces], changed: targets.length, created: pieces[0]?.id };
}

/**
 * Replaces everything between corner i and corner j with one straight edge, removing
 * whichever way around the outline is shorter.
 */
export function straightenEdge(pts: Pt[], i: number, j: number): Pt[] {
  const n = pts.length;
  if (i === j || n < 4) return pts;
  const walk = (a: number, b: number) => { const idx: number[] = []; for (let k = (a + 1) % n; k !== b; k = (k + 1) % n) idx.push(k); return idx; };
  const len = (a: number, b: number) => { let l = 0; for (let k = a; k !== b; k = (k + 1) % n) l += dist(pts[k], pts[(k + 1) % n]); return l; };
  const drop = len(i, j) <= len(j, i) ? walk(i, j) : walk(j, i);
  if (n - drop.length < 3) return pts;
  const gone = new Set(drop);
  return pts.filter((_, k) => !gone.has(k));
}

/** Simplifies a closed outline: removes corners closer than `tol` ft to a straight line. */
export function smoothOutline(pts: Pt[], tol: number): Pt[] {
  if (tol <= 0 || pts.length < 4) return pts;
  let far = 0, fd = 0;
  for (let k = 0; k < pts.length; k++) { const d = dist(pts[k], pts[0]); if (d > fd) { fd = d; far = k; } }
  const a = simplify(pts.slice(0, far + 1), tol);
  const b = simplify([...pts.slice(far), pts[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : pts;
}
