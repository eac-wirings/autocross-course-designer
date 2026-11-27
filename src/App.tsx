import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { dist, type Pt } from "./geo";
import { getVersion } from "@tauri-apps/api/app";
import { UpdateBanner } from "./UpdateBanner";
import { loadSession, openInBrowser, type ApexSession } from "./apex";

const PROMO_URL = "https://apexsites.club/?utm_source=track-builder&utm_medium=app&utm_campaign=title-bar";
import { ApexAccountDialog, CommunityDialog, LinkEventDialog, ShareSiteDialog } from "./ApexDialogs";
import { conesForLine, generateCourse, type GenResult, type GenStats, type StraightStyle } from "./generate";
import { deserialize, exportKml, exportSvg, importKml, openFile, saveText, serialize } from "./io";
import MapEditor, { type Basemap, type MapHandle, type Selection, type Tool, type ToolOptions, type WandSettings } from "./MapEditor";
import { CAR_PRESETS, EVENT_KINDS, FEATURE_INFO, ZONE_KINDS, newCourse, type Cone, type Course, type FeatureKind } from "./model";
import { pointInPolygon, polygonArea, smoothPath } from "./geo";
import { checkCourse, type Issue } from "./rules";
import Run3D from "./Run3D";
import { simulate } from "./sim";
import { addArea, cutAway, smoothOutline } from "./shapes";

const AUTOSAVE_KEY = "acd.autosave.v1";

function loadAutosave(): Course {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    if (s) return deserialize(s);
  } catch { /* ignore */ }
  return newCourse();
}

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Select / move", key: "V", hint: "Click to select, drag to move. Delete removes. R rotates a pointer cone." },
  { id: "line", label: "Driving line", key: "L", hint: "Click from start to finish to draw the intended line. Enter or double-click to stop. Right-click a vertex to remove it." },
  { id: "cone", label: "Cone", key: "C", hint: "Click to place a standing cone." },
  { id: "pointer", label: "Pointer cone", key: "P", hint: "Click to place a pointer (laid-down) cone. It aims at the driving line; select it and press R to rotate." },
  { id: "gate", label: "Gate", key: "G", hint: "Click both sides of the gate." },
  { id: "slalom", label: "Slalom", key: "S", hint: "Click first and last cone position. Cones are spaced by the slalom spacing setting." },
  { id: "wall", label: "Cone wall", key: "W", hint: "Click both ends; cones every wall spacing." },
  { id: "start", label: "Start line", key: "1", hint: "Click both timing lights of the start." },
  { id: "finish", label: "Finish line", key: "2", hint: "Click both timing lights of the finish." },
  { id: "feature", label: "Zone / site object", key: "A", hint: "Click points around the area, Enter or double-click to close it." },
  { id: "measure", label: "Measure", key: "M", hint: "Click two points to measure distance." },
  { id: "cut", label: "Cut away", key: "X", hint: "Draw around the part to remove: click corners, then click the first point (or Enter). Cuts the selected zone, or every Course area it touches." },
  { id: "add", label: "Add area", key: "+", hint: "Draw the extra area: click corners, then click the first point (or Enter). It merges into the selected zone, or into every Course area it touches." },
  { id: "straighten", label: "Straighten edge", key: "E", hint: "Click a zone, then click the corner where a straight edge should start and the corner where it should end. Everything between becomes one straight line." },
  { id: "wand", label: "Find pavement", key: "F", hint: "Click inside a parking lot or runway to outline it from the aerial photo. Shift-click to add more; adjust Tolerance to grow or shrink. Zoom so the area fills most of the view." },
];

export default function App() {
  const [course, setCourse] = useState<Course>(loadAutosave);
  const [past, setPast] = useState<Course[]>([]);
  const [future, setFuture] = useState<Course[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [mode, setModeRaw] = useState<"site" | "course">(() => (localStorage.getItem("acd.mode") === "site" ? "site" : "course"));
  const setMode = (m: "site" | "course") => { setModeRaw(m); localStorage.setItem("acd.mode", m); };
  // Picking a tool switches to the mode it belongs to.
  useEffect(() => {
    if (SITE_TOOLS.includes(tool) && mode !== "site") setMode("site");
    if (COURSE_TOOLS.includes(tool) && mode !== "course") setMode("course");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  const [featureKind, setFeatureKind] = useState<FeatureKind>("paved");
  const [selection, setSelection] = useState<Selection>(null);
  const [options, setOptions] = useState<ToolOptions>({ gateWidth: 22, slalomSpacing: 66, wallSpacing: 6, zoneShape: "polygon" });
  const [wand, setWand] = useState<WandSettings>({ tolerance: 16, kind: "paved", holesAsNogo: true, stopAtEdges: true });
  const [basemap, setBasemap] = useState<Basemap>("esri");
  const [status, setStatus] = useState("");
  const [show3D, setShow3D] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [help, setHelp] = useState(() => !localStorage.getItem("acd.seenHelp"));
  const [updCheck, setUpdCheck] = useState(0);
  const [apex, setApex] = useState<ApexSession | null>(() => loadSession());
  const [apexDlg, setApexDlg] = useState<null | "account" | "link" | "community" | "share">(null);
  const [calib, setCalib] = useState<{ a: Pt; b: Pt } | null>(null);
  const [search, setSearch] = useState("");
  const mapRef = useRef<MapHandle>(null);

  const change = useCallback((c: Course) => {
    setCourse((prev) => {
      setPast((p) => [...p.slice(-99), prev]);
      setFuture([]);
      // Editing the woven line by hand makes it the new drawn line.
      if (c.line !== prev.line && c.baseLine && c.baseLine === prev.baseLine) return { ...c, baseLine: undefined };
      return c;
    });
  }, []);
  /** Cut / Add shapes act on the selected zone, or on every Course area they touch. */
  function onShapeOp(op: "cut" | "add", pts: Pt[]) {
    const sel = selection?.type === "feature" ? course.features.find((f) => f.id === selection.id && f.closed) : undefined;
    if (sel?.locked) { setStatus("That zone is locked. Unlock it first (Selected panel or the lock in the Zones list)."); return; }
    const targets = sel ? [sel.id] : null;
    const kind = sel?.kind ?? "paved";
    if (op === "cut") {
      const r = cutAway(course.features, pts, targets, kind);
      if (!r.changed) { setStatus(sel ? "That shape doesn't overlap the selected zone." : "That shape doesn't overlap any unlocked Course area. Select a zone first to cut a different kind."); return; }
      change({ ...course, features: r.features });
      if (sel && !r.features.some((f) => f.id === sel.id)) setSelection(null);
      setStatus(`Cut away from ${r.changed} zone(s). Draw again to cut more, or press Esc.`);
    } else {
      const r = addArea(course.features, pts, targets, kind);
      change({ ...course, features: r.features });
      if (r.created) setSelection({ type: "feature", id: r.created });
      setStatus(r.changed ? `Added to ${r.changed} zone(s).` : "Didn't touch a Course area, so it was added as a new one.");
    }
  }

  const setLocked = (ids: string[], locked: boolean) => change({ ...course, features: course.features.map((f) => (ids.includes(f.id) ? { ...f, locked } : f)) });
  const clearCourse = () => {
    const n = course.cones.length;
    if (!n && !course.line.length && !course.start && !course.finish) { setStatus("Nothing to clear: there are no cones, driving line or timing lines."); return; }
    if (!confirm(`Clear the course? This removes all ${n} cones, the driving line and the start and finish lines. Your zones and site objects stay. (Undo is available.)`)) return;
    change({ ...course, cones: [], line: [], start: null, finish: null });
    setSelection(null);
    setStatus("Course cleared. Zones kept.");
  };

  // Smoothing slider: always simplify from the outline as it was when the zone was selected.
  const [smooth, setSmooth] = useState<{ id: string; base: Pt[]; tol: number } | null>(null);

  const undo = () => { if (!past.length) return; setSmooth(null); setFuture((f) => [course, ...f]); setCourse(past[past.length - 1]); setPast((p) => p.slice(0, -1)); };
  const redo = () => { if (!future.length) return; setSmooth(null); setPast((p) => [...p, course]); setCourse(future[0]); setFuture((f) => f.slice(1)); };

  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(AUTOSAVE_KEY, serialize(course)); } catch { /* image too big for autosave */ } }, 500);
    return () => clearTimeout(t);
  }, [course]);

  const sim = useMemo(() => simulate(course.line, course.settings.car, course.settings.wet), [course.line, course.settings.car, course.settings.wet]);
  const issues = useMemo(() => checkCourse(course, sim), [course, sim]);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
        if (e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(); }
        return;
      }
      const t = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (t && !(e.key.toLowerCase() === "r")) setTool(t.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- file actions
  const fileBase = course.name.replace(/[^\w\- ]+/g, "").trim() || "course";
  async function saveProject() {
    try { if (await saveText(`${fileBase}.axcourse`, serialize(course), "axcourse", "Autocross course")) setStatus("Saved."); }
    catch (e) { setStatus(`Save failed: ${e}`); }
  }
  async function openProject() {
    try {
      const f = await openFile(["axcourse", "json"], "Autocross course");
      if (!f?.text) return;
      const c = deserialize(f.text);
      change(c);
      setSelection(null);
      setTimeout(() => { mapRef.current?.flyTo(c.origin, 18); mapRef.current?.fitCourse(); }, 50);
      setStatus(`Opened ${f.name}`);
    } catch (e) { setStatus(`Open failed: ${e}`); }
  }
  function newProject() {
    if (!confirm("Start a new course? Unsaved changes in the current course will be lost (you can still undo).")) return;
    change({ ...newCourse(mapRef.current?.center()), settings: course.settings });
    setSelection(null);
  }
  async function importKmlFile() {
    try {
      const f = await openFile(["kml", "kmz"], "Google Earth KML/KMZ");
      if (!f?.text) return;
      const { course: c, summary } = importKml(f.text, course);
      change(c);
      setTimeout(() => { mapRef.current?.flyTo(c.origin, 18); mapRef.current?.fitCourse(); }, 50);
      setStatus(`Imported ${summary}. Check each area's type in the side panel.`);
    } catch (e) { setStatus(`KML import failed: ${e}`); }
  }
  async function importImage() {
    const f = await openFile(["png", "jpg", "jpeg", "webp"], "Image");
    if (!f?.dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const ftPerPx = 0.5;
      const w = img.width * ftPerPx, h = img.height * ftPerPx;
      let c = course;
      if (!c.cones.length && !c.features.length && !c.line.length) c = { ...c, origin: mapRef.current!.center() };
      change({ ...c, image: { dataUrl: f.dataUrl!, x: -w / 2, y: -h / 2, w, h, opacity: 0.85, pxW: img.width, pxH: img.height } });
      setTimeout(() => mapRef.current?.fitCourse(), 50);
      setTool("calibrate");
      setStatus("Image placed. Now click two points on the image a known distance apart (e.g. parking stripes, a runway marking) to set its scale.");
    };
    img.src = f.dataUrl;
  }
  async function doSearch() {
    const q = search.trim();
    if (!q) return;
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { mapRef.current?.flyTo({ lat: +m[1], lng: +m[2] }, 18); return; }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
      const j = await r.json();
      if (j[0]) mapRef.current?.flyTo({ lat: +j[0].lat, lng: +j[0].lon }, 17);
      else setStatus("Place not found. Try 'lat, lng'.");
    } catch { setStatus("Search needs an internet connection. You can type 'lat, lng' instead."); }
  }

  function applyCalibration(realFt: number) {
    if (!calib || !course.image || !(realFt > 0)) { setCalib(null); return; }
    const { a, b } = calib;
    const f = realFt / dist(a, b);
    const im = course.image;
    change({ ...course, image: { ...im, x: a.x + (im.x - a.x) * f, y: a.y + (im.y - a.y) * f, w: im.w * f, h: im.h * f } });
    setCalib(null);
    setTool("select");
    setStatus(`Image scale set: ${(im.w * f / im.pxW).toFixed(3)} ft per pixel.`);
  }

  const toolHint = tool === "feature" ? FEATURE_INFO[featureKind].help + (FEATURE_INFO[featureKind].point ? " Click to place." : FEATURE_INFO[featureKind].closed && options.zoneShape === "rect" ? " Click two opposite corners." : " Click each corner, then click the first point (or double-click / Enter) to close. Backspace removes the last point, Esc cancels.") : tool === "calibrate" ? "Click two points a known distance apart on the image." : tool === "image-move" ? "Click where the image center should go." : TOOLS.find((t) => t.id === tool)?.hint;

  const selCone = selection?.type === "cone" ? course.cones.find((k) => k.id === selection.id) : undefined;
  const selFeat = selection?.type === "feature" ? course.features.find((f) => f.id === selection.id) : undefined;
  const set = (s: Partial<Course["settings"]>) => change({ ...course, settings: { ...course.settings, ...s } });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" title="ApexSites.club Track Builder">
          <span className="brand-club">ApexSites.club</span> Track Builder
        </div>
        <button className="promo" onClick={() => openInBrowser(PROMO_URL)} title="Club websites, events, registration emails and course maps in one place">
          <span aria-hidden>🏁</span> Sign your club up for ApexSites.club
        </button>
        <input className="name" value={course.name} onChange={(e) => setCourse({ ...course, name: e.target.value })} title="Course name" />
        <div className="group">
          <button onClick={newProject}>New</button>
          <button onClick={openProject}>Open</button>
          <button onClick={saveProject}>Save</button>
          <button onClick={undo} disabled={!past.length} title="Ctrl+Z">Undo</button>
          <button onClick={redo} disabled={!future.length} title="Ctrl+Y">Redo</button>
        </div>
        <div className="group">
          <button onClick={importKmlFile} title="Import placemarks traced in Google Earth Pro">Import KML</button>
          <button onClick={importImage} title="Import a Google Earth Pro screenshot or any aerial image">Import image</button>
          <button onClick={async () => { if (await saveText(`${fileBase}.kml`, exportKml(course), "kml", "KML")) setStatus("KML exported. Open it in Google Earth."); }}>Export KML</button>
          <button onClick={async () => { if (await saveText(`${fileBase}.svg`, exportSvg(course, course.name), "svg", "SVG map")) setStatus("Course map exported."); }}>Export map</button>
        </div>
        <form className="search" onSubmit={(e) => { e.preventDefault(); doSearch(); }}>
          <input placeholder="Find site: address or lat, lng" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <select value={basemap} onChange={(e) => setBasemap(e.target.value as Basemap)} title="Background imagery">
          <option value="esri">Aerial (Esri)</option>
          <option value="usgs">Aerial (USGS, US only)</option>
          <option value="osm">Street map</option>
          <option value="none">No background</option>
        </select>
        <button className="apex-btn" onClick={() => setApexDlg("account")} title="Sign in to your club's Apex account">☁ {apex ? (apex.orgs.find((o) => o.id === apex.orgId)?.name ?? apex.email ?? "Apex") : "Sign in to Apex"}</button>
        <button onClick={clearCourse} title="Remove all cones, the driving line and the timing lines; keep zones">Clear course</button>
        <button className="primary" onClick={() => setGenOpen(true)}>Auto-generate</button>
        <button className="primary" disabled={!sim} onClick={() => setShow3D(true)} title={sim ? "" : "Draw a driving line first"}>3D run-through</button>
        <button onClick={() => setHelp(true)}>Help</button>
      </header>
      <UpdateBanner manualCheck={updCheck} />

      <div className="body">
        <aside className="tools">
          <div className="mode-switch">
            <button className={mode === "site" ? "on" : ""} onClick={() => { setMode("site"); setTool("select"); setSelection(null); }} title="Map the site: course area, paddock, don't-use zones, obstacles">🗺 Site map</button>
            <button className={mode === "course" ? "on" : ""} onClick={() => { setMode("course"); setTool("select"); setSelection(null); }} title="Design the course: timing, path and cones. Zones can't be clicked here.">🏁 Course</button>
          </div>
          <div className="seg-row">
            {TOOLS.filter((t) => t.id === "select" || t.id === "measure").map((t) => (
              <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>{t.id === "select" ? "Select" : "Measure"} <kbd>{t.key}</kbd></button>
            ))}
          </div>

          {mode === "site" ? (
            <>
          <div className="section-title">Community</div>
          <button onClick={() => setApexDlg("community")} title="Load a site map another club has shared">📚 Community track maps</button>
          <button onClick={() => setApexDlg("share")} title="Share this site map (zones and facilities, no cones) with other clubs">⇪ Share this site</button>
          {course.trackMap && <div className="small">From the library: {course.trackMap.name} v{course.trackMap.version}</div>}
          <div className="section-title">Zones</div>
          <button className={`wand ${tool === "wand" ? "on" : ""}`} onClick={() => setTool("wand")} title={TOOLS.find((t) => t.id === "wand")!.hint}>
            <span>✦ Find pavement</span><kbd>F</kbd>
          </button>
          <div className="seg-row edit-row">
            {TOOLS.filter((t) => t.id === "cut" || t.id === "add" || t.id === "straighten").map((t) => (
              <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>{t.id === "cut" ? "✂ Cut" : t.id === "add" ? "+ Add" : "⟋ Edge"}</button>
            ))}
          </div>
          {tool === "wand" && (
            <div className="wand-opts">
              <label>Tolerance <input type="range" min={4} max={40} step={1} value={wand.tolerance} onChange={(e) => setWand({ ...wand, tolerance: +e.target.value })} /> <span>{wand.tolerance}</span></label>
              <label>Create as
                <select value={wand.kind} onChange={(e) => setWand({ ...wand, kind: e.target.value as FeatureKind })}>
                  {(["paved", "paddock", "nogo", "grid"] as FeatureKind[]).map((k) => <option key={k} value={k}>{FEATURE_INFO[k].label}</option>)}
                </select>
              </label>
              <label className="chk" title="Stops at pavement borders even where nearby grass or dirt has a similar color. Turn off for heavily striped lots."><input type="checkbox" checked={wand.stopAtEdges} onChange={(e) => setWand({ ...wand, stopAtEdges: e.target.checked })} /> Stop at edges</label>
              <label className="chk"><input type="checkbox" checked={wand.holesAsNogo} onChange={(e) => setWand({ ...wand, holesAsNogo: e.target.checked })} /> Mark islands inside as Don't use</label>
            </div>
          )}
          {ZONE_KINDS.map((k) => (
            <button key={k} className={`zone ${tool === "feature" && featureKind === k ? "on" : ""}`} onClick={() => { setTool("feature"); setFeatureKind(k); }} title={FEATURE_INFO[k].help}>
              <span><i style={{ background: FEATURE_INFO[k].color }} />{FEATURE_INFO[k].label}</span>
            </button>
          ))}
          {tool === "feature" && FEATURE_INFO[featureKind].closed && (
            <div className="seg-row">
              {(["polygon", "rect"] as const).map((s) => (
                <button key={s} className={options.zoneShape === s ? "on" : ""} onClick={() => setOptions({ ...options, zoneShape: s })}>{s === "rect" ? "Rectangle" : "Multi-point"}</button>
              ))}
            </div>
          )}

          <div className="section-sub">Site objects</div>
          {(Object.keys(FEATURE_INFO) as FeatureKind[]).filter((k) => !ZONE_KINDS.includes(k) && !EVENT_KINDS.includes(k)).map((k) => (
            <button key={k} className={`zone ${tool === "feature" && featureKind === k ? "on" : ""}`} onClick={() => { setTool("feature"); setFeatureKind(k); }} title={FEATURE_INFO[k].help}>
              <span><i style={{ background: FEATURE_INFO[k].color }} />{FEATURE_INFO[k].label}</span>
            </button>
          ))}
          <div className="section-sub">Event facilities</div>
          {EVENT_KINDS.map((k) => (
            <button key={k} className={`zone ${tool === "feature" && featureKind === k ? "on" : ""}`} onClick={() => { setTool("feature"); setFeatureKind(k); }} title={FEATURE_INFO[k].help}>
              <span><b className="emo">{FEATURE_INFO[k].emoji}</b>{FEATURE_INFO[k].label}</span>
            </button>
          ))}

          {course.image && (
            <div className="opts">
              <b>Image overlay</b>
              <label>Opacity <input type="range" min={0.1} max={1} step={0.05} value={course.image.opacity} onChange={(e) => setCourse({ ...course, image: { ...course.image!, opacity: +e.target.value } })} /></label>
              <div className="small">{(course.image.w / course.image.pxW).toFixed(3)} ft/px</div>
              <button onClick={() => setTool("calibrate")}>Set scale…</button>
              <button onClick={() => setTool("image-move")}>Move image…</button>
              <button onClick={() => change({ ...course, image: null })}>Remove image</button>
            </div>
          )}
            </>
          ) : (
            <>
          <div className="section-title"><b>1</b> Timing</div>
          {(["start", "finish"] as const).map((id) => TOOLS.find((t) => t.id === id)!).map((t) => (
            <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>
              <span>{t.label}{course[t.id as "start" | "finish"] ? " ✓" : ""}</span><kbd>{t.key}</kbd>
            </button>
          ))}
          <div className="section-title"><b>2</b> Your path</div>
          {[TOOLS.find((t) => t.id === "line")!].map((t) => (
            <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>
              <span>{t.label}{course.line.length > 1 ? " ✓" : ""}</span><kbd>{t.key}</kbd>
            </button>
          ))}
          <div className="section-title"><b>3</b> Cones</div>
          <button className="primary" onClick={() => setGenOpen(true)}>Auto-generate cones</button>
          {(["cone", "pointer", "gate", "slalom", "wall"] as const).map((id) => TOOLS.find((t) => t.id === id)!).map((t) => (
            <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>
              <span>{t.label}</span><kbd>{t.key}</kbd>
            </button>
          ))}
          <div className="opts">
            <label>Slalom spacing <input type="number" min={30} max={120} value={options.slalomSpacing} onChange={(e) => setOptions({ ...options, slalomSpacing: +e.target.value || 66 })} /> ft</label>
            <label>Wall spacing <input type="number" min={2} max={30} value={options.wallSpacing} onChange={(e) => setOptions({ ...options, wallSpacing: +e.target.value || 6 })} /> ft</label>
          </div>
          <div className="section-title"><b>4</b> Publish</div>
          <button onClick={() => setApexDlg(apex ? "link" : "account")} title="Attach this course to one of your club's events on Apex">🔗 {course.apexLink ? "Update event link" : "Link to event"}</button>
          {course.apexLink && <div className="small">Linked: {course.apexLink.eventName} · {course.apexLink.title}</div>}
            </>
          )}
        </aside>

        <main className="mapwrap">
          <MapEditor
            ref={mapRef}
            course={course}
            sim={sim}
            issues={issues}
            tool={tool}
            featureKind={featureKind}
            options={options}
            basemap={basemap}
            selection={selection}
            onSelect={setSelection}
            onChange={change}
            onToolDone={() => setTool("select")}
            onStatus={setStatus}
            onCalibrate={(a, b) => setCalib({ a, b })}
            onShapeOp={onShapeOp}
            mode={mode}
            wand={wand}
          />
          <div className="hint">{toolHint}{status && <span className="status"> · {status}</span>}</div>
          <div className="legend"><span>Speed:</span><i style={{ background: "hsl(140,90%,50%)" }} />20<i style={{ background: "hsl(70,90%,50%)" }} />42<i style={{ background: "hsl(0,90%,50%)" }} />65+ mph</div>
        </main>

        <aside className="panel">
          <section>
            <h3>Course</h3>
            <div className="stats">
              <div><b>{course.cones.length}</b><span>cones</span></div>
              <div><b>{sim ? Math.round(sim.lengthFt) : "–"}</b><span>ft</span></div>
              <div><b>{sim ? sim.timeS.toFixed(1) : "–"}</b><span>sec</span></div>
              <div><b>{sim ? sim.maxMph.toFixed(0) : "–"}</b><span>top mph</span></div>
            </div>
          </section>

          {(selCone || selFeat || selection?.type === "line") && (
            <section>
              <h3>Selected</h3>
              {selCone && (
                <div className="props">
                  <label>Cone type
                    <select value={selCone.kind} onChange={(e) => change({ ...course, cones: course.cones.map((k) => (k.id === selCone.id ? { ...k, kind: e.target.value as typeof k.kind } : k)) })}>
                      <option value="standing">Standing</option><option value="pointer">Pointer</option><option value="timing">Timing light</option>
                    </select>
                  </label>
                  {selCone.kind === "pointer" && <label>Points toward <input type="number" value={Math.round(((selCone.rot ?? 0) * 180) / Math.PI)} onChange={(e) => change({ ...course, cones: course.cones.map((k) => (k.id === selCone.id ? { ...k, rot: (+e.target.value * Math.PI) / 180 } : k)) })} />° (R key)</label>}
                  {selCone.groupId && <button onClick={() => { change({ ...course, cones: course.cones.filter((k) => k.groupId !== selCone.groupId) }); setSelection(null); }}>Delete whole {selCone.group}</button>}
                  <button onClick={() => { change({ ...course, cones: course.cones.filter((k) => k.id !== selCone.id) }); setSelection(null); }}>Delete cone</button>
                </div>
              )}
              {selFeat && (
                <div className="props">
                  <label>Type
                    <select value={selFeat.kind} disabled={selFeat.locked} onChange={(e) => { const k = e.target.value as FeatureKind; change({ ...course, features: course.features.map((f) => (f.id === selFeat.id ? { ...f, kind: k, closed: FEATURE_INFO[k].closed && f.pts.length >= 3 } : f)) }); }}>
                      {(Object.keys(FEATURE_INFO) as FeatureKind[]).map((k) => <option key={k} value={k}>{FEATURE_INFO[k].label}</option>)}
                    </select>
                  </label>
                  <label>Label <input value={selFeat.label ?? ""} onChange={(e) => setCourse({ ...course, features: course.features.map((f) => (f.id === selFeat.id ? { ...f, label: e.target.value } : f)) })} /></label>
                  <div className="small">{FEATURE_INFO[selFeat.kind].help} {selFeat.locked ? "Locked, so it can't be reshaped, cut or deleted." : "Drag the white handles to reshape, drag a small midpoint dot to add a corner, right-click a handle to remove it."}</div>
                  <button className={selFeat.locked ? "on" : ""} onClick={() => setLocked([selFeat.id], !selFeat.locked)}>{selFeat.locked ? "🔒 Locked: click to unlock" : "🔓 Lock this zone"}</button>
                  {selFeat.closed && !selFeat.locked && (
                    <>
                      <div className="seg-row">
                        <button className={tool === "cut" ? "on" : ""} onClick={() => setTool("cut")} title={TOOLS.find((t) => t.id === "cut")!.hint}>✂ Cut away</button>
                        <button className={tool === "add" ? "on" : ""} onClick={() => setTool("add")} title={TOOLS.find((t) => t.id === "add")!.hint}>+ Add area</button>
                        <button className={tool === "straighten" ? "on" : ""} onClick={() => setTool("straighten")} title={TOOLS.find((t) => t.id === "straighten")!.hint}>⟋ Straighten</button>
                      </div>
                      <label title="Removes small wiggles: corners closer than this to a straight line are dropped.">Smooth edges
                        <input type="range" min={0} max={40} step={1}
                          value={smooth?.id === selFeat.id ? smooth.tol : 0}
                          onPointerDown={() => { if (smooth?.id !== selFeat.id) { setSmooth({ id: selFeat.id, base: selFeat.pts, tol: 0 }); } change(course); }}
                          onChange={(e) => {
                            const tol = +e.target.value;
                            const base = smooth?.id === selFeat.id ? smooth.base : selFeat.pts;
                            setSmooth({ id: selFeat.id, base, tol });
                            setCourse({ ...course, features: course.features.map((f) => (f.id === selFeat.id ? { ...f, pts: smoothOutline(base, tol) } : f)) });
                          }} />
                        <span className="small">{selFeat.pts.length} corners</span>
                      </label>
                    </>
                  )}
                  {!selFeat.locked && <button onClick={() => { change({ ...course, features: course.features.filter((f) => f.id !== selFeat.id) }); setSelection(null); }}>Delete</button>}
                </div>
              )}
              {selection?.type === "line" && (
                <div className="props">
                  <div className="small">{course.line.length} pins. Drag a pin to move it; drag a small dot between pins, or click the line, to add a pin; right-click a pin to remove it. The Driving line tool extends the end.</div>
                  <button onClick={() => change({ ...course, line: [...course.line].reverse() })}>Reverse direction</button>
                  <button onClick={() => { change({ ...course, line: [] }); setSelection(null); }}>Clear driving line</button>
                </div>
              )}
            </section>
          )}

          <section>
            <h3>Zones {(() => {
              const zs = course.features.filter((f) => ZONE_KINDS.includes(f.kind) && f.closed);
              if (!zs.length) return null;
              const all = zs.every((f) => f.locked);
              return <button className="mini" onClick={() => { setLocked(zs.map((f) => f.id), !all); setStatus(all ? "Zones unlocked." : "All zones locked. They can't be reshaped, cut or deleted until unlocked."); }}>{all ? "🔓 Unlock all" : "🔒 Lock all"}</button>;
            })()}</h3>
            {course.features.filter((f) => ZONE_KINDS.includes(f.kind) && f.closed).length === 0 ? (
              <div className="small">No zones yet. Start with <b>1 Site zones → Course area</b> to mark where the course may go, then Paddock and Don't use.</div>
            ) : (
              <ul className="zones">
                {course.features.filter((f) => ZONE_KINDS.includes(f.kind) && f.closed).map((f) => {
                  const sqft = polygonArea(f.pts);
                  const sel = selection?.type === "feature" && selection.id === f.id;
                  return (
                    <li key={f.id} className={sel ? "on" : ""} onClick={() => { setMode("site"); setTool("select"); setSelection({ type: "feature", id: f.id }); mapRef.current?.focus({ x: f.pts.reduce((a, p) => a + p.x, 0) / f.pts.length, y: f.pts.reduce((a, p) => a + p.y, 0) / f.pts.length }); }}>
                      <i style={{ background: FEATURE_INFO[f.kind].color }} />
                      <span>{f.label || FEATURE_INFO[f.kind].label}</span>
                      <button className="lock" title={f.locked ? "Locked: click to unlock" : "Lock this zone"} onClick={(e) => { e.stopPropagation(); setLocked([f.id], !f.locked); }}>{f.locked ? "🔒" : "🔓"}</button>
                      <em>{sqft >= 43560 ? `${(sqft / 43560).toFixed(2)} ac` : `${Math.round(sqft).toLocaleString()} ft²`}</em>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="checks">
            <h3>Safety & rules check <span className={`badge ${errors ? "err" : warns ? "warn" : "ok"}`}>{errors ? `${errors} error${errors > 1 ? "s" : ""}` : warns ? `${warns} warning${warns > 1 ? "s" : ""}` : "OK"}</span></h3>
            <ul>
              {issues.map((iss: Issue, i) => (
                <li key={i} className={iss.severity} onClick={() => iss.at && mapRef.current?.focus(iss.at)} style={{ cursor: iss.at ? "pointer" : "default" }}>
                  <b>{iss.title}</b>
                  <span>{iss.detail}</span>
                </li>
              ))}
            </ul>
            <div className="small">Checks follow the SCCA Solo Rules margins and Course Designer training guidance. They support, not replace, the Safety Steward's walk-through.</div>
          </section>

          <section>
            <h3>Event settings</h3>
            <label className="row">Speed check car
              <select value={course.settings.car.name} onChange={(e) => set({ car: CAR_PRESETS.find((c) => c.name === e.target.value)! })}>
                {CAR_PRESETS.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </label>
            <label className="row chk"><input type="checkbox" checked={course.settings.karts} onChange={(e) => set({ karts: e.target.checked })} /> Karts running (50 ft obstacle margin)</label>
            <label className="row chk"><input type="checkbox" checked={course.settings.multipleCarsOnCourse} onChange={(e) => set({ multipleCarsOnCourse: e.target.checked })} /> Multiple cars on course (75 ft between sections)</label>
            <label className="row chk"><input type="checkbox" checked={course.settings.wet} onChange={(e) => set({ wet: e.target.checked })} /> Wet conditions</label>
            <label className="row chk"><input type="checkbox" checked={course.settings.nationalsLevel} onChange={(e) => set({ nationalsLevel: e.target.checked })} /> National-level event (15 ft width, 45 ft slalom mandatory)</label>
          </section>
        </aside>
      </div>

      {show3D && sim && <Run3D course={course} sim={sim} basemap={basemap} onClose={() => setShow3D(false)} />}
      {genOpen && <GenerateDialog course={course} slalomSpacing={options.slalomSpacing} onCones={(r) => { change({ ...course, line: r.line, baseLine: r.line === r.base ? undefined : r.base, cones: [...course.cones.filter((k) => k.group === "start" || k.group === "finish"), ...r.cones] }); setGenOpen(false); setSelection(null); setStatus(`Placed ${r.cones.length} cones along your line${r.moved ? `, moved ${r.moved} gate(s) to stay on pavement` : ""}${r.dropped ? `, left out ${r.dropped} cone(s) with no room` : ""}. Drag any cone to adjust; Undo to take them back.`); }} onClose={() => setGenOpen(false)} onPickTool={(t) => { setGenOpen(false); setTool(t); }} onApply={(r) => { change({ ...course, line: r.line, cones: [...course.cones.filter((k) => k.group === "start" || k.group === "finish"), ...r.cones] }); setGenOpen(false); setSelection(null); setStatus(`Generated: ${Math.round(r.lengthFt)} ft, ~${r.timeS.toFixed(1)} s, top ${r.maxMph.toFixed(0)} mph${r.crossovers ? `, ${r.crossovers} crossover${r.crossovers > 1 ? "s" : ""}` : ""}. Click Auto-generate again for a different layout.`); }} />}
      {calib && <CalibDialog measured={dist(calib.a, calib.b)} onOk={applyCalibration} onCancel={() => setCalib(null)} />}
      {apexDlg === "account" && <ApexAccountDialog session={apex} onSession={setApex} onClose={() => setApexDlg(null)} />}
      {apexDlg === "link" && <LinkEventDialog session={apex} course={course} stats={{ lengthFt: sim?.lengthFt }} onSignIn={() => setApexDlg("account")} onClose={() => setApexDlg(null)}
        onLinked={(link, message) => { change({ ...course, apexLink: link }); setApexDlg(null); setStatus(message); }} />}
      {apexDlg === "community" && <CommunityDialog near={mapRef.current?.center() ?? course.origin} onClose={() => setApexDlg(null)}
        onLoad={(tm) => {
          const hasWork = course.cones.length > 0 || course.line.length > 0 || course.features.length > 0;
          if (hasWork && !confirm(`Start a new course on "${tm.name}"? This replaces the current course (Undo is available).`)) return;
          const c = { ...newCourse(tm.site.origin), name: tm.name, features: tm.site.features, settings: course.settings, trackMap: { id: tm.id, orgId: tm.organization_id, name: tm.name, version: tm.version } };
          change(c);
          setSelection(null);
          setApexDlg(null);
          setMode("course");
          setStatus(`Loaded the "${tm.name}" site map${tm.club ? ` shared by ${tm.club}` : ""}. Place the start and finish to begin designing.`);
          setTimeout(() => { mapRef.current?.flyTo(c.origin, 17); mapRef.current?.fitCourse(); }, 50);
        }} />}
      {apexDlg === "share" && <ShareSiteDialog session={apex} course={course} onSignIn={() => setApexDlg("account")} onClose={() => setApexDlg(null)}
        onShared={(tm, message) => { change({ ...course, trackMap: tm }); setApexDlg(null); setStatus(message); }} />}
      {help && <HelpDialog onCheckUpdates={() => { setUpdCheck((n) => n + 1); localStorage.setItem("acd.seenHelp", "1"); setHelp(false); }} onClose={() => { localStorage.setItem("acd.seenHelp", "1"); setHelp(false); }} />}
    </div>
  );
}

/** Feet of the (smoothed) driving line outside the Course area or inside a Don't-use zone. */
function lineOffArea(c: Course): number {
  const paved = c.features.filter((f) => f.kind === "paved" && f.pts.length >= 3);
  const nogo = c.features.filter((f) => f.kind === "nogo" && f.pts.length >= 3);
  const pts = smoothPath(c.line, 4);
  return pts.filter((p) => (paved.length && !paved.some((f) => pointInPolygon(p, f.pts))) || nogo.some((f) => pointInPolygon(p, f.pts))).length * 4;
}

const SITE_TOOLS: Tool[] = ["feature", "wand", "cut", "add", "straighten", "calibrate", "image-move"];
const COURSE_TOOLS: Tool[] = ["start", "finish", "cone", "pointer", "gate", "slalom", "wall", "line"];

function GenerateDialog({ course, onClose, onApply, onPickTool, onCones, slalomSpacing }: { course: Course; onClose(): void; onApply(r: GenResult): void; onPickTool(t: Tool): void; onCones(r: { line: Pt[]; base: Pt[]; cones: Cone[]; moved: number; dropped: number }): void; slalomSpacing: number }) {
  const [technical, setTechnical] = useState(0.4);
  const [cross, setCross] = useState<boolean | null>(null);
  const hasLine = course.line.length > 1;
  const [designPath, setDesignPath] = useState(false);
  const [straights, setStraights] = useState<StraightStyle>("mix");
  const [detail, setDetail] = useState(true);
  const placeCones = () => {
    const r = conesForLine(course, { straights, detail, slalomSpacing, seed: Math.floor(Math.random() * 1e9) });
    if (!r) { setMsg("ERROR:The driving line is too short to place cones along."); return; }
    const n = course.cones.filter((k) => k.group !== "start" && k.group !== "finish").length;
    if (n && !confirm(`Replace the current ${n} cones with cones along your line? Your start and finish stay. (Undo is available.)`)) return;
    onCones(r);
  };
  const offArea = hasLine ? lineOffArea(course) : 0;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const hasPaved = course.features.some((f) => f.kind === "paved" && f.pts.length >= 3);
  const ready = hasPaved && !!course.start && !!course.finish;
  const run = () => {
    setBusy(true);
    setMsg("Generating and checking candidate courses…");
    setTimeout(() => {
      const stats: GenStats = { noStart: 0, noFinish: 0, lengths: [] };
      const r = generateCourse(course, { seed: Math.floor(Math.random() * 1e9), attempts: 150, technical, allowCrossovers: !!cross, stats, timeBudgetMs: 8000 });
      setBusy(false);
      if (!r) {
        setMsg("ERROR:" + (stats.reason === "start"
          ? "There isn't 120 ft of clear Course area straight ahead of the start line, in either direction. Move the start line or adjust the zones."
          : stats.reason === "finish"
          ? "The finish line needs 70 ft of straight approach and about 200 ft of clear runout beyond it, inside the Course area and away from people. Move the finish line or adjust the zones."
          : Math.max(0, ...stats.lengths) < 300
          ? "The course can't get going past the start: there's no room to turn after the launch. Aim the start down a longer stretch of Course area."
          : `Couldn't connect the start to the finish with a safe course (longest attempt ${Math.max(0, ...stats.lengths)} ft). Try again, try ${cross ? "a more technical style" : "allowing crossovers"}, or move the start or finish so there's more room between them.`));
        return;
      }
      const n = course.cones.filter((k) => k.group !== "start" && k.group !== "finish").length;
      if ((n || course.line.length) && !confirm(`Replace the current ${n} cones and driving line with the generated course? Your start and finish stay. (Undo is available.)`)) return;
      onApply(r);
    }, 30);
  };
  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>Auto-generate a course</h2>
        {!hasPaved ? (
          <p>First outline the usable pavement with <b>1 Site zones → Course area</b> (or ✦ Find pavement), and mark Don't-use, obstacle, spectator, paddock and grid areas.</p>
        ) : !ready ? (
          <>
            <p>Place your timing lines first. The course runs from your start to your finish.</p>
            <ul className="gen-steps">
              <li className={course.start ? "done" : ""}>{course.start ? "✓ Start line placed" : <button onClick={() => onPickTool("start")}>Place start line</button>}</li>
              <li className={course.finish ? "done" : ""}>{course.finish ? "✓ Finish line placed" : <button onClick={() => onPickTool("finish")}>Place finish line</button>}</li>
            </ul>
            <p className="small">Click both timing lights for each line. Leave about 120 ft of room after the start, and 70 ft of approach plus about 200 ft of runout around the finish.</p>
          </>
        ) : !designPath ? (
          <>
            <ul className="gen-steps">
              <li className="done">✓ Start and finish placed</li>
              <li className={hasLine ? "done" : ""}>{hasLine ? "✓ Driving line drawn" : <button onClick={() => onPickTool("line")}>Draw your driving line</button>}</li>
            </ul>
            {hasLine ? (
              <>
                <p className="small">Places gates and apex pointers in each turn, gates on long sweepers, the finish chute and a slow-down gate along the line you drew.</p>
                <label className="row">Long straights (250 ft+)
                  <select value={straights} onChange={(e) => setStraights(e.target.value as StraightStyle)}>
                    <option value="mix">Mix of slaloms and offsets</option>
                    <option value="slalom">Slaloms ({slalomSpacing} ft)</option>
                    <option value="offset">Offset gates</option>
                    <option value="none">Leave plain</option>
                  </select>
                </label>
                <label className="chk"><input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} /> Entry and exit gates on turns, not just the apex</label>
                <p className="small">Slaloms and offsets make the line weave through them. Cones that would land off the Course area or in a Don't-use zone are moved or left out. A slow-down gate goes after the finish.</p>
                {offArea > 0 && <p className="gen-error">About {offArea} ft of your driving line runs outside the Course area or through a Don't-use zone (orange circles on the map). Fix the line first, or cones there will be left out.</p>}
              </>
            ) : (
              <p className="small">Click from the start line along the path you want, and click near the finish line to end there. Then come back here to place the cones.</p>
            )}
            <p className="small"><a href="#" onClick={(e) => { e.preventDefault(); setDesignPath(true); }}>Or let it design the path too…</a></p>
          </>
        ) : (
          <>
            <p className="small">Designs a path from your start line to your finish line (sweepers, 90s, slaloms and offsets), keeping the Course area margins, then simulates and rule-checks the candidates and keeps the best. This replaces your driving line.</p>
            <div className="gen-q">
              <div>Allow crossovers?</div>
              <div className="seg-row">
                <button className={cross === false ? "on" : ""} onClick={() => setCross(false)}>No</button>
                <button className={cross === true ? "on" : ""} onClick={() => setCross(true)}>Yes</button>
              </div>
              <div className="small">Crossovers let the course cross itself at a steep angle (up to twice). Only for running one car on course at a time.</div>
            </div>
            <label className="row">Style: open <input type="range" min={0} max={1} step={0.1} value={technical} onChange={(e) => setTechnical(+e.target.value)} /> technical</label>
            <p className="small"><a href="#" onClick={(e) => { e.preventDefault(); setDesignPath(false); }}>← Back to cones for my own line</a></p>
          </>
        )}
        {msg && (msg.startsWith("ERROR:") ? <p className="gen-error">{msg.slice(6)}</p> : <p className="small">{msg}</p>)}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          {ready && !designPath
            ? <button className="primary" disabled={!hasLine} onClick={placeCones}>Place cones</button>
            : <button className="primary" disabled={!ready || cross === null || busy} onClick={run} title={ready && cross === null ? "Answer the crossover question first" : ""}>{busy ? "Working…" : "Design path and cones"}</button>}
        </div>
      </div>
    </div>
  );
}

function CalibDialog({ measured, onOk, onCancel }: { measured: number; onOk(ft: number): void; onCancel(): void }) {
  const [v, setV] = useState("");
  return (
    <div className="modal-bg">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onOk(+v); }}>
        <h2>Set image scale</h2>
        <p className="small">Those points are currently {measured.toFixed(1)} ft apart on the image. Typical references: parking stall width 9 ft, stall depth 18 ft, runway centerline stripe 120 ft + 80 ft gap.</p>
        <label className="row">Real distance <input autoFocus type="number" step="0.1" value={v} onChange={(e) => setV(e.target.value)} /> ft</label>
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Apply</button></div>
      </form>
    </div>
  );
}

function HelpDialog({ onClose, onCheckUpdates }: { onClose(): void; onCheckUpdates(): void }) {
  const [ver, setVer] = useState("");
  useEffect(() => { if ("__TAURI_INTERNALS__" in window) getVersion().then(setVer).catch(() => {}); }, []);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Quick start</h2>
        <ol>
          <li><b>Find the site.</b> Search an address or "lat, lng", or import a Google Earth Pro screenshot (<i>Import image</i>, then set its scale) or KML of placemarks you traced in Google Earth.</li>
          <li><b>Define zones.</b> The fastest way is <b>Find pavement</b>: click inside a lot or runway and the app outlines it from the aerial photo (Shift-click to add more, adjust Tolerance to grow or shrink). Or draw zones by hand under <i>Site zones</i>: draw the <b>Course area</b> (where the course may go), the <b>Paddock</b>, and any <b>Don't use</b> areas, plus grid and spectator areas. Draw rectangles with two corner clicks, or switch to Polygon for odd shapes. Then mark light poles, curbs, buildings/fences and surface hazards under <i>Site objects</i>.</li>
          <li><b>Design.</b> Draw the <b>driving line</b> from start to finish, place the start and finish lines, then gates, slaloms, pointer cones and walls. Or switch to <b>🏁 Course</b>, place the start and finish lines, draw your path with <i>Driving line</i>, and click <i>Auto-generate cones</i> to place gates, pointers and the finish chute along it (it can also design the path for you). <i>Clear course</i> removes cones, line and timing lines but keeps your zones. Use the 🔒 in the Zones list (or <i>Lock all</i>) so finished zones can't be changed by accident.</li>
          <li><b>Check.</b> The right panel re-checks every change: 25 ft to solid objects (50 ft with karts), 75 ft to people, pavement edges, top speed (mid‑60s mph), long acceleration zones, slalom spacing, gate width, finish runout and aim, and worker coverage. Click an item to jump to it.</li>
          <li><b>Drive it.</b> <i>3D run-through</i> drives the simulated line in driver, chase or free-orbit view.</li>
          <li><b>Share.</b> Save the .axcourse project, export KML to view it in Google Earth, or export a printable SVG course map.</li>
        </ol>
        <p className="small">Keys: F find pavement, V select, L line, C cone, P pointer, G gate, S slalom, W wall, 1 start, 2 finish, A area, M measure, R rotate pointer, Delete remove, Enter finish shape, Esc cancel, Ctrl+Z / Ctrl+Y undo/redo, Ctrl+S save.</p>
        <p className="small">Imagery: Esri World Imagery and USGS The National Map. Speeds come from a point-mass simulation and are estimates. Always walk the course with the Event Chair and Safety Steward.</p>
        <div className="actions">{ver && <span className="small" style={{ marginRight: "auto" }}>Version {ver}</span>}<button onClick={onCheckUpdates}>Check for updates</button><button className="primary" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  );
}
