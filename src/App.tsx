import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { dist, type Pt } from "./geo";
import { generateCourse, suggestedLength, type GenResult } from "./generate";
import { deserialize, exportKml, exportSvg, importKml, openFile, saveText, serialize } from "./io";
import MapEditor, { type Basemap, type MapHandle, type Selection, type Tool, type ToolOptions, type WandSettings } from "./MapEditor";
import { CAR_PRESETS, FEATURE_INFO, ZONE_KINDS, newCourse, type Course, type FeatureKind } from "./model";
import { polygonArea } from "./geo";
import { checkCourse, type Issue } from "./rules";
import Run3D from "./Run3D";
import { simulate } from "./sim";

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
  { id: "wand", label: "Find pavement", key: "F", hint: "Click inside a parking lot or runway to outline it from the aerial photo. Shift-click to add more; adjust Tolerance to grow or shrink. Zoom so the area fills most of the view." },
];

export default function App() {
  const [course, setCourse] = useState<Course>(loadAutosave);
  const [past, setPast] = useState<Course[]>([]);
  const [future, setFuture] = useState<Course[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [featureKind, setFeatureKind] = useState<FeatureKind>("paved");
  const [selection, setSelection] = useState<Selection>(null);
  const [options, setOptions] = useState<ToolOptions>({ gateWidth: 22, slalomSpacing: 66, wallSpacing: 6, zoneShape: "polygon" });
  const [wand, setWand] = useState<WandSettings>({ tolerance: 16, kind: "paved", holesAsNogo: true, stopAtEdges: true });
  const [basemap, setBasemap] = useState<Basemap>("esri");
  const [status, setStatus] = useState("");
  const [show3D, setShow3D] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [help, setHelp] = useState(() => !localStorage.getItem("acd.seenHelp"));
  const [calib, setCalib] = useState<{ a: Pt; b: Pt } | null>(null);
  const [search, setSearch] = useState("");
  const mapRef = useRef<MapHandle>(null);

  const change = useCallback((c: Course) => {
    setCourse((prev) => {
      setPast((p) => [...p.slice(-99), prev]);
      setFuture([]);
      return c;
    });
  }, []);
  const undo = () => { if (!past.length) return; setFuture((f) => [course, ...f]); setCourse(past[past.length - 1]); setPast((p) => p.slice(0, -1)); };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, course]); setCourse(future[0]); setFuture((f) => f.slice(1)); };

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
        <div className="brand">Autocross Course Designer</div>
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
        <button className="primary" onClick={() => setGenOpen(true)}>Auto-generate</button>
        <button className="primary" disabled={!sim} onClick={() => setShow3D(true)} title={sim ? "" : "Draw a driving line first"}>3D run-through</button>
        <button onClick={() => setHelp(true)}>Help</button>
      </header>

      <div className="body">
        <aside className="tools">
          <div className="seg-row">
            {TOOLS.filter((t) => t.id === "select" || t.id === "measure").map((t) => (
              <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>{t.id === "select" ? "Select" : "Measure"} <kbd>{t.key}</kbd></button>
            ))}
          </div>

          <div className="section-title"><b>1</b> Site zones</div>
          <button className={`wand ${tool === "wand" ? "on" : ""}`} onClick={() => setTool("wand")} title={TOOLS.find((t) => t.id === "wand")!.hint}>
            <span>✦ Find pavement</span><kbd>F</kbd>
          </button>
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
          {(Object.keys(FEATURE_INFO) as FeatureKind[]).filter((k) => !ZONE_KINDS.includes(k)).map((k) => (
            <button key={k} className={`zone ${tool === "feature" && featureKind === k ? "on" : ""}`} onClick={() => { setTool("feature"); setFeatureKind(k); }} title={FEATURE_INFO[k].help}>
              <span><i style={{ background: FEATURE_INFO[k].color }} />{FEATURE_INFO[k].label}</span>
            </button>
          ))}

          {([["2", "Timing", ["start", "finish"]], ["3", "Course", ["cone", "pointer", "gate", "slalom", "wall", "line"]]] as const).map(([n, title, ids]) => (
            <div key={n} className="tool-group">
              <div className="section-title"><b>{n}</b> {title}</div>
              {ids.map((id) => TOOLS.find((t) => t.id === id)!).map((t) => (
                <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.hint} (${t.key})`}>
                  <span>{t.label}</span><kbd>{t.key}</kbd>
                </button>
              ))}
            </div>
          ))}
          <div className="opts">
            <label>Slalom spacing <input type="number" min={30} max={120} value={options.slalomSpacing} onChange={(e) => setOptions({ ...options, slalomSpacing: +e.target.value || 66 })} /> ft</label>
            <label>Wall spacing <input type="number" min={2} max={30} value={options.wallSpacing} onChange={(e) => setOptions({ ...options, wallSpacing: +e.target.value || 6 })} /> ft</label>
          </div>
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
                    <select value={selFeat.kind} onChange={(e) => { const k = e.target.value as FeatureKind; change({ ...course, features: course.features.map((f) => (f.id === selFeat.id ? { ...f, kind: k, closed: FEATURE_INFO[k].closed && f.pts.length >= 3 } : f)) }); }}>
                      {(Object.keys(FEATURE_INFO) as FeatureKind[]).map((k) => <option key={k} value={k}>{FEATURE_INFO[k].label}</option>)}
                    </select>
                  </label>
                  <label>Label <input value={selFeat.label ?? ""} onChange={(e) => setCourse({ ...course, features: course.features.map((f) => (f.id === selFeat.id ? { ...f, label: e.target.value } : f)) })} /></label>
                  <div className="small">{FEATURE_INFO[selFeat.kind].help} Drag the white handles to reshape; right-click a handle to remove it.</div>
                  <button onClick={() => { change({ ...course, features: course.features.filter((f) => f.id !== selFeat.id) }); setSelection(null); }}>Delete</button>
                </div>
              )}
              {selection?.type === "line" && (
                <div className="props">
                  <div className="small">{course.line.length} control points. Drag handles to reshape; right-click to remove. Use the Driving line tool to extend.</div>
                  <button onClick={() => change({ ...course, line: [...course.line].reverse() })}>Reverse direction</button>
                  <button onClick={() => { change({ ...course, line: [] }); setSelection(null); }}>Clear driving line</button>
                </div>
              )}
            </section>
          )}

          <section>
            <h3>Zones</h3>
            {course.features.filter((f) => ZONE_KINDS.includes(f.kind) && f.closed).length === 0 ? (
              <div className="small">No zones yet. Start with <b>1 Site zones → Course area</b> to mark where the course may go, then Paddock and Don't use.</div>
            ) : (
              <ul className="zones">
                {course.features.filter((f) => ZONE_KINDS.includes(f.kind) && f.closed).map((f) => {
                  const sqft = polygonArea(f.pts);
                  const sel = selection?.type === "feature" && selection.id === f.id;
                  return (
                    <li key={f.id} className={sel ? "on" : ""} onClick={() => { setTool("select"); setSelection({ type: "feature", id: f.id }); mapRef.current?.focus({ x: f.pts.reduce((a, p) => a + p.x, 0) / f.pts.length, y: f.pts.reduce((a, p) => a + p.y, 0) / f.pts.length }); }}>
                      <i style={{ background: FEATURE_INFO[f.kind].color }} />
                      <span>{f.label || FEATURE_INFO[f.kind].label}</span>
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
      {genOpen && <GenerateDialog course={course} onClose={() => setGenOpen(false)} onApply={(r) => { change({ ...course, line: r.line, cones: r.cones, start: r.start, finish: r.finish }); setGenOpen(false); setSelection(null); setStatus(`Generated: ${Math.round(r.lengthFt)} ft, ~${r.timeS.toFixed(1)} s, top ${r.maxMph.toFixed(0)} mph.`); }} />}
      {calib && <CalibDialog measured={dist(calib.a, calib.b)} onOk={applyCalibration} onCancel={() => setCalib(null)} />}
      {help && <HelpDialog onClose={() => { localStorage.setItem("acd.seenHelp", "1"); setHelp(false); }} />}
    </div>
  );
}

function GenerateDialog({ course, onClose, onApply }: { course: Course; onClose(): void; onApply(r: GenResult): void }) {
  const [target, setTarget] = useState(() => suggestedLength(course));
  const [technical, setTechnical] = useState(0.4);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const hasPaved = course.features.some((f) => f.kind === "paved" && f.pts.length >= 3);
  const run = () => {
    setBusy(true);
    setMsg("Generating and checking candidate courses…");
    setTimeout(() => {
      const r = generateCourse(course, { targetLengthFt: target, seed, attempts: 150, technical });
      setBusy(false);
      if (!r) { setMsg("Couldn't fit a course. Check that the paved area is large enough after margins (25 ft to obstacles, 75 ft to people), or lower the target length."); return; }
      if (course.cones.length && !confirm(`Replace the current ${course.cones.length} cones and driving line with the generated course? (Undo is available.)`)) return;
      onApply(r);
    }, 30);
  };
  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>Auto-generate a course</h2>
        {!hasPaved ? <p>First outline the usable pavement with <b>Site area / object → Paved area</b>, and mark obstacles, light poles, spectator, paddock and grid areas. The generator keeps the course inside the pavement with Solo Rules margins.</p> : (
          <>
            <p className="small">Builds a mix of sweepers, 90s, slaloms (60–74 ft) and offsets with alternating directions, keeps straights short, fits a finish with runout, then simulates and rule-checks 150 candidates and keeps the best. Treat it as a starting point and refine by hand.</p>
            <label className="row">Target length <input type="number" step={100} value={target} onChange={(e) => setTarget(+e.target.value)} /> ft</label>
            <label className="row">Style: open <input type="range" min={0} max={1} step={0.1} value={technical} onChange={(e) => setTechnical(+e.target.value)} /> technical</label>
            <label className="row">Seed <input type="number" value={seed} onChange={(e) => setSeed(+e.target.value)} /> <button onClick={() => setSeed(Math.floor(Math.random() * 100000))}>Random</button></label>
          </>
        )}
        {msg && <p className="small">{msg}</p>}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!hasPaved || busy} onClick={run}>{busy ? "Working…" : "Generate"}</button>
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

function HelpDialog({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Quick start</h2>
        <ol>
          <li><b>Find the site.</b> Search an address or "lat, lng", or import a Google Earth Pro screenshot (<i>Import image</i>, then set its scale) or KML of placemarks you traced in Google Earth.</li>
          <li><b>Define zones.</b> The fastest way is <b>Find pavement</b>: click inside a lot or runway and the app outlines it from the aerial photo (Shift-click to add more, adjust Tolerance to grow or shrink). Or draw zones by hand under <i>Site zones</i>: draw the <b>Course area</b> (where the course may go), the <b>Paddock</b>, and any <b>Don't use</b> areas, plus grid and spectator areas. Draw rectangles with two corner clicks, or switch to Polygon for odd shapes. Then mark light poles, curbs, buildings/fences and surface hazards under <i>Site objects</i>.</li>
          <li><b>Design.</b> Draw the <b>driving line</b> from start to finish, place the start and finish lines, then gates, slaloms, pointer cones and walls. Or click <i>Auto-generate</i>.</li>
          <li><b>Check.</b> The right panel re-checks every change: 25 ft to solid objects (50 ft with karts), 75 ft to people, pavement edges, top speed (mid‑60s mph), long acceleration zones, slalom spacing, gate width, finish runout and aim, and worker coverage. Click an item to jump to it.</li>
          <li><b>Drive it.</b> <i>3D run-through</i> drives the simulated line in driver, chase or free-orbit view.</li>
          <li><b>Share.</b> Save the .axcourse project, export KML to view it in Google Earth, or export a printable SVG course map.</li>
        </ol>
        <p className="small">Keys: F find pavement, V select, L line, C cone, P pointer, G gate, S slalom, W wall, 1 start, 2 finish, A area, M measure, R rotate pointer, Delete remove, Enter finish shape, Esc cancel, Ctrl+Z / Ctrl+Y undo/redo, Ctrl+S save.</p>
        <p className="small">Imagery: Esri World Imagery and USGS The National Map. Speeds come from a point-mass simulation and are estimates. Always walk the course with the Event Chair and Safety Steward.</p>
        <div className="actions"><button className="primary" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  );
}
