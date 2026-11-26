import {
  add,
  dist,
  distToPath,
  distToSegment,
  distToShape,
  fromAngle,
  lerp,
  mulberry32,
  perp,
  pointInPolygon,
  polygonArea,
  scale,
  simplify,
  sub,
  type Pt,
} from "./geo";
import { uid, type Cone, type Course, type FeatureKind } from "./model";
import { checkCourse } from "./rules";
import { simulate } from "./sim";

export interface GenStats {
  noStart: number;
  noFinish: number;
  lengths: number[];
  /** Set when generation can't begin: "gates" (start/finish missing), "start" (no room ahead of it), "finish" (no approach or runout). */
  reason?: "gates" | "start" | "finish";
}

export interface GenOptions {
  seed: number;
  attempts: number;
  /** 0 = flowing/open, 1 = technical/tight */
  technical: number;
  /** Let the course cross over itself (at a steep angle, at most twice). */
  allowCrossovers?: boolean;
  /** Rough course length to aim for; defaults to a size that suits the site. */
  targetLengthFt?: number;
  /** Stop searching after this long (default 8 s). */
  timeBudgetMs?: number;
  stats?: GenStats;
}

export interface GenResult {
  line: Pt[];
  cones: Cone[];
  start: { a: Pt; b: Pt };
  finish: { a: Pt; b: Pt };
  score: number;
  errors: number;
  warnings: number;
  lengthFt: number;
  timeS: number;
  maxMph: number;
  crossovers: number;
}

type Seg = "launch" | "straight" | "sweeper" | "turn" | "hairpin" | "slalom" | "kink" | "finish";
interface Node { p: Pt; seg: Seg; segId: number; side: number; R: number }
interface Piece { seg: Seg; side: number; R: number; weave?: number; pts: Pt[]; dir: number }

const STEP = 2;
const FIN_STRAIGHT = 70;
const RUNOUT = 200;
const TAU = Math.PI * 2;
const mod2pi = (a: number) => ((a % TAU) + TAU) % TAU;

export function suggestedLength(c: Course): number {
  // Usable area: course areas minus Don't-use islands inside them.
  const paved = c.features.filter((f) => f.kind === "paved" && f.pts.length >= 3);
  const holes = c.features.filter((f) => f.kind === "nogo" && f.pts.length >= 3 && paved.some((p) => pointInPolygon(f.pts[0], p.pts)));
  const area = paved.reduce((a, f) => a + polygonArea(f.pts), 0) - holes.reduce((a, f) => a + polygonArea(f.pts), 0);
  if (area <= 0) return 2500;
  return Math.round(Math.min(4500, Math.max(1200, Math.sqrt(area) * 3.2)) / 100) * 100;
}

const straightFrom = (pos: Pt, dir: number, len: number): Pt[] => {
  const pts: Pt[] = [];
  const n = Math.max(1, Math.round(len / STEP));
  for (let i = 1; i <= n; i++) pts.push(add(pos, scale(fromAngle(dir), (len * i) / n)));
  return pts;
};
const arcFrom = (pos: Pt, dir: number, R: number, ang: number, side: number): Pt[] => {
  const center = add(pos, scale(perp(fromAngle(dir)), side * R));
  const a0 = Math.atan2(pos.y - center.y, pos.x - center.x);
  const n = Math.max(2, Math.ceil((R * ang) / STEP));
  const pts: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + (side * ang * i) / n;
    pts.push({ x: center.x + R * Math.cos(a), y: center.y + R * Math.sin(a) });
  }
  return pts;
};
const piecesLen = (ps: Piece[]) => ps.reduce((a, p) => a + p.pts.length * STEP, 0);

/** Turn-straight-turn paths (Dubins CSC) from one pose to another with turn radius R, shortest first. */
export function connectors(pos: Pt, dir: number, goal: Pt, goalDir: number, R: number): Piece[][] {
  const out: Piece[][] = [];
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
    const c1 = add(pos, scale(perp(fromAngle(dir)), s1 * R));
    const c2 = add(goal, scale(perp(fromAngle(goalDir)), s2 * R));
    const w = sub(c2, c1);
    const k = (s2 - s1) * R;
    const ww = w.x * w.x + w.y * w.y;
    if (ww < k * k + 1) continue;
    const L = Math.sqrt(ww - k * k);
    const psi = Math.atan2(w.y, w.x) - Math.atan2(k, L);
    const ang1 = mod2pi(s1 * (psi - dir));
    const ang2 = mod2pi(s2 * (goalDir - psi));
    if (ang1 > 3.3 || ang2 > 3.3) continue;
    const segFor = (ang: number): Seg => (ang < 0.5 ? "kink" : R >= 65 ? "sweeper" : ang > 2.5 ? "hairpin" : "turn");
    const pieces: Piece[] = [];
    let p = pos;
    if (ang1 * R > 4) { const pts = arcFrom(p, dir, R, ang1, s1); pieces.push({ seg: segFor(ang1), side: s1, R, pts, dir: psi }); p = pts[pts.length - 1]; }
    if (L > 4) { const pts = straightFrom(p, psi, L); pieces.push({ seg: "straight", side: 0, R: Infinity, pts, dir: psi }); p = pts[pts.length - 1]; }
    if (ang2 * R > 4) { const pts = arcFrom(p, psi, R, ang2, s2); pieces.push({ seg: segFor(ang2), side: s2, R, pts, dir: goalDir }); }
    if (pieces.length) out.push(pieces);
  }
  return out.sort((a, b) => piecesLen(a) - piecesLen(b));
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/**
 * Builds a course from the placed start line to the placed finish line. Returns null when
 * nothing fits; `opt.stats` says why.
 */
export function generateCourse(course: Course, opt: GenOptions, onProgress?: (i: number) => void): GenResult | null {
  const stats = opt.stats ?? { noStart: 0, noFinish: 0, lengths: [] };
  const paved = course.features.filter((f) => f.kind === "paved" && f.pts.length >= 3 && polygonArea(f.pts) > 400);
  if (!paved.length) return null;
  if (!course.start || !course.finish) { stats.reason = "gates"; return null; }
  const target = opt.targetLengthFt ?? suggestedLength(course);
  const karts = course.settings.karts;
  const solidMargin = (karts ? 50 : 25) + 10;
  const of = (k: FeatureKind[]) => course.features.filter((f) => k.includes(f.kind));
  const solids = of(["obstacle", "pole", "curb"]);
  const people = of(["spectator", "paddock", "grid"]);
  const surface = of(["surface"]);
  const nogo = of(["nogo"]).filter((f) => f.pts.length >= 3);

  const safe = (p: Pt, edge = 15, peopleMargin = 90) => {
    if (!paved.some((f) => pointInPolygon(p, f.pts))) return false;
    if (Math.min(...paved.map((f) => distToPath(p, f.pts, true))) < edge) return false;
    for (const f of solids) if (distToShape(p, f.pts, f.closed) < (f.kind === "curb" ? 35 : solidMargin)) return false;
    for (const f of people) if (distToShape(p, f.pts, f.closed) < peopleMargin) return false;
    for (const f of surface) if (distToShape(p, f.pts, f.closed) < 10) return false;
    for (const f of nogo) if (distToShape(p, f.pts, true) < 15) return false;
    return true;
  };

  // The car launches straight ahead from the start line, either way across it.
  const startP = lerp(course.start.a, course.start.b, 0.5);
  const sAng = Math.atan2(course.start.b.y - course.start.a.y, course.start.b.x - course.start.a.x);
  const launchDirs = [sAng + Math.PI / 2, sAng - Math.PI / 2].filter((d) => straightFrom(startP, d, 120).filter((_, i) => i % 5 === 4).every((q) => safe(q, 10)));
  if (!launchDirs.length) { stats.reason = "start"; return null; }

  // The finish needs a straight approach and a clear runout beyond it.
  const finishP = lerp(course.finish.a, course.finish.b, 0.5);
  const fAng = Math.atan2(course.finish.b.y - course.finish.a.y, course.finish.b.x - course.finish.a.x);
  const finDirs = [fAng + Math.PI / 2, fAng - Math.PI / 2].filter((d) => {
    for (let s = -FIN_STRAIGHT; s <= 0; s += 10) if (!safe(add(finishP, scale(fromAngle(d), s)), 10)) return false;
    for (let s = 10; s <= RUNOUT; s += 10) if (!safe(add(finishP, scale(fromAngle(d), s)), 6, 120)) return false;
    return true;
  });
  if (!finDirs.length) { stats.reason = "finish"; return null; }

  let best: GenResult | null = null;
  const t0 = Date.now();
  for (let attempt = 0; attempt < opt.attempts; attempt++) {
    if (best && attempt >= 40 && best.errors === 0 && best.lengthFt >= target * 0.6) break;
    if (Date.now() - t0 > (opt.timeBudgetMs ?? 8000)) break;
    onProgress?.(attempt);
    const rnd = mulberry32(opt.seed * 7919 + attempt * 104729);
    const r = attemptOnce(rnd);
    if (!r) continue;
    const draft: Course = { ...course, line: r.line, cones: [...course.cones.filter((k) => k.group === "start" || k.group === "finish"), ...r.cones] };
    const sim = simulate(r.line, course.settings.car, course.settings.wet);
    if (!sim) continue;
    const issues = checkCourse(draft, sim);
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warn").length;
    // Length matters little: only very short or very long courses lose points.
    const lenPenalty = (Math.max(0, target * 0.6 - sim.lengthFt) + Math.max(0, sim.lengthFt - target * 1.4)) / 15;
    const score = errors * 100 + warnings * 12 + lenPenalty + Math.max(0, sim.maxMph - 58) * 8 + Math.max(0, 38 - sim.avgMph) * 2;
    if (!best || score < best.score) best = { ...r, score, errors, warnings, lengthFt: sim.lengthFt, timeS: sim.timeS, maxMph: sim.maxMph };
  }
  return best;

  function attemptOnce(rnd: () => number) {
    const range = (a: number, b: number) => a + rnd() * (b - a);
    const startDir = launchDirs[Math.floor(rnd() * launchDirs.length)];
    const finDir = finDirs[Math.floor(rnd() * finDirs.length)];
    const fd = fromAngle(finDir);
    const approach = add(finishP, scale(fd, -FIN_STRAIGHT));
    // Keep the course away from the finish chute and runout.
    const chuteA = add(finishP, scale(fd, -FIN_STRAIGHT - 40));
    const chuteB = add(finishP, scale(fd, RUNOUT + 20));
    const clearOfFinish = (q: Pt) => distToSegment(q, chuteA, chuteB) > 60;
    // The connection into the finish may come from any side, but not through the finish or runout.
    const clearOfRunout = (q: Pt) => {
      const v = sub(q, finishP);
      return v.x * fd.x + v.y * fd.y < -30 || Math.abs(v.x * -fd.y + v.y * fd.x) > 60;
    };

    const nodes: Node[] = [{ p: startP, seg: "launch", segId: 0, side: 0, R: Infinity }];
    let crossings = 0;
    let lastCross = { i: -999, at: -999 };

    /** Keeps 70 ft from earlier parts of the course; with crossovers on, a steep actual crossing is allowed. */
    const checkPiece = (from: Pt, cand: Pt[]): { ok: boolean; cross?: number } => {
      const limit = nodes.length - Math.ceil(160 / STEP);
      let need = false;
      let prev = from;
      for (const q of cand) {
        const h = Math.atan2(q.y - prev.y, q.x - prev.x);
        prev = q;
        for (let i = 0; i < limit; i += 3) {
          if (dist(q, nodes[i].p) >= 70) continue;
          if (!opt.allowCrossovers || i < 60) return { ok: false };
          if (Math.abs(i - lastCross.i) < 60 && nodes.length - lastCross.at < 150) continue;
          const a = nodes[Math.max(0, i - 2)].p, b = nodes[Math.min(nodes.length - 1, i + 2)].p;
          if (Math.abs(Math.sin(h - Math.atan2(b.y - a.y, b.x - a.x))) < 0.8) return { ok: false };
          need = true;
        }
      }
      if (!need) return { ok: true };
      if (crossings >= 2) return { ok: false };
      // It must actually cross, not just aim at the earlier section.
      const path = [from, ...cand];
      for (let k = 1; k < path.length; k++) {
        for (let i = 1; i < limit; i++) if (segIntersect(path[k - 1], path[k], nodes[i - 1].p, nodes[i].p)) return { ok: true, cross: i };
      }
      return { ok: false };
    };
    const commit = (pc: Piece, segId: number, cross?: number) => {
      for (const p of pc.pts) nodes.push({ p, seg: pc.seg, segId, side: pc.side, R: pc.weave ?? pc.R });
      if (cross !== undefined) { crossings++; lastCross = { i: cross, at: nodes.length }; }
    };

    let segId = 0;
    let dir = startDir;
    const launch = straightFrom(startP, startDir, range(70, 110));
    commit({ seg: "launch", side: 0, R: Infinity, pts: launch, dir }, segId);
    let pos = launch[launch.length - 1];
    let straightRun = launch.length * STEP;
    let lastSide = rnd() < 0.5 ? 1 : -1;
    let length = straightRun;
    let bestCut: { idx: number; segId: number; pieces: Piece[]; crossings: number; total: number; cross?: number } | null = null;

    const tryFinish = () => {
      for (const R of [35, 45, 65, 95, 130]) {
        for (const pieces of connectors(pos, dir, approach, finDir, R)) {
          const pts = pieces.flatMap((p) => p.pts);
          if (!pts.every((q) => safe(q))) continue;
          if (!pts.every(clearOfRunout)) continue;
          const chk = checkPiece(pos, pts);
          if (!chk.ok) continue;
          const total = length + piecesLen(pieces) + FIN_STRAIGHT;
          if (!bestCut || Math.abs(total - target) < Math.abs(bestCut.total - target)) bestCut = { idx: nodes.length, segId, pieces, crossings, total, cross: chk.cross };
          return;
        }
      }
    };

    let stuck = 0;
    while (length < target * 1.3 && stuck < 3) {
      const tech = opt.technical;
      const weights: [Seg, number][] = [
        ["sweeper", 3 - tech * 1.5],
        ["turn", 2.5 + tech],
        ["hairpin", 0.25 + tech * 0.5],
        ["slalom", straightRun < 60 ? 1.4 : 0],
        ["straight", straightRun < 60 ? 1.2 : 0],
        ["kink", 1.2],
      ];
      const tot = weights.reduce((a, w) => a + Math.max(0, w[1]), 0);
      // Try several random pieces and keep the first that fits, so narrow areas
      // (taxiways, lanes between islands) don't end the walk on one bad roll.
      // Past halfway, steer toward the finish: of the pieces that fit, prefer the one ending nearest it.
      const homing = length > target * 0.5;
      let chosen: { pc: Piece; cross?: number } | null = null;
      let chosenD = Infinity;
      for (let tryN = 0; tryN < 14 && (!chosen || homing); tryN++) {
        let roll = rnd() * tot;
        let seg: Seg = "turn";
        for (const [s2, w] of weights) { roll -= Math.max(0, w); if (roll <= 0) { seg = s2; break; } }
        if (tryN >= 8) seg = (["turn", "kink", "hairpin", "turn", "straight", "kink"] as Seg[])[tryN - 8];
        const side = rnd() < 0.68 ? -lastSide : lastSide;
        const arc = (R: number, ang: number): Piece => ({ seg, side, R, pts: arcFrom(pos, dir, R, ang, side), dir: dir + side * ang });
        let pc: Piece;
        if (seg === "sweeper") pc = arc(range(65, 125), range(0.7, 2.0));
        else if (seg === "turn") pc = arc(range(32, 55), range(1.2, 1.75));
        else if (seg === "hairpin") pc = arc(range(28, 34), range(2.6, 3.1));
        else if (seg === "kink") pc = arc(range(140, 220), range(0.25, 0.45));
        else if (seg === "straight") pc = { seg, side: 0, R: Infinity, pts: straightFrom(pos, dir, range(40, Math.max(50, 170 - straightRun))), dir };
        else {
          const spacing = range(60, 74);
          const count = 3 + Math.floor(rnd() * 3);
          pc = { seg, side: 0, R: Infinity, weave: spacing, pts: straightFrom(pos, dir, spacing * (count + 1)), dir };
        }
        if (!pc.pts.every((p) => safe(p) && clearOfFinish(p))) continue;
        const chk = checkPiece(pos, pc.pts);
        if (!chk.ok) continue;
        // Don't drive into a dead end: some room must remain ahead.
        const end = pc.pts[pc.pts.length - 1];
        let room = true;
        for (let s2 = 10; s2 <= 40; s2 += 10) if (!safe(add(end, scale(fromAngle(pc.dir), s2)))) { room = false; break; }
        if (!room && tryN < 12) continue;
        const dEnd = homing ? dist(end, approach) * (0.8 + rnd() * 0.4) : 0;
        if (!chosen || dEnd < chosenD) { chosen = { pc, cross: chk.cross }; chosenD = dEnd; }
      }
      if (!chosen) { stuck++; continue; }
      stuck = 0;
      const { pc } = chosen;
      segId++;
      commit(pc, segId, chosen.cross);
      pos = pc.pts[pc.pts.length - 1];
      dir = pc.dir;
      length += pc.pts.length * STEP;
      if (pc.seg === "straight" || pc.seg === "slalom") straightRun += pc.pts.length * STEP;
      else straightRun = pc.seg === "kink" ? straightRun : 0;
      if (pc.seg !== "straight" && pc.seg !== "slalom") lastSide = pc.side;

      if (pc.seg !== "slalom") tryFinish();
    }
    stats.lengths.push(Math.round(length));
    if (!bestCut) { stats.noFinish++; return null; }
    const cut = bestCut as { idx: number; segId: number; pieces: Piece[]; crossings: number; total: number; cross?: number };

    const kept = nodes.slice(0, cut.idx);
    let sid = cut.segId;
    for (const pc of cut.pieces) { sid++; for (const p of pc.pts) kept.push({ p, seg: pc.seg, segId: sid, side: pc.side, R: pc.R }); }
    sid++;
    for (const p of straightFrom(approach, finDir, FIN_STRAIGHT)) kept.push({ p, seg: "finish", segId: sid, side: 0, R: Infinity });

    const placed = placeCones(kept, finDir, finishP, rnd);
    return { ...placed, start: course.start!, finish: course.finish!, crossovers: cut.crossings + (cut.cross !== undefined ? 1 : 0) };
  }
}

function placeCones(nodes: Node[], finDir: number, finishP: Pt, rnd: () => number) {
  const cones: Cone[] = [];
  const line: Pt[] = [];
  const range = (a: number, b: number) => a + rnd() * (b - a);

  // Driving line with weave through slaloms.
  const segStart = new Map<number, number>();
  nodes.forEach((n, i) => { if (!segStart.has(n.segId)) segStart.set(n.segId, i); });
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.seg === "slalom") {
      const i0 = segStart.get(n.segId)!;
      const s = (i - i0 + 1) * STEP;
      const spacing = n.R;
      const prev = nodes[Math.max(0, i - 1)].p;
      const next = nodes[Math.min(nodes.length - 1, i + 1)].p;
      const d = { x: next.x - prev.x, y: next.y - prev.y };
      const l = Math.hypot(d.x, d.y) || 1;
      const off = 7 * Math.sin((Math.PI * s) / spacing - Math.PI / 2) * Math.min(1, s / spacing, ((segLen(n.segId) - s) / spacing) + 0.5);
      line.push(add(n.p, scale(perp({ x: d.x / l, y: d.y / l }), off)));
    } else line.push(n.p);
  }
  function segLen(id: number) { return nodes.filter((n) => n.segId === id).length * STEP; }

  const gid = () => uid("g");
  const dirAt = (i: number) => {
    const a = nodes[Math.max(0, i - 2)].p;
    const b = nodes[Math.min(nodes.length - 1, i + 2)].p;
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const gate = (i: number, width: number, inside?: number, pointer = false) => {
    const d = fromAngle(dirAt(i));
    const left = perp(d);
    const g = gid();
    const p = nodes[i].p;
    const a = add(p, scale(left, width / 2));
    const b = add(p, scale(left, -width / 2));
    cones.push({ id: uid("c"), ...a, kind: "standing", group: "gate", groupId: g });
    cones.push({ id: uid("c"), ...b, kind: "standing", group: "gate", groupId: g });
    if (pointer && inside) {
      const ip = inside > 0 ? a : b;
      const outward = inside > 0 ? left : scale(left, -1);
      const pp = add(ip, scale(outward, 2.5));
      cones.push({ id: uid("c"), ...pp, kind: "pointer", rot: Math.atan2(-outward.y, -outward.x), group: "apex", groupId: g });
    }
  };

  // Walk segments.
  const segIds = [...new Set(nodes.map((n) => n.segId))];
  let lastGateS = -999;
  for (const id of segIds) {
    const idx = nodes.map((n, i) => (n.segId === id ? i : -1)).filter((i) => i >= 0);
    const n0 = nodes[idx[0]];
    const sAt = (i: number) => i * STEP;
    if (n0.seg === "slalom") {
      const spacing = n0.R;
      const g = gid();
      for (let s = spacing; s < idx.length * STEP - spacing / 2; s += spacing) {
        const i = idx[0] + Math.round(s / STEP);
        cones.push({ id: uid("c"), ...nodes[i].p, kind: "standing", group: "slalom", groupId: g });
      }
      lastGateS = sAt(idx[idx.length - 1]);
      continue;
    }
    if (["turn", "hairpin", "sweeper"].includes(n0.seg)) {
      const width = n0.seg === "sweeper" ? range(26, 32) : range(22, 26);
      const mid = idx[Math.floor(idx.length / 2)];
      gate(mid, width, n0.side, true);
      lastGateS = sAt(mid);
      if (n0.seg === "sweeper" && idx.length * STEP > 180) {
        gate(idx[Math.floor(idx.length * 0.15)], width, n0.side);
        gate(idx[Math.floor(idx.length * 0.85)], width, n0.side);
      }
      continue;
    }
    if (n0.seg === "kink") {
      const mid = idx[Math.floor(idx.length / 2)];
      if (sAt(mid) - lastGateS > 60) { gate(mid, range(20, 24), n0.side, true); lastGateS = sAt(mid); }
      continue;
    }
    if (n0.seg === "straight" && idx.length * STEP > 110) {
      const mid = idx[Math.floor(idx.length / 2)];
      if (sAt(mid) - lastGateS > 70) { gate(mid, range(22, 26)); lastGateS = sAt(mid); }
    }
  }

  // Finish chute walls. The timing lights are the ones the user placed.
  const fl = perp(fromAngle(finDir));
  const fd = fromAngle(finDir);
  for (let s = 15; s <= 75; s += 12) {
    for (const side of [1, -1]) cones.push({ id: uid("c"), ...add(add(finishP, scale(fd, s)), scale(fl, side * 20)), kind: "standing", group: "wall" });
  }

  return { line: simplify(line, 0.4), cones };
}
