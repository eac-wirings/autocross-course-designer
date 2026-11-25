import { newCourse, uid } from "../src/model";
import { checkCourse } from "../src/rules";
import { simulate } from "../src/sim";
const c = newCourse();
c.features.push({ id: uid(), kind: "paved", closed: true, pts: [{ x: -100, y: -100 }, { x: 900, y: -100 }, { x: 900, y: 100 }, { x: -100, y: 100 }] });
c.features.push({ id: uid(), kind: "pole", closed: false, pts: [{ x: 300, y: 15 }] });
c.features.push({ id: uid(), kind: "spectator", closed: true, pts: [{ x: 950, y: -50 }, { x: 1050, y: -50 }, { x: 1050, y: 50 }, { x: 950, y: 50 }] });
c.line = [{ x: 0, y: 0 }, { x: 700, y: 0 }];
c.finish = { a: { x: 700, y: -15 }, b: { x: 700, y: 15 } };
c.cones.push({ id: uid(), x: 100, y: 0, kind: "standing" });
c.cones.push({ id: "a", x: 200, y: 10, kind: "standing", group: "slalom", groupId: "s" }, { id: "b", x: 230, y: 10, kind: "standing", group: "slalom", groupId: "s" });
const issues = checkCourse(c, simulate(c.line, c.settings.car));
for (const i of issues) console.log(i.severity.padEnd(5), i.title);
const expect = [/Light pole.*ft from course/, /Top speed/, /Finish runout/, /Finish aims at/, /Slalom spacing/, /hits 1 cone/];
const missing = expect.filter((re) => !issues.some((i) => re.test(i.title)));
if (missing.length) { console.error("Checker missed:", missing.map(String)); process.exit(1); }
console.log("rules smoke test passed");