import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { FT_PER_S_PER_MPH, add, dist, heading, norm, perp, polygonArea, scale, sub, toLatLng, toLocal, type LatLng, type Pt } from "./geo";
import { FEATURE_INFO, isEmpty, uid, type Cone, type Course, type Feature, type FeatureKind } from "./model";
import type { Issue } from "./rules";
import { straightenEdge } from "./shapes";
import { DEFAULT_WAND, prepareImage, runWand, type WandImage } from "./wand";
import type { SimResult } from "./sim";

export type Tool =
  | "select" | "cone" | "pointer" | "gate" | "slalom" | "wall" | "line" | "feature"
  | "start" | "finish" | "calibrate" | "image-move" | "measure" | "wand" | "cut" | "add" | "straighten";

export interface WandSettings { tolerance: number; kind: FeatureKind; holesAsNogo: boolean; stopAtEdges: boolean }

export type Selection = { type: "cone"; id: string } | { type: "feature"; id: string } | { type: "line" } | null;

export interface ToolOptions { gateWidth: number; slalomSpacing: number; wallSpacing: number; zoneShape: "rect" | "polygon" }

export type Basemap = "esri" | "usgs" | "osm" | "none";

export interface MapHandle {
  flyTo(ll: LatLng, zoom?: number): void;
  center(): LatLng;
  focus(p: Pt): void;
  fitCourse(): void;
}

interface Props {
  course: Course;
  sim: SimResult | null;
  issues: Issue[];
  tool: Tool;
  featureKind: FeatureKind;
  options: ToolOptions;
  basemap: Basemap;
  selection: Selection;
  onSelect(s: Selection): void;
  onChange(c: Course): void;
  onToolDone(): void;
  onStatus(s: string): void;
  onCalibrate(a: Pt, b: Pt): void;
  wand: WandSettings;
  /** Site map: zones are clickable, cones are not. Course design: the reverse. */
  mode: "site" | "course";
  /** A shape drawn with the Cut or Add tool. */
  onShapeOp(op: "cut" | "add", pts: Pt[]): void;
  ref?: Ref<MapHandle>;
}

/** The wand is tuned for ~0.9 m (3 ft) per pixel; finer views are downsampled to it. */
const WAND_METERS_PER_PX = 0.9;

interface WandSession {
  img: WandImage | null; // null once the view moves: pixels no longer line up
  /** Wand pixels per screen pixel (≤ 1). */
  scale: number;
  seeds: { x: number; y: number }[];
  featureIds: string[];
}

/** Draws the visible background imagery (tiles + imported image) into a canvas. */
function captureView(map: L.Map, scale: number): { rgba: Uint8ClampedArray; w: number; h: number } | string {
  const cont = map.getContainer();
  const cr = cont.getBoundingClientRect();
  const w = Math.round(cr.width * scale), h = Math.round(cr.height * scale);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const levels = [...cont.querySelectorAll<HTMLElement>(".leaflet-tile-container")].sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
  let drawn = 0, loading = 0;
  const draw = (img: HTMLImageElement) => {
    const r = img.getBoundingClientRect();
    if (r.right < cr.left || r.left > cr.right || r.bottom < cr.top || r.top > cr.bottom) return;
    if (!img.complete || !img.naturalWidth) { loading++; return; }
    ctx.globalAlpha = parseFloat(img.style.opacity || "1") * parseFloat(getComputedStyle(img).opacity || "1");
    ctx.drawImage(img, (r.left - cr.left) * scale, (r.top - cr.top) * scale, r.width * scale, r.height * scale);
    drawn++;
  };
  for (const lvl of levels) lvl.querySelectorAll<HTMLImageElement>("img.leaflet-tile").forEach(draw);
  cont.querySelectorAll<HTMLImageElement>("img.leaflet-image-layer").forEach(draw);
  if (!drawn) return "There's no imagery to read here. Switch the background to Aerial, or import an image of the site.";
  if (loading) return "The imagery is still loading. Wait a moment and click again.";
  try {
    return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    return "This background can't be read by the wand. Switch to Aerial (Esri or USGS), or import an image of the site.";
  }
}

const TILES: Record<Exclude<Basemap, "none">, { url: string; attribution: string; maxNative: number }> = {
  esri: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community", maxNative: 19 },
  usgs: { url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", attribution: "Imagery: USGS The National Map (public domain)", maxNative: 16 },
  osm: { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", maxNative: 19 },
};

const rectPts = (a: Pt, b: Pt): Pt[] => [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];

const SHAPE_OP_COLOR = { cut: "#ef4444", add: "#22c55e" } as const;
/** How the current drawing tool behaves: zones (feature) or the Cut / Add shape tools. */
function drawInfo(tool: Tool, kind: FeatureKind) {
  if (tool === "cut" || tool === "add") return { closed: true, point: false, color: SHAPE_OP_COLOR[tool] };
  if (tool === "feature") { const i = FEATURE_INFO[kind]; return { closed: i.closed, point: i.point, color: i.color }; }
  return null;
}

const TWO_CLICK: Tool[] = ["gate", "slalom", "wall", "start", "finish", "calibrate", "measure"];

function coneIcon(c: Cone, selected: boolean) {
  const color = c.kind === "timing" ? "#22c55e" : "#f97316";
  const ring = selected ? "outline:2px solid #38bdf8;outline-offset:1px;" : "";
  if (c.kind === "pointer") {
    const deg = -((c.rot ?? 0) * 180) / Math.PI;
    return L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: `<div style="width:18px;height:18px;transform:rotate(${deg}deg);${ring}border-radius:3px"><svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 6 L16 9 L2 12 Z" fill="${color}" stroke="#7c2d12" stroke-width="1"/></svg></div>` });
  }
  return L.divIcon({ className: "", iconSize: [12, 12], iconAnchor: [6, 6], html: `<div style="width:12px;height:12px;${ring}border-radius:50%"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1 L11 11 L1 11 Z" fill="${color}" stroke="#7c2d12" stroke-width="1"/></svg></div>` });
}

const straightIcon = L.divIcon({ className: "", iconSize: [12, 12], iconAnchor: [6, 6], html: `<div style="width:12px;height:12px;background:#fff;border:2px solid #f97316;border-radius:50%;cursor:pointer"></div>` });
const straightFirstIcon = L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8], html: `<div style="width:16px;height:16px;background:#f97316;border:2px solid #fff;border-radius:50%"></div>` });
const vertexIcon = L.divIcon({ className: "", iconSize: [10, 10], iconAnchor: [5, 5], html: `<div style="width:10px;height:10px;background:#fff;border:2px solid #2563eb;border-radius:2px"></div>` });

const midIcon = L.divIcon({ className: "", iconSize: [8, 8], iconAnchor: [4, 4], html: `<div style="width:8px;height:8px;background:rgba(255,255,255,.55);border:1px solid #2563eb;border-radius:50%"></div>` });

function speedColor(mph: number) {
  const t = Math.max(0, Math.min(1, (mph - 20) / 45));
  const h = 140 - t * 140;
  return `hsl(${h},90%,50%)`;
}

export default function MapEditor(props: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const tempRef = useRef<L.LayerGroup | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [pending, setPending] = useState<Pt[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const mouseRef = useRef<Pt | null>(null);
  const [straightFrom, setStraightFrom] = useState<number | null>(null);
  useEffect(() => { setStraightFrom(null); }, [props.tool, props.selection]);

  useImperativeHandle(props.ref, () => ({
    flyTo: (ll, zoom = 18) => mapRef.current?.setView([ll.lat, ll.lng], zoom),
    center: () => { const c = mapRef.current!.getCenter(); return { lat: c.lat, lng: c.lng }; },
    focus: (p) => { const ll = toLatLng(p, latest.current.course.origin); mapRef.current?.setView([ll.lat, ll.lng], Math.max(mapRef.current.getZoom(), 19)); },
    fitCourse: () => {
      const c = latest.current.course;
      const pts = [...c.cones, ...c.line, ...c.features.flatMap((f) => f.pts)];
      if (!pts.length) return;
      const lls = pts.map((p) => toLatLng(p, c.origin));
      mapRef.current?.fitBounds(L.latLngBounds(lls.map((l) => [l.lat, l.lng] as [number, number])), { padding: [40, 40] });
    },
  }));

  // ---- map init
  useEffect(() => {
    const map = L.map(divRef.current!, { zoomControl: true, doubleClickZoom: false, maxZoom: 22, zoomSnap: 0.25 });
    const o = latest.current.course.origin;
    map.setView([o.lat, o.lng], isEmpty(latest.current.course) ? 5 : 18);
    L.control.scale({ imperial: true, metric: false, position: "bottomleft" }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    tempRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    const local = (e: L.LeafletMouseEvent) => toLocal({ lat: e.latlng.lat, lng: e.latlng.lng }, latest.current.course.origin);

    map.on("movestart zoomstart resize", () => { if (wandRef.current) wandRef.current.img = null; });
    map.on("click", (e: L.LeafletMouseEvent) => {
      const P = latest.current;
      if (P.tool === "wand") { wandClick(e); return; }
      let c = P.course;
      // First thing placed on an empty project: re-center the local frame on the click.
      if (isEmpty(c) && P.tool !== "select" && P.tool !== "measure") c = { ...c, origin: { lat: e.latlng.lat, lng: e.latlng.lng } };
      const p = toLocal({ lat: e.latlng.lat, lng: e.latlng.lng }, c.origin);
      handleClick(c, p);
    });
    map.on("dblclick", () => finishMulti());
    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      mouseRef.current = local(e);
      drawTemp();
    });
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(divRef.current!);
    return () => { ro.disconnect(); map.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- basemap
  useEffect(() => {
    const map = mapRef.current!;
    tileRef.current?.remove();
    tileRef.current = null;
    if (props.basemap !== "none") {
      const t = TILES[props.basemap];
      tileRef.current = L.tileLayer(t.url, { attribution: t.attribution, maxNativeZoom: t.maxNative, maxZoom: 22, crossOrigin: true }).addTo(map);
      tileRef.current.bringToBack();
    }
  }, [props.basemap]);

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      const P = latest.current;
      if (e.key === "Escape") { setPending([]); P.onToolDone(); }
      if (e.key === "Enter") finishMulti();
      if (e.key === "Backspace" && pendingRef.current.length) {
        e.preventDefault();
        setPending(pendingRef.current.slice(0, -1));
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && P.selection) {
        const s = P.selection;
        const c = P.course;
        if (s.type === "cone") P.onChange({ ...c, cones: c.cones.filter((k) => k.id !== s.id) });
        if (s.type === "feature") {
          if (c.features.find((f) => f.id === s.id)?.locked) { P.onStatus("That zone is locked. Unlock it to delete it."); return; }
          P.onChange({ ...c, features: c.features.filter((f) => f.id !== s.id) });
        }
        if (s.type === "line") P.onChange({ ...c, line: [] });
        P.onSelect(null);
      }
      if ((e.key === "r" || e.key === "R") && P.selection?.type === "cone") {
        const id = P.selection.id;
        const d = (e.shiftKey ? -1 : 1) * (Math.PI / 12);
        P.onChange({ ...P.course, cones: P.course.cones.map((k) => (k.id === id ? { ...k, rot: (k.rot ?? 0) + d } : k)) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reset pending when tool changes
  useEffect(() => { setPending([]); }, [props.tool, props.featureKind]);

  // ---- magic wand
  const wandRef = useRef<WandSession | null>(null);
  useEffect(() => { if (props.tool !== "wand") wandRef.current = null; }, [props.tool]);

  function wandClick(e: L.LeafletMouseEvent) {
    const P = latest.current;
    const map = mapRef.current!;
    const add = e.originalEvent.shiftKey && wandRef.current?.img;
    if (!add) {
      const lat = map.getCenter().lat;
      const metersPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
      const scale = Math.min(1, metersPerPx / WAND_METERS_PER_PX);
      const cap = captureView(map, scale);
      if (typeof cap === "string") { P.onStatus(cap); return; }
      wandRef.current = { img: prepareImage(cap.rgba, cap.w, cap.h), scale, seeds: [], featureIds: [] };
    }
    const sc = wandRef.current!.scale;
    wandRef.current!.seeds.push({ x: e.containerPoint.x * sc, y: e.containerPoint.y * sc });
    applyWand(add ? wandRef.current!.featureIds : []);
  }

  /** (Re)runs the wand for the current session and swaps its zones into the course. */
  function applyWand(replaceIds: string[]) {
    const P = latest.current;
    const s = wandRef.current;
    const map = mapRef.current!;
    if (!s?.img) return;
    const shapes = runWand(s.img, s.seeds, { ...DEFAULT_WAND, tolerance: P.wand.tolerance, edgeStop: P.wand.stopAtEdges ? DEFAULT_WAND.edgeStop : 0 });
    let c = P.course;
    if (isEmpty(c)) { const ll = map.getCenter(); c = { ...c, origin: { lat: ll.lat, lng: ll.lng } }; }
    const toPt = ([x, y]: [number, number]) => { const ll = map.containerPointToLatLng([x / s.scale, y / s.scale]); return toLocal({ lat: ll.lat, lng: ll.lng }, c.origin); };
    const created: Feature[] = [];
    let area = 0, holes = 0;
    for (const sh of shapes) {
      const pts = sh.outer.map(toPt);
      const a = polygonArea(pts);
      if (a < 100) continue;
      area += a;
      created.push({ id: uid("f"), kind: P.wand.kind, pts, closed: true, label: P.wand.kind === "paved" ? "Course area (wand)" : undefined });
      if (P.wand.holesAsNogo && P.wand.kind === "paved") {
        for (const hr of sh.holes) {
          const hp = hr.map(toPt);
          if (polygonArea(hp) < 150) continue;
          created.push({ id: uid("f"), kind: "nogo", pts: hp, closed: true, label: "Island (wand)" });
          holes++;
        }
      }
    }
    s.featureIds = created.map((f) => f.id);
    P.onChange({ ...c, features: [...c.features.filter((f) => !replaceIds.includes(f.id)), ...created] });
    if (!created.length) { P.onStatus("Nothing found there. Click inside the pavement, or raise Tolerance."); return; }
    const acres = area / 43560;
    P.onStatus(`Found ${acres >= 0.5 ? acres.toFixed(2) + " acres" : Math.round(area).toLocaleString() + " ft²"}${holes ? `, ${holes} island(s) marked Don't use` : ""}. Shift-click to add more; adjust Tolerance to grow or shrink.`);
  }

  // Re-run when the wand settings change (only while the view hasn't moved).
  useEffect(() => {
    const s = wandRef.current;
    if (props.tool !== "wand" || !s?.img || !s.seeds.length) return;
    const t = setTimeout(() => applyWand(s.featureIds), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.wand.tolerance, props.wand.kind, props.wand.holesAsNogo, props.wand.stopAtEdges]);

  /** Screen distance in pixels between two local points. */
  function pxDist(a: Pt, b: Pt, c: Course) {
    const map = mapRef.current!;
    const A = toLatLng(a, c.origin), B = toLatLng(b, c.origin);
    return map.latLngToContainerPoint([A.lat, A.lng]).distanceTo(map.latLngToContainerPoint([B.lat, B.lng]));
  }

  /** Pointer cones default to aiming at the nearest point of the driving line. */
  function nearestLineDir(p: Pt): number {
    const s = latest.current.sim;
    if (!s || !s.samples.length) return 0;
    let best = s.samples[0];
    for (const q of s.samples) if (dist(q.p, p) < dist(best.p, p)) best = q;
    return heading(p, best.p);
  }

  function handleClick(c: Course, p: Pt) {
    const P = latest.current;
    const tool = P.tool;
    if (tool === "select") { P.onSelect(null); return; }
    if (tool === "cone") { P.onChange({ ...c, cones: [...c.cones, { id: uid("c"), ...p, kind: "standing", group: "free" }] }); return; }
    if (tool === "pointer") { P.onChange({ ...c, cones: [...c.cones, { id: uid("c"), ...p, kind: "pointer", rot: nearestLineDir(p), group: "free" }] }); return; }
    if (tool === "line") {
      const startMid = c.start ? { x: (c.start.a.x + c.start.b.x) / 2, y: (c.start.a.y + c.start.b.y) / 2 } : null;
      const finMid = c.finish ? { x: (c.finish.a.x + c.finish.b.x) / 2, y: (c.finish.a.y + c.finish.b.y) / 2 } : null;
      if (finMid && c.line.length && dist(p, finMid) < 40) {
        P.onChange({ ...c, line: [...c.line, finMid] });
        P.onStatus("Driving line ends at the finish. Click Auto-generate to place cones along it.");
        P.onToolDone();
        return;
      }
      const line = !c.line.length && startMid && dist(p, startMid) > 5 ? [startMid, p] : [...c.line, p];
      P.onChange({ ...c, line });
      if (!c.line.length) P.onStatus(finMid ? "Keep clicking along your path. Click near the finish line to end there." : "Keep clicking along your path. Enter or double-click to stop.");
      return;
    }
    if (tool === "image-move" && c.image) { P.onChange({ ...c, image: { ...c.image, x: p.x - c.image.w / 2, y: p.y - c.image.h / 2 } }); P.onToolDone(); return; }
    const info = drawInfo(tool, P.featureKind);
    if (info) {
      if (info.point) { P.onChange({ ...c, features: [...c.features, { id: uid("f"), kind: P.featureKind, pts: [p], closed: false }] }); return; }
      if (P.options.zoneShape === "rect" && info.closed) {
        const pend = pendingRef.current;
        if (!pend.length) { if (c !== P.course) P.onChange(c); setPending([p]); return; }
        setPending([]);
        if (Math.abs(p.x - pend[0].x) < 3 || Math.abs(p.y - pend[0].y) < 3) { P.onStatus("Rectangle too small; click two opposite corners."); return; }
        if (tool === "cut" || tool === "add") P.onShapeOp(tool, rectPts(pend[0], p));
        else P.onChange({ ...c, features: [...c.features, { id: uid("f"), kind: P.featureKind, pts: rectPts(pend[0], p), closed: true }] });
        return;
      }
      if (c !== P.course) P.onChange(c); // origin moved
      const pend = pendingRef.current;
      // Clicking back on the first point closes the shape.
      if (pend.length >= 3 && info.closed && pxDist(pend[0], p, c) < 12) { finishMulti(); return; }
      // Ignore the duplicate click a double-click produces.
      if (pend.length && pxDist(pend[pend.length - 1], p, c) < 4) return;
      setPending([...pend, p]);
      return;
    }
    if (TWO_CLICK.includes(tool)) {
      const pend = pendingRef.current;
      if (!pend.length) { if (c !== P.course) P.onChange(c); setPending([p]); return; }
      const a = pend[0];
      setPending([]);
      finishTwoClick(c, tool, a, p);
    }
  }

  function finishTwoClick(c: Course, tool: Tool, a: Pt, b: Pt) {
    const P = latest.current;
    const len = dist(a, b);
    const dir = norm(sub(b, a));
    const g = uid("g");
    if (tool === "measure") { P.onStatus(`Distance: ${len.toFixed(1)} ft`); return; }
    if (tool === "calibrate") { P.onCalibrate(a, b); return; }
    if (tool === "start" || tool === "finish") {
      const group = tool;
      const cones = c.cones.filter((k) => k.group !== group);
      cones.push({ id: uid("c"), ...a, kind: "timing", group, groupId: g }, { id: uid("c"), ...b, kind: "timing", group, groupId: g });
      P.onChange({ ...c, [tool]: { a, b }, cones });
      return;
    }
    if (tool === "gate") {
      P.onChange({ ...c, cones: [...c.cones, { id: uid("c"), ...a, kind: "standing", group: "gate", groupId: g }, { id: uid("c"), ...b, kind: "standing", group: "gate", groupId: g }] });
      P.onStatus(`Gate width ${len.toFixed(1)} ft`);
      return;
    }
    const spacing = tool === "slalom" ? P.options.slalomSpacing : P.options.wallSpacing;
    const n = Math.max(1, Math.round(len / spacing));
    const add2: Cone[] = [];
    for (let i = 0; i <= n; i++) {
      const q = add(a, scale(dir, Math.min(len, i * spacing)));
      add2.push({ id: uid("c"), ...q, kind: "standing", group: tool === "slalom" ? "slalom" : "wall", groupId: g });
    }
    P.onChange({ ...c, cones: [...c.cones, ...add2] });
    P.onStatus(`${add2.length} cones at ${spacing} ft spacing`);
  }

  function finishMulti() {
    const P = latest.current;
    const pend = pendingRef.current;
    const info = drawInfo(P.tool, P.featureKind);
    if (info && pend.length >= 2) {
      const closed = info.closed && pend.length >= 3;
      if (info.closed && (!closed || polygonArea(pend) < 10)) { P.onStatus("An area needs at least 3 corners."); return; }
      if (P.tool === "cut" || P.tool === "add") { setPending([]); P.onShapeOp(P.tool, pend); return; }
      P.onChange({ ...P.course, features: [...P.course.features, { id: uid("f"), kind: P.featureKind, pts: pend, closed }] });
      setPending([]);
    } else if (P.tool === "line") P.onToolDone();
  }

  function drawTemp() {
    const P = latest.current;
    const tmp = tempRef.current;
    if (!tmp) return;
    tmp.clearLayers();
    const o = P.course.origin;
    const ll = (p: Pt) => { const q = toLatLng(p, o); return L.latLng(q.lat, q.lng); };
    const pend = pendingRef.current;
    const m = mouseRef.current;
    const pts = m ? [...pend, m] : pend;
    if (P.tool === "line" && P.course.line.length && m) {
      L.polyline([ll(P.course.line[P.course.line.length - 1]), ll(m)], { color: "#38bdf8", dashArray: "4 4", weight: 2, interactive: false }).addTo(tmp);
    }
    if (!pend.length) return;
    const di = drawInfo(P.tool, P.featureKind);
    const col = di ? di.color : "#38bdf8";
    if (di?.closed && P.options.zoneShape === "rect" && m) {
      const r = rectPts(pend[0], m);
      L.polygon(r.map(ll), { color: col, weight: 2, dashArray: "5 5", fillOpacity: 0.15, interactive: false }).addTo(tmp);
      L.tooltip({ permanent: true, direction: "right", offset: [10, 0], className: "measure-tip" }).setLatLng(ll(m)).setContent(`${Math.abs(m.x - pend[0].x).toFixed(0)} × ${Math.abs(m.y - pend[0].y).toFixed(0)} ft`).addTo(tmp);
      return;
    }
    if (di?.closed) {
      // Polygon in progress: filled preview with the closing edge, and vertex dots.
      L.polygon(pts.map(ll), { color: col, weight: 2, dashArray: "5 5", fillOpacity: 0.12, interactive: false }).addTo(tmp);
      pend.forEach((q, i) => L.circleMarker(ll(q), { radius: i === 0 ? 7 : 4, color: "#fff", weight: 2, fillColor: col, fillOpacity: 1, interactive: false }).addTo(tmp));
    } else L.polyline(pts.map(ll), { color: col, weight: 2, dashArray: "5 5", interactive: false }).addTo(tmp);
    if (m && pend.length) {
      const d = dist(pend[pend.length - 1], m);
      L.tooltip({ permanent: true, direction: "right", offset: [10, 0], className: "measure-tip" }).setLatLng(ll(m)).setContent(`${d.toFixed(0)} ft`).addTo(tmp);
      if (P.tool === "slalom" || P.tool === "wall") {
        const spacing = P.tool === "slalom" ? P.options.slalomSpacing : P.options.wallSpacing;
        const dir = norm(sub(m, pend[0]));
        for (let s = 0; s <= d + 0.01; s += spacing) L.circleMarker(ll(add(pend[0], scale(dir, s))), { radius: 3, color: "#f97316", interactive: false }).addTo(tmp);
      }
    }
  }

  useEffect(() => { drawTemp(); });

  // ---- render course
  useEffect(() => {
    const layer = layerRef.current!;
    layer.clearLayers();
    const { course: c, sim, selection, tool, issues, mode } = props;
    const siteMode = mode === "site";
    const o = c.origin;
    const ll = (p: Pt) => { const q = toLatLng(p, o); return L.latLng(q.lat, q.lng); };
    const editable = tool === "select";

    if (c.image) {
      const im = c.image;
      L.imageOverlay(im.dataUrl, L.latLngBounds(ll({ x: im.x, y: im.y }), ll({ x: im.x + im.w, y: im.y + im.h })), { opacity: im.opacity, interactive: false }).addTo(layer);
    }

    for (const f of c.features) {
      const info = FEATURE_INFO[f.kind];
      const sel = selection?.type === "feature" && selection.id === f.id;
      const style = { interactive: siteMode, color: info.color, weight: sel ? 3 : 2, fillOpacity: f.kind === "paved" ? 0.1 : f.kind === "nogo" ? 0.35 : 0.28, dashArray: f.kind === "paved" ? "6 4" : f.kind === "nogo" ? "2 4" : undefined };
      let shape: L.Layer;
      if (f.pts.length === 1) shape = L.circleMarker(ll(f.pts[0]), { interactive: siteMode, radius: f.kind === "worker" ? 8 : 6, color: info.color, fillColor: info.color, fillOpacity: 0.85, weight: sel ? 3 : 1 });
      else if (f.closed) shape = L.polygon(f.pts.map(ll), style);
      else shape = L.polyline(f.pts.map(ll), { ...style, weight: sel ? 5 : 4 });
      if (siteMode) (shape as L.Path).bindTooltip((f.locked ? "🔒 " : "") + (f.label || info.label), { sticky: true });
      shape.on("click", (e) => {
        const t = latest.current.tool;
        if (t === "select" || (t === "straighten" && f.closed)) { L.DomEvent.stop(e); latest.current.onSelect({ type: "feature", id: f.id }); setStraightFrom(null); }
      });
      shape.addTo(layer);
      if (sel && tool === "straighten" && f.closed && !f.locked) {
        f.pts.forEach((p, i) => {
          const first = straightFrom === i;
          const mk = L.marker(ll(p), { icon: first ? straightFirstIcon : straightIcon, title: first ? "Start corner" : "Click to straighten to here" }).addTo(layer);
          mk.on("click", (e) => {
            L.DomEvent.stop(e);
            const P = latest.current;
            if (straightFrom === null || straightFrom === i) { setStraightFrom(i); P.onStatus("Now click the corner where the straight edge should end."); return; }
            const ft = P.course.features.find((x) => x.id === f.id);
            if (!ft) return;
            const pts = straightenEdge(ft.pts, straightFrom, i);
            setStraightFrom(null);
            P.onChange({ ...P.course, features: P.course.features.map((x) => (x.id === f.id ? { ...x, pts } : x)) });
            P.onStatus(`Straightened: removed ${ft.pts.length - pts.length} corner(s). Click two more corners to straighten another edge.`);
          });
        });
      }
      if (sel && editable && !f.locked) {
        f.pts.forEach((p, i) => {
          const mk = L.marker(ll(p), { icon: vertexIcon, draggable: true }).addTo(layer);
          mk.on("dragend", () => {
            const q = toLocal({ lat: mk.getLatLng().lat, lng: mk.getLatLng().lng }, o);
            const P = latest.current;
            P.onChange({ ...P.course, features: P.course.features.map((x) => (x.id === f.id ? { ...x, pts: x.pts.map((v, j) => (j === i ? q : v)) } : x)) });
          });
          // Midpoint handle after this vertex: drag it to insert a new corner.
          const nxt = f.pts[(i + 1) % f.pts.length];
          if (f.pts.length >= 2 && (f.closed || i < f.pts.length - 1)) {
            const mid = L.marker(ll({ x: (p.x + nxt.x) / 2, y: (p.y + nxt.y) / 2 }), { icon: midIcon, draggable: true, title: "Drag to add a corner" }).addTo(layer);
            mid.on("dragend", () => {
              const q = toLocal({ lat: mid.getLatLng().lat, lng: mid.getLatLng().lng }, o);
              const P = latest.current;
              P.onChange({ ...P.course, features: P.course.features.map((x) => (x.id === f.id ? { ...x, pts: [...x.pts.slice(0, i + 1), q, ...x.pts.slice(i + 1)] } : x)) });
            });
          }
          mk.on("contextmenu", () => {
            const P = latest.current;
            if (f.pts.length <= (f.closed ? 3 : 2)) return;
            P.onChange({ ...P.course, features: P.course.features.map((x) => (x.id === f.id ? { ...x, pts: x.pts.filter((_, j) => j !== i) } : x)) });
          });
        });
      }
    }

    // Driving line, colored by simulated speed.
    if (sim && sim.samples.length > 1) {
      const step = 4;
      for (let i = 0; i < sim.samples.length - 1; i += step) {
        const a = sim.samples[i];
        const b = sim.samples[Math.min(sim.samples.length - 1, i + step)];
        const seg = L.polyline([ll(a.p), ll(b.p)], { color: speedColor(a.v / FT_PER_S_PER_MPH), weight: selection?.type === "line" ? 6 : 4, opacity: 0.9 });
        seg.bindTooltip(`${(a.v / FT_PER_S_PER_MPH).toFixed(0)} mph · ${a.t.toFixed(1)} s · ${a.s.toFixed(0)} ft`, { sticky: true });
        seg.on("click", (e) => { if (latest.current.tool === "select") { L.DomEvent.stop(e); latest.current.onSelect({ type: "line" }); } });
        seg.addTo(layer);
      }
      // direction arrows
      for (let s = 60; s < sim.lengthFt; s += 150) {
        const i = sim.samples.findIndex((q) => q.s >= s);
        if (i < 1) continue;
        const p = sim.samples[i].p;
        const d = norm(sub(p, sim.samples[i - 1].p));
        const l = perp(d);
        const tri = [add(p, scale(d, 6)), add(add(p, scale(d, -4)), scale(l, 4)), add(add(p, scale(d, -4)), scale(l, -4))];
        L.polygon(tri.map(ll), { color: "#0f172a", weight: 1, fillColor: "#fff", fillOpacity: 0.9, interactive: false }).addTo(layer);
      }
    } else if (c.line.length === 1) L.circleMarker(ll(c.line[0]), { radius: 4, color: "#38bdf8" }).addTo(layer);

    if (!siteMode && ((selection?.type === "line" && editable) || tool === "line")) {
      c.line.forEach((p, i) => {
        const mk = L.marker(ll(p), { icon: vertexIcon, draggable: true, title: "Drag to move · right-click to delete" }).addTo(layer);
        mk.on("dragend", () => {
          const q = toLocal({ lat: mk.getLatLng().lat, lng: mk.getLatLng().lng }, o);
          const P = latest.current;
          P.onChange({ ...P.course, line: P.course.line.map((v, j) => (j === i ? q : v)) });
        });
        mk.on("contextmenu", () => { const P = latest.current; P.onChange({ ...P.course, line: P.course.line.filter((_, j) => j !== i) }); });
      });
    }

    for (const [l, label] of [[c.start, "START"], [c.finish, "FINISH"]] as const) {
      if (!l) continue;
      L.polyline([ll(l.a), ll(l.b)], { color: "#22c55e", weight: 3, dashArray: "2 4", interactive: false }).addTo(layer);
      L.marker(ll({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }), { interactive: false, icon: L.divIcon({ className: "sf-label", html: label, iconSize: [60, 16], iconAnchor: [30, 24] }) }).addTo(layer);
    }

    for (const k of c.cones) {
      const sel = selection?.type === "cone" && selection.id === k.id;
      const mk = L.marker(ll(k), { icon: coneIcon(k, sel), draggable: editable && !siteMode, interactive: !siteMode, keyboard: false, opacity: siteMode ? 0.55 : 1 });
      mk.on("click", (e) => { if (latest.current.tool === "select") { L.DomEvent.stop(e); latest.current.onSelect({ type: "cone", id: k.id }); } });
      mk.on("dragend", () => {
        const q = toLocal({ lat: mk.getLatLng().lat, lng: mk.getLatLng().lng }, o);
        const P = latest.current;
        const cones = P.course.cones.map((x) => (x.id === k.id ? { ...x, ...q } : x));
        let next = { ...P.course, cones };
        // Moving a timing light moves its start or finish line with it.
        if ((k.group === "start" || k.group === "finish") && P.course[k.group]) {
          const pair = cones.filter((x) => x.group === k.group && (!k.groupId || x.groupId === k.groupId));
          if (pair.length === 2) next = { ...next, [k.group]: { a: { x: pair[0].x, y: pair[0].y }, b: { x: pair[1].x, y: pair[1].y } } };
        }
        P.onChange(next);
      });
      mk.addTo(layer);
    }

    for (const iss of issues) {
      if (!iss.at || iss.severity === "info") continue;
      const col = iss.severity === "error" ? "#ef4444" : "#f59e0b";
      L.circleMarker(ll(iss.at), { radius: 11, color: col, weight: 2, fill: false, dashArray: "3 3", interactive: false }).addTo(layer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.course, props.sim, props.selection, props.tool, props.issues, straightFrom]);

  return <div ref={divRef} className={`map tool-${props.tool}`} />;
}
