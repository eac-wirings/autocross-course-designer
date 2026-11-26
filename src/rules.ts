import {
  FT_PER_S_PER_MPH,
  add,
  dist,
  distToPath,
  distToShape,
  fromAngle,
  heading,
  lerp,
  pointInPolygon,
  scale,
  type Pt,
} from "./geo";
import { FEATURE_INFO, type Course, type Feature, type FeatureKind } from "./model";
import { stoppingDistance, type SimResult } from "./sim";

export type Severity = "error" | "warn" | "info";

export interface Issue {
  severity: Severity;
  title: string;
  detail: string;
  at?: Pt;
}

const CAR_HALF_WIDTH = 3.25;
const PEOPLE_KINDS: FeatureKind[] = ["spectator", "paddock", "grid", "timing", "registration", "tech", "restroom", "firstaid", "impound"];
const SOLID_KINDS: FeatureKind[] = ["obstacle", "pole", "curb"];

interface CoursePoint {
  p: Pt;
  /** Extra clearance to subtract: car half-width for line samples, 0 for cones. */
  pad: number;
  mph: number;
  what: string;
}

function coursePoints(c: Course, sim: SimResult | null): CoursePoint[] {
  const out: CoursePoint[] = c.cones.map((k) => ({ p: k, pad: 0, mph: 0, what: "cone" }));
  if (sim) {
    for (let i = 0; i < sim.samples.length; i += 3) {
      const s = sim.samples[i];
      out.push({ p: s.p, pad: CAR_HALF_WIDTH, mph: s.v / FT_PER_S_PER_MPH, what: "driving line" });
    }
  }
  for (const l of [c.start, c.finish]) if (l) out.push({ p: l.a, pad: 0, mph: 0, what: "timing" }, { p: l.b, pad: 0, mph: 0, what: "timing" });
  return out;
}

function closest(points: CoursePoint[], f: Feature) {
  let best: { d: number; cp: CoursePoint } | null = null;
  for (const cp of points) {
    const d = distToShape(cp.p, f.pts, f.closed) - cp.pad;
    if (!best || d < best.d) best = { d, cp };
  }
  return best;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

export interface Runout {
  /** Finish line midpoint and the direction cars leave it (from the last part of the driving line). */
  fp: Pt;
  dir: number;
  /** Distance needed to stop safely, and clear distance straight ahead. */
  need: number;
  free: number;
  blocker: string;
  /** The zone or object that cut the runout short, if any. */
  blockerId?: string;
  finishMph: number;
}

/** How far a car can coast straight past the finish before pavement ends or something is in the way. */
export function finishRunout(c: Course, sim: SimResult | null): Runout | null {
  if (!sim || sim.samples.length < 2) return null;
  const paved = c.features.filter((f) => f.kind === "paved" && f.pts.length >= 3);
  const last = sim.samples[sim.samples.length - 1];
  const prev = sim.samples[Math.max(0, sim.samples.length - 8)];
  const fp = c.finish ? lerp(c.finish.a, c.finish.b, 0.5) : last.p;
  const dir = heading(prev.p, last.p);
  const need = stoppingDistance(Math.max(last.v, 30 * FT_PER_S_PER_MPH), c.settings.car.brakeG, c.settings.wet) * 1.3 + 40;
  let free = 0;
  let blocker = "";
  let blockerId: string | undefined;
  for (let d = 0; d <= 1200; d += 5) {
    const q = add(fp, scale(fromAngle(dir), d));
    if (paved.length && !paved.some((f) => pointInPolygon(q, f.pts))) { blocker = "end of the Course area"; break; }
    // Margins: people 75 ft, solid objects 25 ft, Don't-use zones (usually grass) 10 ft.
    const margin = (f: Feature) => (PEOPLE_KINDS.includes(f.kind) ? 75 : f.kind === "nogo" ? 10 : 25);
    const hit = c.features.find((f) => f.kind !== "paved" && f.kind !== "worker" && f.kind !== "extinguisher" && f.kind !== "emergency" && distToShape(q, f.pts, f.closed) < margin(f));
    if (hit) { blocker = hit.label || FEATURE_INFO[hit.kind].label; blockerId = hit.id; break; }
    free = d;
    if (d >= need + 200) break;
  }
  return { fp, dir, need, free, blocker, blockerId, finishMph: sim.finishMph };
}

export function checkCourse(c: Course, sim: SimResult | null): Issue[] {
  const issues: Issue[] = [];
  const st = c.settings;
  const pts = coursePoints(c, sim);
  const paved = c.features.filter((f) => f.kind === "paved" && f.pts.length >= 3);

  // --- Setup completeness -------------------------------------------------
  if (paved.length === 0) issues.push({ severity: "warn", title: "No course area defined", detail: "Use Zones → Course area to outline where the course may go, so the checker can confirm everything stays on it." });
  if (c.line.length < 2) issues.push({ severity: "warn", title: "No driving line", detail: "Draw the intended driving line from start to finish. Speed, margin, and 3D checks depend on it." });
  if (!c.start) issues.push({ severity: "warn", title: "No start line", detail: "Place the start timing line." });
  if (!c.finish) issues.push({ severity: "warn", title: "No finish line", detail: "Place the finish timing line." });
  if (!c.features.some((f) => f.kind === "worker")) issues.push({ severity: "info", title: "No worker stations", detail: "Plan worker stations during layout, not as an afterthought." });
  const missing = (["timing", "firstaid", "extinguisher", "emergency"] as FeatureKind[]).filter((k) => !c.features.some((f) => f.kind === k));
  if (c.line.length > 1 && missing.length) issues.push({ severity: "info", title: `Site plan: no ${missing.map((k) => FEATURE_INFO[k].label.toLowerCase()).join(", ")}`, detail: "Mark these in Site map → Event facilities so the site plan is complete." });

  // --- Stays on pavement --------------------------------------------------
  if (paved.length) {
    let offCount = 0;
    let firstOff: CoursePoint | null = null;
    for (const cp of pts) {
      if (!paved.some((f) => pointInPolygon(cp.p, f.pts))) {
        offCount++;
        firstOff ??= cp;
      }
    }
    if (firstOff) issues.push({ severity: "error", title: "Course leaves the course area", detail: `${offCount} course point(s) are outside the course area, first: ${firstOff.what}.`, at: firstOff.p });

    // Fast sections close to the pavement edge: cars slide much farther on grass/dirt.
    if (sim) {
      let worst: { p: Pt; d: number; mph: number } | null = null;
      for (const cp of pts) {
        if (cp.mph < 45) continue;
        const d = Math.min(...paved.map((f) => distToPath(cp.p, f.pts, true))) - cp.pad;
        const need = 15 + (cp.mph - 45) * 2;
        if (d < need && (!worst || d < worst.d)) worst = { p: cp.p, d, mph: cp.mph };
      }
      if (worst) issues.push({ severity: "warn", title: "Fast section near pavement edge", detail: `${fmt(worst.mph)} mph only ${fmt(worst.d)} ft from the edge. A car leaving pavement slides much farther.`, at: worst.p });
    }
  }

  // --- Solid objects: 25 ft (50 ft with karts, except curbs) ---------------
  for (const f of c.features.filter((f) => SOLID_KINDS.includes(f.kind))) {
    const min = st.karts && f.kind !== "curb" ? 50 : 25;
    const r = closest(pts, f);
    if (!r) continue;
    const name = f.label || FEATURE_INFO[f.kind].label;
    if (r.d < min) {
      issues.push({ severity: "error", title: `${name}: ${fmt(Math.max(0, r.d))} ft from course`, detail: `Solo Rules require at least ${min} ft from the course to solid objects${st.karts && f.kind !== "curb" ? " when karts run" : ""}.`, at: r.cp.p });
    } else if (r.cp.mph > 50 && r.d < min + (r.cp.mph - 45) * 2.5) {
      issues.push({ severity: "warn", title: `${name}: tight for the speed`, detail: `${fmt(r.d)} ft clearance at about ${fmt(r.cp.mph)} mph. Sliding distance grows with the square of speed; give fast sections extra room.`, at: r.cp.p });
    }
  }

  // --- People: 75 ft -------------------------------------------------------
  for (const f of c.features.filter((f) => PEOPLE_KINDS.includes(f.kind))) {
    const r = closest(pts, f);
    if (!r) continue;
    const name = f.label || FEATURE_INFO[f.kind].label;
    if (r.d < 75) issues.push({ severity: "error", title: `${name}: ${fmt(Math.max(0, r.d))} ft from course`, detail: "Solo Rules require at least 75 ft to unprotected viewing areas; keep paddock and grid just as clear.", at: r.cp.p });
    else if (r.cp.mph > 50 && r.d < 110) issues.push({ severity: "warn", title: `${name}: fast content nearby`, detail: `${fmt(r.cp.mph)} mph content ${fmt(r.d)} ft away. Move higher-speed elements away from people.`, at: r.cp.p });
  }

  // --- Surface hazards -------------------------------------------------------
  for (const f of c.features.filter((f) => f.kind === "surface")) {
    const r = closest(pts, f);
    if (r && r.d < 4) issues.push({ severity: "error", title: `${f.label || "Surface hazard"} on the course`, detail: "Route around holes, grates, manholes, gravel and broken pavement, even if it only takes moving a cone or two.", at: r.cp.p });
  }

  // --- Don't-use zones ------------------------------------------------------
  for (const f of c.features.filter((f) => f.kind === "nogo" && f.pts.length >= 3)) {
    const r = closest(pts, f);
    if (!r) continue;
    const name = f.label || "Don't-use zone";
    if (r.d <= 0) issues.push({ severity: "error", title: `Course enters ${name}`, detail: `A ${r.cp.what} is inside an area marked as off limits.`, at: r.cp.p });
    else if (r.d < 10) issues.push({ severity: "warn", title: `${name}: only ${fmt(r.d)} ft away`, detail: "Leave some room so a car that runs wide doesn't end up in the off-limits area.", at: r.cp.p });
  }

  // --- Speed -----------------------------------------------------------------
  if (sim) {
    const maxS = sim.samples.reduce((a, b) => (b.v > a.v ? b : a));
    if (sim.maxMph > 65) issues.push({ severity: "error", title: `Top speed about ${fmt(sim.maxMph)} mph`, detail: `The fastest Street cars should not normally exceed the mid 60s. Shorten the acceleration zone or add a direction change.`, at: maxS.p });
    else if (sim.maxMph > 60) issues.push({ severity: "warn", title: `Top speed about ${fmt(sim.maxMph)} mph`, detail: "Close to the mid-60s ceiling for fast Street cars.", at: maxS.p });

    // Long pure-acceleration zones
    let runStart = -1;
    for (let i = 0; i <= sim.samples.length; i++) {
      const s = sim.samples[i];
      const accel = s && s.accelerating && Math.abs(s.r) > 150;
      if (accel && runStart < 0) runStart = i;
      if (!accel && runStart >= 0) {
        const a = sim.samples[runStart];
        const b = sim.samples[i - 1];
        const len = b.s - a.s;
        if (len >= 200) issues.push({ severity: len >= 250 ? "warn" : "info", title: `${fmt(len)} ft of pure acceleration`, detail: "Anything that looks like acceleration for 200–250 ft or more should be scrutinized, especially after a fast element.", at: lerp(a.p, b.p, 0.5) });
        runStart = -1;
      }
    }

    if (sim.minRadius < 20) {
      const tight = sim.samples.reduce((a, b) => (Math.abs(b.r) < Math.abs(a.r) ? b : a));
      issues.push({ severity: "warn", title: `Very tight turn (${fmt(sim.minRadius * 2)} ft diameter)`, detail: "Typical street cars turn in a 30–42 ft circle curb-to-curb. Tight turnarounds are rarely fun; give room to set up.", at: tight.p });
    }

    // Driving line clipping cones
    let clip = 0;
    let clipAt: Pt | undefined;
    for (const k of c.cones) {
      if (k.group === "start" || k.group === "finish") continue;
      let d = Infinity;
      for (let i = 0; i < sim.samples.length; i += 2) d = Math.min(d, dist(k, sim.samples[i].p));
      if (d < CAR_HALF_WIDTH + 0.5) {
        clip++;
        clipAt ??= k;
      }
    }
    if (clip) issues.push({ severity: "warn", title: `Driving line hits ${clip} cone(s)`, detail: "The drawn line passes through cones; move the line or the cones so the intended path is drivable.", at: clipAt });

    // Adjacent sections
    const step = 5;
    let worst: { d: number; p: Pt } | null = null;
    const S = sim.samples.filter((_, i) => i % step === 0);
    for (let i = 0; i < S.length; i++) {
      for (let j = i + 1; j < S.length; j++) {
        if (S[j].s - S[i].s < 250) continue;
        const d = dist(S[i].p, S[j].p) - 2 * CAR_HALF_WIDTH;
        if (d < 75 && (!worst || d < worst.d)) worst = { d, p: lerp(S[i].p, S[j].p, 0.5) };
      }
    }
    if (worst) {
      const sev: Severity = st.multipleCarsOnCourse ? "error" : "info";
      issues.push({ severity: sev, title: `Adjacent sections ${fmt(Math.max(0, worst.d))} ft apart`, detail: st.multipleCarsOnCourse ? "With more than one car on course, separate adjacent sections by at least 75 ft and don't aim them at each other." : "Fine with one car on course; needs 75 ft if you run multiple cars.", at: worst.p });
    }

    // Finish runout and aim
    const { fp, dir, need, free, blocker } = finishRunout(c, sim)!;
    if (free < need) issues.push({ severity: "error", title: `Finish runout ${fmt(free)} ft (need ~${fmt(need)} ft)`, detail: `Finish speed ≈ ${fmt(sim.finishMph)} mph. ${blocker ? `Runout is cut short by ${blocker}. ` : ""}Stopping from 60 mph can take well over 100 ft, far more in the wet.`, at: fp });

    for (const off of [-0.26, 0, 0.26]) {
      for (let d = 0; d <= 500; d += 10) {
        const q = add(fp, scale(fromAngle(dir + off), d));
        const hit = c.features.find((f) => PEOPLE_KINDS.includes(f.kind) && distToShape(q, f.pts, f.closed) === 0);
        if (hit) {
          issues.push({ severity: "error", title: `Finish aims at ${hit.label || FEATURE_INFO[hit.kind].label}`, detail: `A car that can't stop would reach it within ${d} ft. Don't aim the finish at viewing, grid or paddock areas.`, at: q });
          break;
        }
      }
    }

    // Worker coverage
    const workers = c.features.filter((f) => f.kind === "worker" && f.pts.length);
    if (workers.length) {
      let uncovered = 0;
      let at: Pt | undefined;
      for (let i = 0; i < sim.samples.length; i += 10) {
        const s = sim.samples[i];
        if (!workers.some((w) => dist(w.pts[0], s.p) < 175)) { uncovered++; at ??= s.p; }
      }
      if (uncovered) issues.push({ severity: "warn", title: "Course not covered by workers", detail: "Some parts of the course are more than ~175 ft from any worker station; workers must reach displaced cones in seconds.", at });
      for (const w of workers) {
        const d = Math.min(...sim.samples.map((s) => dist(s.p, w.pts[0])));
        if (d < 30) issues.push({ severity: "warn", title: `${w.label || "Worker station"} only ${fmt(d)} ft from the line`, detail: "Put stations on the inside of turns or behind slalom/gate cones, where cars are heading away from workers.", at: w.pts[0] });
      }
    }

    // Turn direction mix
    let left = 0, right = 0;
    for (const s of sim.samples) if (Math.abs(s.r) < 120) (s.r > 0 ? left++ : right++);
    const total = left + right;
    if (total > 50 && (left / total < 0.25 || right / total < 0.25)) issues.push({ severity: "info", title: "Unbalanced turn directions", detail: `About ${Math.round((left / total) * 100)}% left / ${Math.round((right / total) * 100)}% right turning. Mix lefts and rights for fairness.` });

    issues.push({ severity: "info", title: `Estimated run: ${sim.timeS.toFixed(1)} s, ${fmt(sim.lengthFt)} ft`, detail: `${c.settings.car.name}${st.wet ? " (wet)" : ""}: average ${sim.avgMph.toFixed(1)} mph, top ${sim.maxMph.toFixed(1)} mph. Big sites usually average in the 40s.` });
  }

  // --- Cone element checks -----------------------------------------------------
  const groups = new Map<string, typeof c.cones>();
  for (const k of c.cones) if (k.groupId) groups.set(k.groupId, [...(groups.get(k.groupId) ?? []), k]);
  for (const g of groups.values()) {
    const type = g[0].group;
    if (type === "slalom" && g.length >= 2) {
      let minGap = Infinity, maxGap = 0;
      for (let i = 1; i < g.length; i++) {
        const d = dist(g[i - 1], g[i]);
        minGap = Math.min(minGap, d);
        maxGap = Math.max(maxGap, d);
      }
      if (minGap < 45) issues.push({ severity: st.nationalsLevel ? "error" : "warn", title: `Slalom spacing ${fmt(minGap)} ft`, detail: "Solo Rules minimum is 45 ft; 60–75 ft is the sweet spot for modern cars.", at: g[0] });
      else if (minGap < 60) issues.push({ severity: "info", title: `Slalom spacing ${fmt(minGap)} ft`, detail: "Legal, but 60–75 ft is friendlier to modern, heavier cars.", at: g[0] });
      if (maxGap >= 80) issues.push({ severity: "warn", title: `Fast slalom (${fmt(maxGap)} ft spacing)`, detail: "Slaloms around 80 ft or larger are high-speed transients; position them with extra margin.", at: g[0] });
    }
    if (type === "gate" && g.length === 2) {
      const w = dist(g[0], g[1]);
      if (w < 15) issues.push({ severity: st.nationalsLevel ? "error" : "warn", title: `Gate only ${fmt(w)} ft wide`, detail: "Solo Rules call for at least 15 ft of course width; modern cars are 6+ ft wide.", at: g[0] });
    }
  }

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}
