// Renders a course as a picture with aerial imagery behind it (for Link to event:
// email, social media, the dashboard). Falls back to the plain SVG if imagery
// can't be loaded (offline).
import { smoothPath, toLatLng, type Pt } from "./geo";
import { FEATURE_INFO, type Course } from "./model";

const TILE_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const MAX_TILE_ZOOM = 19;
const TARGET_WIDTH = 2000;

const lon2x = (lng: number, z: number) => ((lng + 180) / 360) * 256 * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile failed: ${url}`));
    img.src = url;
  });
}

export interface RenderedImage { mime: "image/jpeg"; base64: string; width: number; height: number }

/** Draws the course over aerial imagery. Throws if the imagery can't be fetched. */
export async function renderCourseImage(course: Course, title: string, subtitle: string): Promise<RenderedImage> {
  const o = course.origin;
  const pts: Pt[] = [...course.cones, ...course.line];
  if (course.start) pts.push(course.start.a, course.start.b);
  if (course.finish) pts.push(course.finish.a, course.finish.b);
  const area = pts.length ? pts : course.features.flatMap((f) => f.pts);
  if (!area.length) throw new Error("Nothing to draw");
  const pad = 80; // ft
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of area) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const nw = toLatLng({ x: minX, y: maxY }, o);
  const se = toLatLng({ x: maxX, y: minY }, o);

  // Zoom at which the course spans about TARGET_WIDTH pixels; render at that zoom, capped at what imagery has.
  const widthAt0 = lon2x(se.lng, 0) - lon2x(nw.lng, 0);
  const heightAt0 = lat2y(se.lat, 0) - lat2y(nw.lat, 0);
  const zExact = Math.log2(TARGET_WIDTH / Math.max(widthAt0, heightAt0 * 1.33));
  // Fetch tiles one level sharper than needed and scale down; above the imagery's limit, scale up (max 2x).
  const z = Math.max(1, Math.min(MAX_TILE_ZOOM, Math.ceil(zExact)));
  const scale = Math.min(2, 2 ** (zExact - z));

  const x0 = lon2x(nw.lng, z), y0 = lat2y(nw.lat, z), x1 = lon2x(se.lng, z), y1 = lat2y(se.lat, z);
  const header = 90;
  const W = Math.round((x1 - x0) * scale), H = Math.round((y1 - y0) * scale) + header;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);

  // Imagery tiles.
  const tiles: Promise<void>[] = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) {
      tiles.push(loadImage(TILE_URL(z, tx, ty)).then((img) => {
        ctx.drawImage(img, (tx * 256 - x0) * scale, (ty * 256 - y0) * scale + header, 256 * scale, 256 * scale);
      }));
    }
  }
  const results = await Promise.allSettled(tiles);
  if (results.every((r) => r.status === "rejected")) throw new Error("Imagery unavailable");

  const px = (p: Pt) => {
    const q = toLatLng(p, o);
    return { x: (lon2x(q.lng, z) - x0) * scale, y: (lat2y(q.lat, z) - y0) * scale + header };
  };
  const ftPerPx = (minX - maxX) / -(W); // horizontal feet per pixel
  const conePx = Math.max(7, Math.min(22, 4 / ftPerPx));
  const path = (ps: Pt[], close = false) => {
    ctx.beginPath();
    ps.forEach((p, i) => { const q = px(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    if (close) ctx.closePath();
  };

  // Light shade so the course stands out from the photo.
  ctx.fillStyle = "rgba(15,23,42,0.18)";
  ctx.fillRect(0, header, W, H - header);

  // Site features.
  for (const f of course.features) {
    const info = FEATURE_INFO[f.kind];
    if (f.pts.length >= 3 && f.closed) {
      path(f.pts, true);
      if (f.kind === "paved") { ctx.setLineDash([12, 8]); ctx.strokeStyle = info.color; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = info.color + (f.kind === "nogo" ? "55" : "40"); ctx.fill(); ctx.strokeStyle = info.color; ctx.lineWidth = 1.5; ctx.stroke(); }
    } else if (f.pts.length >= 2) {
      path(f.pts); ctx.strokeStyle = info.color; ctx.lineWidth = 4; ctx.stroke();
    } else if (f.pts.length === 1 && f.kind === "worker") {
      const q = px(f.pts[0]);
      ctx.beginPath(); ctx.arc(q.x, q.y, conePx * 0.7, 0, Math.PI * 2); ctx.fillStyle = info.color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
  }

  // Driving line: smooth, cased, with arrows.
  if (course.line.length >= 2) {
    const s = smoothPath(course.line, 2);
    path(s); ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(15,23,42,0.6)"; ctx.lineWidth = Math.max(6, conePx * 0.75); ctx.stroke();
    path(s); ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = Math.max(3, conePx * 0.4); ctx.stroke();
    const every = Math.max(80, 140 * ftPerPx);
    let acc = 0;
    for (let i = 1; i < s.length; i++) {
      acc += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
      if (acc < every) continue;
      acc = 0;
      const a = px(s[i - 1]), b = px(s[i]);
      const ang = Math.atan2(b.y - a.y, b.x - a.x), r = conePx * 0.8;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(-r * 0.7, r * 0.7); ctx.lineTo(-r * 0.3, 0); ctx.lineTo(-r * 0.7, -r * 0.7); ctx.closePath();
      ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#0f172a"; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
    }
  }

  // Cones.
  for (const k of course.cones) {
    const q = px(k);
    const fill = k.kind === "timing" ? "#22c55e" : "#f97316";
    ctx.save(); ctx.translate(q.x, q.y);
    if (k.kind === "pointer") {
      ctx.rotate(-(k.rot ?? 0));
      const r = conePx * 0.75;
      ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(-r, r * 0.6); ctx.lineTo(-r, -r * 0.6); ctx.closePath();
    } else {
      const r = conePx / 2;
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, r * 0.8); ctx.lineTo(-r, r * 0.8); ctx.closePath();
    }
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#7c2d12"; ctx.stroke(); ctx.restore();
  }

  // Start / finish bars with labels.
  for (const [l, label, color] of [[course.start, "START", "#22c55e"], [course.finish, "FINISH", "#ef4444"]] as const) {
    if (!l) continue;
    const a = px(l.a), b = px(l.b);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = color; ctx.lineWidth = Math.max(5, conePx * 0.5); ctx.stroke();
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - conePx * 2 };
    ctx.font = `bold ${Math.round(Math.max(16, conePx * 1.2))}px system-ui, sans-serif`;
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = color; ctx.fillRect(m.x - w / 2, m.y - 14, w, 26);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, m.x, m.y);
  }

  // Header: title, details, legend.
  ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, W, header);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff"; ctx.font = "bold 34px system-ui, sans-serif"; ctx.fillText(title, 24, 44);
  ctx.fillStyle = "#cbd5e1"; ctx.font = "20px system-ui, sans-serif"; ctx.fillText(subtitle, 24, 74);
  const legend: [string, string][] = [["#38bdf8", "Driving line"], ["#f97316", "Cone"], ["#22c55e", "Start"], ["#ef4444", "Finish"], ["#e11d48", "Don't use"]];
  ctx.font = "18px system-ui, sans-serif";
  let lx = W - 24;
  for (const [c, t] of legend.reverse()) {
    const w = ctx.measureText(t).width;
    lx -= w; ctx.fillStyle = "#e2e8f0"; ctx.fillText(t, lx, 50);
    lx -= 22; ctx.fillStyle = c; ctx.fillRect(lx, 37, 14, 14);
    lx -= 22;
  }

  // Scale bar (100 ft) and north arrow, bottom left.
  const bar = 100 / ftPerPx;
  ctx.fillStyle = "rgba(15,23,42,0.75)"; ctx.fillRect(16, H - 56, bar + 40, 40);
  ctx.fillStyle = "#fff"; ctx.fillRect(36, H - 30, bar, 5);
  ctx.font = "15px system-ui, sans-serif"; ctx.fillText("100 ft", 36, H - 36);
  ctx.fillStyle = "rgba(15,23,42,0.75)"; ctx.fillRect(W - 60, header + 16, 44, 56);
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(W - 38, header + 24); ctx.lineTo(W - 28, header + 50); ctx.lineTo(W - 48, header + 50); ctx.closePath(); ctx.fill();
  ctx.font = "bold 15px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("N", W - 38, header + 66);
  ctx.textAlign = "right"; ctx.font = "13px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText("Imagery © Esri, Maxar, Earthstar Geographics", W - 12, H - 10);

  let data = canvas.toDataURL("image/jpeg", 0.86);
  if (data.length > 5_000_000) data = canvas.toDataURL("image/jpeg", 0.7);
  return { mime: "image/jpeg", base64: data.slice(data.indexOf(",") + 1), width: W, height: H };
}
