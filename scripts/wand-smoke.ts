// Synthetic aerial: a gray lot with paint stripes, an oil stain, a grass island
// and a thin road leaking off one edge, on a green background.
import { prepareImage, runWand } from "../src/wand";

const W = 220, H = 160;
const px = new Uint8ClampedArray(W * H * 4);
let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 12; };
const set = (x: number, y: number, r: number, g: number, b: number) => {
  const i = (y * W + x) * 4;
  px[i] = r + noise(); px[i + 1] = g + noise(); px[i + 2] = b + noise(); px[i + 3] = 255;
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const lot = x >= 20 && x < 170 && y >= 20 && y < 120;
  const island = x >= 60 && x < 100 && y >= 50 && y < 80;
  const road = x >= 170 && y >= 60 && y < 63; // 3 px wide leak to the border
  const stripe = lot && !island && x % 18 === 0;
  const oil = x >= 130 && x < 134 && y >= 95 && y < 99;
  if (lot && !island) {
    if (stripe) set(x, y, 235, 235, 230);
    else if (oil) set(x, y, 70, 70, 72);
    else set(x, y, 112, 112, 115);
  } else if (road) set(x, y, 112, 112, 115);
  else set(x, y, 62, 112, 48);
}

const img = prepareImage(px, W, H);
const shapes = runWand(img, [{ x: 30, y: 30 }]);
const fail = (m: string) => { console.error("wand smoke test FAILED:", m); process.exit(1); };
if (shapes.length !== 1) fail(`expected 1 shape, got ${shapes.length}`);
const s = shapes[0];
const xs = s.outer.map((p) => p[0]), ys = s.outer.map((p) => p[1]);
const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
console.log({ corners: s.outer.length, bbox: [minX, minY, maxX, maxY], holes: s.holes.length, areaPx: s.areaPx });
if (Math.abs(minX - 20) > 3 || Math.abs(maxX - 170) > 3 || Math.abs(minY - 20) > 3 || Math.abs(maxY - 120) > 3) fail("outline does not match the lot (road leak not cut?)");
if (s.outer.length > 12) fail(`outline has ${s.outer.length} corners; expected a simple rectangle`);
if (s.holes.length !== 1) fail(`expected the grass island as 1 hole, got ${s.holes.length}`);
if (Math.abs(s.areaPx - (150 * 100 - 40 * 30)) > 600) fail(`area ${s.areaPx} far from expected`);
console.log("wand smoke test passed");
