import { bbox, toLatLng, toLocal, type LatLng, type Pt } from "./geo";
import { FEATURE_INFO, newCourse, uid, type Course, type Feature, type FeatureKind } from "./model";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------- file dialogs

export async function saveText(defaultName: string, text: string, ext: string, label: string) {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }
  const blob = new Blob([text], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

export interface PickedFile { name: string; text?: string; dataUrl?: string }

export async function openFile(exts: string[], label: string, asDataUrl = false): Promise<PickedFile | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile, readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: label, extensions: exts }] });
    if (!path || Array.isArray(path)) return null;
    const name = path.split(/[\\/]/).pop() ?? path;
    if (asDataUrl) {
      const bytes = await readFile(path);
      const ext = name.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      return { name, dataUrl: await bytesToDataUrl(bytes, mime) };
    }
    if (name.toLowerCase().endsWith(".kmz")) {
      const bytes = await readFile(path);
      return { name, text: await kmzToKml(bytes) };
    }
    return { name, text: await readTextFile(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = exts.map((e) => "." + e).join(",");
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (asDataUrl) {
        const r = new FileReader();
        r.onload = () => resolve({ name: f.name, dataUrl: r.result as string });
        r.readAsDataURL(f);
      } else if (f.name.toLowerCase().endsWith(".kmz")) {
        resolve({ name: f.name, text: await kmzToKml(new Uint8Array(await f.arrayBuffer())) });
      } else resolve({ name: f.name, text: await f.text() });
    };
    input.click();
  });
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

/** Minimal KMZ (zip) reader: finds the first .kml entry and inflates it. */
async function kmzToKml(bytes: Uint8Array): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 30 < bytes.length && view.getUint32(off, true) === 0x04034b50) {
    const method = view.getUint16(off + 8, true);
    const compSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 30, off + 30 + nameLen));
    const dataStart = off + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    if (name.toLowerCase().endsWith(".kml")) {
      if (method === 0) return new TextDecoder().decode(data);
      const ds = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(ds).text();
    }
    off = dataStart + compSize;
  }
  throw new Error("No KML found inside the KMZ file.");
}

// ---------------------------------------------------------------- project file

export function serialize(c: Course) {
  return JSON.stringify({ app: "autocross-course-designer", ...c }, null, 1);
}

export function deserialize(text: string): Course {
  const raw = JSON.parse(text);
  if (raw.version !== 1 || !raw.origin) throw new Error("Not an Autocross Course Designer project.");
  const base = newCourse(raw.origin);
  return { ...base, ...raw, settings: { ...base.settings, ...raw.settings } };
}

// ---------------------------------------------------------------- KML

const KIND_KEYWORDS: [RegExp, FeatureKind][] = [
  [/no[\s-]?go|don'?t use|do not use|keep out|off[\s-]?limits|closed|exclud|grass/i, "nogo"],
  [/course area|race area|racing area|competition area/i, "paved"],
  [/spectat|viewing|crowd|bleacher/i, "spectator"],
  [/paddock|parking/i, "paddock"],
  [/grid|staging/i, "grid"],
  [/pole|light|tree|post|hydrant/i, "pole"],
  [/curb/i, "curb"],
  [/hole|grate|manhole|drain|gravel|crack|broken/i, "surface"],
  [/building|fence|wall|planter|island|obstacle|barrier/i, "obstacle"],
  [/worker|station/i, "worker"],
  [/pave|lot|tarmac|asphalt|concrete|runway|site|area/i, "paved"],
];

function guessKind(name: string, geom: "point" | "line" | "poly"): FeatureKind | "line" | "cone" {
  for (const [re, k] of KIND_KEYWORDS) if (re.test(name)) return k;
  if (/driving|course line|racing line|path/i.test(name) && geom === "line") return "line";
  if (geom === "point") return /cone/i.test(name) || name === "" ? "cone" : "pole";
  if (geom === "line") return "line";
  return "paved";
}

const parseCoords = (s: string): LatLng[] =>
  s.trim().split(/\s+/).map((t) => t.split(",").map(Number)).filter((a) => a.length >= 2 && !isNaN(a[0]) && !isNaN(a[1])).map(([lng, lat]) => ({ lat, lng }));

/**
 * Imports Placemarks from Google Earth: polygons become areas (kind guessed from
 * the placemark name, default "paved"), lines become the driving line or curbs,
 * points become poles, worker stations or cones.
 */
export function importKml(text: string, into: Course): { course: Course; summary: string } {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const marks = [...doc.getElementsByTagName("Placemark")];
  if (!marks.length) throw new Error("No placemarks found in this KML.");
  const allLL: LatLng[] = [];
  const items: { name: string; geom: "point" | "line" | "poly"; ll: LatLng[] }[] = [];
  for (const m of marks) {
    const name = m.getElementsByTagName("name")[0]?.textContent?.trim() ?? "";
    for (const poly of [...m.getElementsByTagName("Polygon")]) {
      const outer = poly.getElementsByTagName("outerBoundaryIs")[0] ?? poly;
      const ll = parseCoords(outer.getElementsByTagName("coordinates")[0]?.textContent ?? "");
      if (ll.length > 1 && ll[0].lat === ll[ll.length - 1].lat && ll[0].lng === ll[ll.length - 1].lng) ll.pop();
      if (ll.length >= 3) items.push({ name, geom: "poly", ll });
    }
    for (const ls of [...m.getElementsByTagName("LineString")]) {
      const ll = parseCoords(ls.getElementsByTagName("coordinates")[0]?.textContent ?? "");
      if (ll.length >= 2) items.push({ name, geom: "line", ll });
    }
    for (const pt of [...m.getElementsByTagName("Point")]) {
      const ll = parseCoords(pt.getElementsByTagName("coordinates")[0]?.textContent ?? "");
      if (ll.length) items.push({ name, geom: "point", ll });
    }
  }
  items.forEach((i) => allLL.push(...i.ll));
  let course = into;
  const empty = !into.cones.length && !into.features.length && !into.line.length;
  if (empty && allLL.length) {
    const lat = allLL.reduce((a, b) => a + b.lat, 0) / allLL.length;
    const lng = allLL.reduce((a, b) => a + b.lng, 0) / allLL.length;
    course = { ...into, origin: { lat, lng } };
  }
  const o = course.origin;
  const features: Feature[] = [...course.features];
  const cones = [...course.cones];
  let line = course.line;
  const counts: Record<string, number> = {};
  for (const it of items) {
    const kind = guessKind(it.name, it.geom);
    const pts = it.ll.map((ll) => toLocal(ll, o));
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === "line") { line = pts; continue; }
    if (kind === "cone") { cones.push({ id: uid("c"), ...pts[0], kind: "standing" }); continue; }
    const info = FEATURE_INFO[kind];
    const closed = it.geom === "poly";
    features.push({ id: uid("f"), kind, pts: info.point ? [pts[0]] : pts, closed: info.point ? false : closed, label: it.name || undefined });
  }
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k === "line" ? "driving line" : k === "cone" ? "cone" : FEATURE_INFO[k as FeatureKind].label.toLowerCase()}`).join(", ");
  return { course: { ...course, features, cones, line }, summary };
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

export function exportKml(c: Course): string {
  const o = c.origin;
  const coord = (p: Pt) => { const ll = toLatLng(p, o); return `${ll.lng.toFixed(8)},${ll.lat.toFixed(8)},0`; };
  const style = (id: string, color: string, fill = "40") => {
    const abgr = (hex: string, a: string) => `${a}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;
    return `<Style id="${id}"><LineStyle><color>${abgr(color, "ff")}</color><width>2</width></LineStyle><PolyStyle><color>${abgr(color, fill)}</color></PolyStyle><IconStyle><color>${abgr(color, "ff")}</color><scale>0.6</scale></IconStyle></Style>`;
  };
  const parts: string[] = [];
  parts.push(style("cone", "#f97316"), style("line", "#facc15"), style("timing", "#22c55e"));
  for (const [k, v] of Object.entries(FEATURE_INFO)) parts.push(style(k, v.color));
  const pm = (name: string, sty: string, geom: string) => `<Placemark><name>${esc(name)}</name><styleUrl>#${sty}</styleUrl>${geom}</Placemark>`;
  const feats = c.features.map((f) => {
    const name = f.label || FEATURE_INFO[f.kind].label;
    if (f.pts.length === 1) return pm(name, f.kind, `<Point><coordinates>${coord(f.pts[0])}</coordinates></Point>`);
    if (f.closed) return pm(name, f.kind, `<Polygon><outerBoundaryIs><LinearRing><coordinates>${[...f.pts, f.pts[0]].map(coord).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon>`);
    return pm(name, f.kind, `<LineString><coordinates>${f.pts.map(coord).join(" ")}</coordinates></LineString>`);
  });
  const cones = c.cones.map((k, i) => pm(`Cone ${i + 1}${k.kind !== "standing" ? ` (${k.kind})` : ""}`, k.kind === "timing" ? "timing" : "cone", `<Point><coordinates>${coord(k)}</coordinates></Point>`));
  const extras: string[] = [];
  if (c.line.length >= 2) extras.push(pm("Driving line", "line", `<LineString><tessellate>1</tessellate><coordinates>${c.line.map(coord).join(" ")}</coordinates></LineString>`));
  if (c.start) extras.push(pm("Start", "timing", `<LineString><coordinates>${coord(c.start.a)} ${coord(c.start.b)}</coordinates></LineString>`));
  if (c.finish) extras.push(pm("Finish", "timing", `<LineString><coordinates>${coord(c.finish.a)} ${coord(c.finish.b)}</coordinates></LineString>`));
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(c.name)}</name>
${parts.join("\n")}
<Folder><name>Site</name>${feats.join("\n")}</Folder>
<Folder><name>Course</name>${extras.join("\n")}</Folder>
<Folder><name>Cones</name>${cones.join("\n")}</Folder>
</Document></kml>`;
}

// ---------------------------------------------------------------- printable SVG map

export function exportSvg(c: Course, title: string): string {
  const all: Pt[] = [...c.cones, ...c.line, ...c.features.flatMap((f) => f.pts)];
  if (c.start) all.push(c.start.a, c.start.b);
  if (c.finish) all.push(c.finish.a, c.finish.b);
  if (!all.length) all.push({ x: 0, y: 0 });
  const b = bbox(all);
  const pad = 40;
  const W = b.maxX - b.minX + pad * 2;
  const H = b.maxY - b.minY + pad * 2;
  const X = (p: Pt) => (p.x - b.minX + pad).toFixed(1);
  const Y = (p: Pt) => (b.maxY - p.y + pad).toFixed(1);
  const pts = (a: Pt[]) => a.map((p) => `${X(p)},${Y(p)}`).join(" ");
  const out: string[] = [];
  for (const f of c.features) {
    const col = FEATURE_INFO[f.kind].color;
    if (f.pts.length === 1) out.push(`<circle cx="${X(f.pts[0])}" cy="${Y(f.pts[0])}" r="4" fill="${col}"/>`);
    else if (f.closed) out.push(`<polygon points="${pts(f.pts)}" fill="${col}" fill-opacity="${f.kind === "paved" ? 0.12 : 0.3}" stroke="${col}" stroke-width="1"/>`);
    else out.push(`<polyline points="${pts(f.pts)}" fill="none" stroke="${col}" stroke-width="2"/>`);
  }
  if (c.line.length >= 2) out.push(`<polyline points="${pts(c.line)}" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="6 4"/>`);
  for (const l of [c.start, c.finish]) if (l) out.push(`<line x1="${X(l.a)}" y1="${Y(l.a)}" x2="${X(l.b)}" y2="${Y(l.b)}" stroke="#16a34a" stroke-width="2"/>`);
  for (const k of c.cones) {
    if (k.kind === "pointer") {
      const r = k.rot ?? 0;
      const tip = { x: k.x + Math.cos(r) * 4, y: k.y + Math.sin(r) * 4 };
      out.push(`<line x1="${X(k)}" y1="${Y(k)}" x2="${X(tip)}" y2="${Y(tip)}" stroke="#ea580c" stroke-width="2.5"/>`);
    } else out.push(`<circle cx="${X(k)}" cy="${Y(k)}" r="2" fill="${k.kind === "timing" ? "#16a34a" : "#ea580c"}"/>`);
  }
  if (c.start) out.push(`<text x="${X(c.start.a)}" y="${+Y(c.start.a) - 6}" font-size="12" font-family="sans-serif">START</text>`);
  if (c.finish) out.push(`<text x="${X(c.finish.a)}" y="${+Y(c.finish.a) - 6}" font-size="12" font-family="sans-serif">FINISH</text>`);
  // 100 ft scale bar and north arrow
  out.push(`<g transform="translate(${pad},${H - 14})"><line x1="0" y1="0" x2="100" y2="0" stroke="#000" stroke-width="2"/><text x="0" y="-4" font-size="10" font-family="sans-serif">100 ft</text></g>`);
  out.push(`<g transform="translate(${W - 24},30)"><path d="M0,-16 L6,4 L0,0 L-6,4 Z" fill="#000"/><text x="-4" y="16" font-size="10" font-family="sans-serif">N</text></g>`);
  out.push(`<text x="${pad}" y="20" font-size="16" font-family="sans-serif" font-weight="bold">${esc(title)}</text>`);
  out.push(`<text x="${pad}" y="36" font-size="10" font-family="sans-serif">${c.cones.length} cones</text>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}"><rect width="100%" height="100%" fill="#fff"/>${out.join("")}</svg>`;
}
