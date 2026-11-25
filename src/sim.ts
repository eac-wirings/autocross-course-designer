import { FT_PER_S_PER_MPH, G_FT, dist, signedRadius, smoothPath, type Pt } from "./geo";
import type { CarProfile } from "./model";

export interface SimSample {
  p: Pt;
  s: number; // distance along path, ft
  r: number; // signed radius, ft (Infinity = straight)
  v: number; // speed, ft/s
  t: number; // elapsed time, s
  accelerating: boolean;
}

export interface SimResult {
  samples: SimSample[];
  lengthFt: number;
  timeS: number;
  maxMph: number;
  avgMph: number;
  minRadius: number;
  finishMph: number;
}

const STEP = 2;
const RADIUS_WINDOW = 6; // samples each side (≈ 12 ft) for curvature estimate

/**
 * Point-mass lap simulation: cornering limit v = sqrt(latG·g·R), forward pass
 * with speed-dependent acceleration, backward pass with braking. Good enough to
 * catch over-speed sections and long acceleration zones; not a vehicle model.
 */
export function simulate(line: Pt[], car: CarProfile, wet = false): SimResult | null {
  if (line.length < 2) return null;
  const pts = smoothPath(line, STEP);
  if (pts.length < 3) return null;
  const grip = wet ? 0.7 : 1;
  const n = pts.length;
  const s: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + dist(pts[i - 1], pts[i]);

  const radius: number[] = pts.map((_, i) => {
    const a = pts[Math.max(0, i - RADIUS_WINDOW)];
    const c = pts[Math.min(n - 1, i + RADIUS_WINDOW)];
    if (a === pts[i] || c === pts[i]) return Infinity;
    return signedRadius(a, pts[i], c);
  });

  const vTop = car.topMph * FT_PER_S_PER_MPH;
  const vCorner = radius.map((r) => Math.min(vTop, Math.sqrt(car.latG * grip * G_FT * Math.abs(r))));

  const v = new Array(n).fill(0);
  const acc = new Array(n).fill(false);
  v[0] = 0;
  for (let i = 1; i < n; i++) {
    const ds = s[i] - s[i - 1];
    const a = car.accelG * Math.min(grip, 1) * G_FT * Math.max(0.05, 1 - v[i - 1] / vTop);
    const vNext = Math.sqrt(v[i - 1] * v[i - 1] + 2 * a * ds);
    v[i] = Math.min(vNext, vCorner[i]);
    acc[i] = vNext <= vCorner[i] + 1e-6;
  }
  const brake = car.brakeG * grip * G_FT;
  for (let i = n - 2; i >= 0; i--) {
    const ds = s[i + 1] - s[i];
    const vMax = Math.sqrt(v[i + 1] * v[i + 1] + 2 * brake * ds);
    if (v[i] > vMax) {
      v[i] = vMax;
      acc[i] = false;
    }
  }

  const samples: SimSample[] = [];
  let t = 0;
  let maxV = 0;
  let minR = Infinity;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const vAvg = (v[i] + v[i - 1]) / 2;
      t += (s[i] - s[i - 1]) / Math.max(vAvg, 1);
    }
    maxV = Math.max(maxV, v[i]);
    if (i > RADIUS_WINDOW && i < n - RADIUS_WINDOW) minR = Math.min(minR, Math.abs(radius[i]));
    samples.push({ p: pts[i], s: s[i], r: radius[i], v: v[i], t, accelerating: acc[i] });
  }
  const lengthFt = s[n - 1];
  return {
    samples,
    lengthFt,
    timeS: t,
    maxMph: maxV / FT_PER_S_PER_MPH,
    avgMph: lengthFt / t / FT_PER_S_PER_MPH,
    minRadius: minR,
    finishMph: v[n - 1] / FT_PER_S_PER_MPH,
  };
}

/** Distance to stop from v (ft/s) on the given surface. */
export function stoppingDistance(vFt: number, brakeG: number, wet: boolean) {
  const g = brakeG * (wet ? 0.55 : 0.8) * G_FT; // assume a cautious, not limit, stop after the finish
  return (vFt * vFt) / (2 * g);
}
