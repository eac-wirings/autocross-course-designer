import { generateCourse } from "../src/generate";
import { newCourse, uid } from "../src/model";
import { checkCourse } from "../src/rules";
import { simulate } from "../src/sim";

const c = newCourse();
c.features.push({ id: uid(), kind: "paved", closed: true, pts: [{ x: -600, y: -350 }, { x: 600, y: -350 }, { x: 600, y: 350 }, { x: -600, y: 350 }] });
c.features.push({ id: uid(), kind: "pole", closed: false, pts: [{ x: 100, y: 50 }] });
c.features.push({ id: uid(), kind: "spectator", closed: true, pts: [{ x: -600, y: 350 }, { x: -300, y: 350 }, { x: -300, y: 420 }, { x: -600, y: 420 }] });
c.features.push({ id: uid(), kind: "grid", closed: true, pts: [{ x: 400, y: -350 }, { x: 600, y: -350 }, { x: 600, y: -420 }, { x: 400, y: -420 }] });
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
const tr = generateCourse(t, { targetLengthFt: 2500, seed: 7, attempts: 150, technical: 0.4 });
if (!tr) { console.error("Taxiway layout: no course generated"); process.exit(1); }
console.log("taxiways:", { len: Math.round(tr.lengthFt), errors: tr.errors, warns: tr.warnings });
