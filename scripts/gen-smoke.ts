import { generateCourse } from "../src/generate";
import { newCourse, uid } from "../src/model";
import { checkCourse } from "../src/rules";
import { simulate } from "../src/sim";

const c = newCourse();
c.features.push({ id: uid(), kind: "paved", closed: true, pts: [{ x: -600, y: -350 }, { x: 600, y: -350 }, { x: 600, y: 350 }, { x: -600, y: 350 }] });
c.features.push({ id: uid(), kind: "pole", closed: false, pts: [{ x: 100, y: 50 }] });
c.features.push({ id: uid(), kind: "spectator", closed: true, pts: [{ x: -600, y: 350 }, { x: -300, y: 350 }, { x: -300, y: 420 }, { x: -600, y: 420 }] });
c.features.push({ id: uid(), kind: "grid", closed: true, pts: [{ x: 400, y: -350 }, { x: 600, y: -350 }, { x: 600, y: -420 }, { x: 400, y: -420 }] });
c.start = { a: { x: -400, y: -214 }, b: { x: -400, y: -186 } };
c.finish = { a: { x: 250, y: 182 }, b: { x: 250, y: 218 } };
const t0 = Date.now();
const r = generateCourse(c, { targetLengthFt: 3000, seed: 42, attempts: 40, technical: 0.4 });
console.log("ms", Date.now() - t0);
if (!r) { console.log("FAILED"); process.exit(1); }
console.log({ len: Math.round(r.lengthFt), time: r.timeS.toFixed(1), max: r.maxMph.toFixed(1), errors: r.errors, warns: r.warnings, cones: r.cones.length, linePts: r.line.length });
const d = { ...c, ...r };
const sim = simulate(r.line, c.settings.car)!;
for (const i of checkCourse(d, sim)) console.log(i.severity.padEnd(5), i.title, "|", i.detail.slice(0, 90));if (r.errors > 0) { console.error("Generated course has rule errors"); process.exit(1); }

// Narrow taxiways: a 1600x1000 ft area with three big grass islands leaves ~110 ft wide lanes.
// Before 0.4.2 this failed every attempt.
const t = newCourse();
t.features.push({ id: uid(), kind: "paved", closed: true, pts: [{ x: 0, y: 0 }, { x: 1600, y: 0 }, { x: 1600, y: 1000 }, { x: 0, y: 1000 }] });
for (const [x0, x1] of [[110, 480], [590, 1010], [1120, 1490]]) t.features.push({ id: uid(), kind: "nogo", closed: true, label: "Island", pts: [{ x: x0, y: 110 }, { x: x1, y: 110 }, { x: x1, y: 890 }, { x: x0, y: 890 }] });
t.start = { a: { x: 300, y: 41 }, b: { x: 300, y: 69 } };
t.finish = { a: { x: 1000, y: 927 }, b: { x: 1000, y: 963 } };
const tr = generateCourse(t, { seed: 7, attempts: 150, technical: 0.4 });
if (!tr) { console.error("Taxiway layout: no course generated"); process.exit(1); }
console.log("taxiways:", { len: Math.round(tr.lengthFt), errors: tr.errors, warns: tr.warnings });

// Crossovers: same open lot, allowed vs not.
const cx = generateCourse(c, { seed: 5, attempts: 150, technical: 0.4, allowCrossovers: true });
const nx = generateCourse(c, { seed: 5, attempts: 150, technical: 0.4, allowCrossovers: false });
if (!cx || !nx) { console.error("crossover runs failed"); process.exit(1); }
if (nx.crossovers !== 0) { console.error("crossovers when not allowed"); process.exit(1); }
console.log("crossovers allowed:", cx.crossovers, "len", Math.round(cx.lengthFt), "errors", cx.errors);
// Start and finish are the ones placed, untouched.
if (r.start !== c.start || r.finish !== c.finish) { console.error("generator moved the timing lines"); process.exit(1); }
// No start/finish: refuses with a reason.
const none = newCourse(); none.features = c.features; const st = { noStart: 0, noFinish: 0, lengths: [] as number[] } as import("../src/generate").GenStats;
if (generateCourse(none, { seed: 1, attempts: 5, technical: 0.4, stats: st }) || st.reason !== "gates") { console.error("should require start and finish"); process.exit(1); }
