import {
  add,
  bbox,
  dist,
  distToPath,
  distToShape,
  fromAngle,
  mulberry32,
  perp,
  pointInPolygon,
  polygonArea,
  scale,
  simplify,
  type Pt,
} from "./geo";
import { uid, type Cone, type Course, type FeatureKind } from "./model";
import { checkCourse } from "./rules";
import { simulate } from "./sim";

export interface GenOptions {
  targetLengthFt: number;
  seed: number;
  attempts: number;
  /** 0 = flowing/open, 1 = technical/tight */
  technical: number;
  /** Stop searching after this long (default 8 s). */
  timeBudgetMs?: number;
  /** Filled in with why attempts failed, for the UI. */
  stats?: { noStart: number; noFinish: number; lengths: number[] };
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
  note?: string;
}

type Seg = "launch" | "straight" | "sweeper" | "turn" | "hairpin" | "slalom" | "kink" | "finish";
interface Node { p: Pt; seg: Seg; segId: number; side: number; R: number }

const STEP = 2;

export function suggestedLength(c: Course): number {
  // Usable area: course areas minus Don't-use islands inside them.
  const paved = c.features.filter((f) => f.kind === "paved" && f.pts.length >= 3);
  const holes = c.features.filter((f) => f.kind === "nogo" && f.pts.length >= 3 && paved.some((p) => pointInPolygon(f.pts[0], p.pts)));
  const area = paved.reduce((a, f) => a + polygonArea(f.pts), 0) - holes.reduce((a, f) => a + polygonArea(f.pts), 0);
  if (area <= 0) return 2500;
  return Math.round(Math.min(4500, Math.max(1200, Math.sqrt(area) * 3.2)) / 100) * 100;
}

export function generateCourse(course: Course, opt: GenOptions, onProgress?: (i: number) => void): GenResult | null {
  const paved = course.features.filter((f) => f.kind === "paved" && f.pts.length >= 3 && polygonArea(f.pts) > 400);
  if (!paved.length) return null;
  const karts = course.settings.karts;
  const solidMargin = (karts ? 50 : 25) + 10;
  const of = (k: FeatureKind[]) => course.features.filter((f) => k.includes(f.kind));
  const solids = of(["obstacle", "pole", "curb"]);
  const people = of(["spectator", "paddock", "grid"]);
  const surface = of(["surface"]);
  const nogo = of(["nogo"]).filter((f) => f.pts.length >= 3);
  const grid = of(["grid"])[0];

  const safe = (p: Pt, edge = 18, peopleMargin = 90) => {
    if (!paved.some((f) => pointInPolygon(p, f.pts))) return false;
    if (Math.min(...paved.map((f) => distToPath(p, f.pts, true))) < edge) return false;
    for (const f of solids) if (distToShape(p, f.pts, f.closed) < (f.kind === "curb" ? 35 : solidMargin)) return false;
    for (const f of people) if (distToShape(p, f.pts, f.closed) < peopleMargin) return false;
    for (const f of surface) if (distToShape(p, f.pts, f.closed) < 10) return false;
    for (const f of nogo) if (distToShape(p, f.pts, true) < 20) return false;
    return true;
  };

  const all = paved.flatMap((f) => f.pts);
  const bb = bbox(all);

  let best: GenResult | null = null;
  const t0 = Date.now();
  for (let attempt = 0; attempt < opt.attempts; attempt++) {
    // Good enough, or taking too long: stop early.
    if (best && attempt >= 40 && best.errors === 0 && Math.abs(best.lengthFt - opt.targetLengthFt) < opt.targetLengthFt * 0.12) break;
    if (Date.now() - t0 > (opt.timeBudgetMs ?? 8000)) break;
    onProgress?.(attempt);
    const rnd = mulberry32(opt.seed * 7919 + attempt * 104729);
    const r = attemptOnce(rnd);
    if (!r) continue;
    const draft: Course = { ...course, line: r.line, cones: r.cones, start: r.start, finish: r.finish };
    const sim = simulate(r.line, course.settings.car, course.settings.wet);
    if (!sim) continue;
    const issues = checkCourse(draft, sim);
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warn").length;
    const score = errors * 100 + warnings * 12 + Math.abs(sim.lengthFt - opt.targetLengthFt) / 15 + Math.max(0, sim.maxMph - 58) * 8 + Math.max(0, 38 - sim.avgMph) * 2;
    if (!best || score < best.score) best = { ...r, score, errors, warnings, lengthFt: sim.lengthFt, timeS: sim.timeS, maxMph: sim.maxMph };
  }
  return best;

  function attemptOnce(rnd: () => number) {
    const range = (a: number, b: number) => a + rnd() * (b - a);

    // Start position: near the grid if there is one, otherwise anywhere safe.
    let startP: Pt | null = null;
    let startDir = 0;
    for (let i = 0; i < 400 && !startP; i++) {
      const p = { x: range(bb.minX, bb.maxX), y: range(bb.minY, bb.maxY) };
      if (!safe(p, 25)) continue;
      if (grid && i < 300) {
        const d = distToShape(p, grid.pts, true);
        if (d > 250 + i) continue;
      }
      for (let k = 0; k < 12; k++) {
        const dir = rnd() * Math.PI * 2;
        let ok = true;
        for (let s = 0; s <= 160; s += 10) if (!safe(add(p, scale(fromAngle(dir), s)), 25)) { ok = false; break; }
        if (ok) { startP = p; startDir = dir; break; }
      }
    }
    if (!startP) { if (opt.stats) opt.stats.noStart++; return null; }

    const nodes: Node[] = [{ p: startP, seg: "launch", segId: 0, side: 0, R: Infinity }];
    let pos = startP;
    let dir = startDir;
    let segId = 0;
    let straightRun = 0;
    let lastSide = rnd() < 0.5 ? 1 : -1;
    let length = 0;
    let bestCut: { idx: number; dir: number; pos: Pt; score: number } | null = null;

    const selfClear = (cand: Pt[], from: number) => {
      // keep 70 ft from earlier parts of the course (not the most recent 160 ft)
      const limit = nodes.length - Math.ceil(160 / STEP);
      for (const q of cand) {
        for (let i = 0; i < limit; i += 3) if (dist(q, nodes[i].p) < 70) return false;
        void from;
      }
      return true;
    };

    const buildStraight = (len: number): { pts: Pt[]; dir: number } => {
      const pts: Pt[] = [];
      for (let s = STEP; s <= len; s += STEP) pts.push(add(pos, scale(fromAngle(dir), s)));
      return { pts, dir };
    };
    const buildArc = (R: number, ang: number, side: number): { pts: Pt[]; dir: number } => {
      const center = add(pos, scale(perp(fromAngle(dir)), side * R));
      const a0 = Math.atan2(pos.y - center.y, pos.x - center.x);
      const pts: Pt[] = [];
      const n = Math.max(2, Math.ceil((R * ang) / STEP));
      for (let i = 1; i <= n; i++) {
        const a = a0 + side * (ang * i) / n;
        pts.push({ x: center.x + R * Math.cos(a), y: center.y + R * Math.sin(a) });
      }
      return { pts, dir: dir + side * ang };
    };

    const launch = buildStraight(range(70, 110));
    for (const p of launch.pts) nodes.push({ p, seg: "launch", segId, side: 0, R: Infinity });
    pos = launch.pts[launch.pts.length - 1];
    straightRun = launch.pts.length * STEP;
    length += straightRun;

    let stuck = 0;
    while (length < opt.targetLengthFt * 1.15 && stuck < 3) {
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
      let chosen: { seg: Seg; side: number; built: { pts: Pt[]; dir: number; R: number; weave?: number } } | null = null;
      for (let tryN = 0; tryN < 14 && !chosen; tryN++) {
        let roll = rnd() * tot;
        let seg: Seg = "turn";
        for (const [s, w] of weights) { roll -= Math.max(0, w); if (roll <= 0) { seg = s; break; } }
        // Later tries lean on tighter pieces, which fit where big ones don't.
        if (tryN >= 8) seg = (["turn", "kink", "hairpin", "turn", "straight", "kink"] as Seg[])[tryN - 8];
        const side = rnd() < 0.68 ? -lastSide : lastSide;
        let built: { pts: Pt[]; dir: number; R: number; weave?: number } | null = null;
        if (seg === "sweeper") { const R = range(65, 125); built = { ...buildArc(R, range(0.7, 2.0), side), R }; }
        else if (seg === "turn") { const R = range(32, 55); built = { ...buildArc(R, range(1.2, 1.75), side), R }; }
        else if (seg === "hairpin") { const R = range(28, 34); built = { ...buildArc(R, range(2.6, 3.1), side), R }; }
        else if (seg === "kink") { const R = range(140, 220); built = { ...buildArc(R, range(0.25, 0.45), side), R }; }
        else if (seg === "straight") built = { ...buildStraight(range(40, Math.max(50, 170 - straightRun))), R: Infinity };
        else if (seg === "slalom") {
          const spacing = range(60, 74);
          const count = 3 + Math.floor(rnd() * 3);
          built = { ...buildStraight(spacing * (count + 1)), R: Infinity, weave: spacing };
        }
        if (!built || !built.pts.every((p) => safe(p)) || !selfClear(built.pts, nodes.length)) continue;
        // Don't drive into a dead end: some room must remain ahead.
        const end = built.pts[built.pts.length - 1];
        let room = true;
        for (let s2 = 10; s2 <= 40; s2 += 10) if (!safe(add(end, scale(fromAngle(built.dir), s2)))) { room = false; break; }
        if (!room && tryN < 12) continue;
        chosen = { seg, side, built };
      }
      if (!chosen) { stuck++; continue; }
      const { seg, side, built } = chosen;
      stuck = 0;
      segId++;
      for (const p of built.pts) nodes.push({ p, seg, segId, side, R: built.weave ?? built.R });
      pos = built.pts[built.pts.length - 1];
      dir = built.dir;
      length += built.pts.length * STEP;
      if (seg === "straight" || seg === "slalom") straightRun += built.pts.length * STEP;
      else straightRun = seg === "kink" ? straightRun : 0;
      if (seg !== "straight" && seg !== "slalom") lastSide = side;

      // Could the course finish here? Need a finish straight + runout that's clear.
      if (length > opt.targetLengthFt * 0.5 && seg !== "slalom" && straightRun < 80) {
        const finLen = 70;
        const runout = 220;
        let fits = true;
        for (let s = STEP; s <= finLen + runout; s += 10) {
          const q = add(pos, scale(fromAngle(dir), s));
          if (!(s <= finLen ? safe(q) : safe(q, 12, 120)) || (s <= finLen && !selfClear([q], nodes.length))) { fits = false; break; }
        }
        if (fits) {
          const sc = Math.abs(length + finLen - opt.targetLengthFt);
          if (!bestCut || sc < bestCut.score) bestCut = { idx: nodes.length, dir, pos, score: sc };
        }
      }
    }
    if (opt.stats) opt.stats.lengths.push(Math.round(length));
    if (!bestCut) { if (opt.stats) opt.stats.noFinish++; return null; }

    const kept = nodes.slice(0, bestCut.idx);
    pos = bestCut.pos;
    dir = bestCut.dir;
    segId++;
    const fin = buildStraight(70);
    for (const p of fin.pts) kept.push({ p, seg: "finish", segId, side: 0, R: Infinity });
    const finishP = fin.pts[fin.pts.length - 1];

    return placeCones(kept, startDir, startP, dir, finishP, rnd);
  }
}

function placeCones(nodes: Node[], startDir: number, startP: Pt, finDir: number, finishP: Pt, rnd: () => number) {
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

  // Start and finish timing lines + finish chute.
  const sl = perp(fromAngle(startDir));
  const start = { a: add(startP, scale(sl, 14)), b: add(startP, scale(sl, -14)) };
  const fl = perp(fromAngle(finDir));
  const finish = { a: add(finishP, scale(fl, 18)), b: add(finishP, scale(fl, -18)) };
  const sg = uid("start"), fg = uid("finish");
  cones.push({ id: uid("c"), ...start.a, kind: "timing", group: "start", groupId: sg }, { id: uid("c"), ...start.b, kind: "timing", group: "start", groupId: sg });
  cones.push({ id: uid("c"), ...finish.a, kind: "timing", group: "finish", groupId: fg }, { id: uid("c"), ...finish.b, kind: "timing", group: "finish", groupId: fg });
  const fd = fromAngle(finDir);
  for (let s = 15; s <= 75; s += 12) {
    for (const side of [1, -1]) cones.push({ id: uid("c"), ...add(add(finishP, scale(fd, s)), scale(fl, side * 20)), kind: "standing", group: "wall" });
  }

  return { line: simplify(line, 0.4), cones, start, finish };
}
