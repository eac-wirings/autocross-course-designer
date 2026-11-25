import { polygonArea } from "../src/geo";
import type { Feature } from "../src/model";
import { addArea, cutAway, smoothOutline, straightenEdge } from "../src/shapes";

const fail = (m: string) => { console.error("shapes smoke test FAILED:", m); process.exit(1); };
const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const lot: Feature = { id: "lot", kind: "paved", closed: true, pts: sq(0, 0, 100, 100) };

// Cut the right 40 ft off.
const cut = cutAway([lot], sq(60, -10, 120, 110), null);
if (cut.changed !== 1 || cut.features.length !== 1) fail("cut should change 1 zone into 1 piece");
if (Math.abs(polygonArea(cut.features[0].pts) - 6000) > 1) fail(`cut area ${polygonArea(cut.features[0].pts)} != 6000`);
if (cut.features[0].id !== "lot") fail("cut should keep the zone id");

// Cut a hole in the middle: becomes a Don't-use island.
const hole = cutAway([lot], sq(40, 40, 60, 60), ["lot"]);
if (!hole.features.some((f) => f.kind === "nogo")) fail("interior cut should create a Don't-use island");

// Cut straight through: two pieces.
const split = cutAway([lot], sq(45, -10, 55, 110), null);
if (split.features.length !== 2) fail(`split should give 2 pieces, got ${split.features.length}`);

// Add a bump.
const add = addArea([lot], sq(90, 40, 130, 60), null);
if (Math.abs(polygonArea(add.features[0].pts) - (10000 + 600)) > 1) fail("add area wrong");
const fresh = addArea([lot], sq(300, 300, 320, 320), null);
if (fresh.features.length !== 2 || !fresh.created) fail("add away from zones should create a new zone");

// Straighten: a jagged top edge collapses to one straight line.
const jag = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 80, y: 103 }, { x: 60, y: 96 }, { x: 40, y: 104 }, { x: 20, y: 97 }, { x: 0, y: 100 }];
const st = straightenEdge(jag, 2, 7);
if (st.length !== 4) fail(`straighten should leave 4 corners, got ${st.length}`);

// Smooth: 5 ft tolerance removes the wiggles.
if (smoothOutline(jag, 5).length !== 4) fail("smooth should reduce the jagged outline to 4 corners");
console.log("shapes smoke test passed");
