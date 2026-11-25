import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FT_PER_S_PER_MPH, bbox, toLatLng, toLocal, type Pt } from "./geo";
import { FEATURE_INFO, type Course } from "./model";
import type { Basemap } from "./MapEditor";
import type { SimResult } from "./sim";

type View = "driver" | "chase" | "orbit";

interface Props { course: Course; sim: SimResult; basemap: Basemap; onClose(): void }

const TILE_URL: Partial<Record<Basemap, string>> = {
  esri: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  usgs: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
};

const v3 = (p: Pt, h = 0) => new THREE.Vector3(p.x, h, -p.y);

function loadImg(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

/** Stitches aerial tiles under the course into one texture. */
async function aerialGround(c: Course, basemap: Basemap, b: { minX: number; minY: number; maxX: number; maxY: number }) {
  const url = TILE_URL[basemap];
  if (!url) return null;
  const sw = toLatLng({ x: b.minX, y: b.minY }, c.origin);
  const ne = toLatLng({ x: b.maxX, y: b.maxY }, c.origin);
  const tx = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
  const ty = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
  let z = basemap === "usgs" ? 16 : 19;
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (; z > 12; z--) {
    x0 = Math.floor(tx(sw.lng, z)); x1 = Math.floor(tx(ne.lng, z));
    y0 = Math.floor(ty(ne.lat, z)); y1 = Math.floor(ty(sw.lat, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) break;
  }
  const canvas = document.createElement("canvas");
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext("2d")!;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const src = url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    jobs.push(loadImg(src).then((im) => ctx.drawImage(im, (x - x0) * 256, (y - y0) * 256)).catch(() => undefined));
  }
  await Promise.all(jobs);
  const lng = (x: number) => (x / 2 ** z) * 360 - 180;
  const lat = (y: number) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
  const a = toLocal({ lat: lat(y1 + 1), lng: lng(x0) }, c.origin);
  const d = toLocal({ lat: lat(y0), lng: lng(x1 + 1) }, c.origin);
  try { canvas.toDataURL(); } catch { return null; } // tainted: tiles without CORS
  return { canvas, x: a.x, y: a.y, w: d.x - a.x, h: d.y - a.y };
}

export default function Run3D({ course, sim, basemap, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  const [view, setView] = useState<View>("driver");
  const [speed, setSpeed] = useState(1);
  const [hud, setHud] = useState({ mph: 0, t: 0, s: 0 });
  const state = useRef({ t: 0, playing: true, view: "driver" as View, speed: 1, scrub: -1 });
  state.current.playing = playing;
  state.current.view = view;
  state.current.speed = speed;

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9cc9f5);
    scene.fog = new THREE.Fog(0x9cc9f5, 600, 2500);
    const camera = new THREE.PerspectiveCamera(70, host.clientWidth / host.clientHeight, 0.5, 6000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 600, 200);
    scene.add(sun);

    const allPts: Pt[] = [...course.cones, ...sim.samples.map((s) => s.p), ...course.features.flatMap((f) => f.pts)];
    const b0 = bbox(allPts);
    const b = { minX: b0.minX - 250, minY: b0.minY - 250, maxX: b0.maxX + 250, maxY: b0.maxY + 250 };
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;

    // Ground
    const groundGeo = new THREE.PlaneGeometry(6000, 6000);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: 0x6b8f4e }));
    ground.position.set(cx, -0.05, -cy);
    scene.add(ground);

    const disposables: { dispose(): void }[] = [groundGeo];
    const addTexturePlane = (tex: THREE.Texture, x: number, y: number, w: number, h: number) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const g = new THREE.PlaneGeometry(w, h);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex }));
      m.position.set(x + w / 2, 0, -(y + h / 2));
      scene.add(m);
      disposables.push(g, tex);
    };

    let cancelled = false;
    if (course.image) {
      const im = course.image;
      new THREE.TextureLoader().load(im.dataUrl, (tex) => { if (!cancelled) addTexturePlane(tex, im.x, im.y, im.w, im.h); });
    } else {
      aerialGround(course, basemap, b).then((r) => { if (r && !cancelled) addTexturePlane(new THREE.CanvasTexture(r.canvas), r.x, r.y, r.w, r.h); });
    }

    // Flat area polygons
    for (const f of course.features) {
      if (f.pts.length < 3 || !f.closed) continue;
      const shape = new THREE.Shape(f.pts.map((p) => new THREE.Vector2(p.x, p.y)));
      const info = FEATURE_INFO[f.kind];
      if (f.kind === "obstacle") {
        const g = new THREE.ExtrudeGeometry(shape, { depth: 8, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: info.color, transparent: true, opacity: 0.75 })));
        disposables.push(g);
      } else {
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(-Math.PI / 2);
        const isPaved = f.kind === "paved";
        const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: isPaved ? 0x3b3f45 : info.color, transparent: true, opacity: isPaved ? (course.image || TILE_URL[basemap] ? 0.0 : 1) : 0.35, depthWrite: false }));
        m.position.y = isPaved ? 0.01 : 0.03;
        scene.add(m);
        disposables.push(g);
      }
    }
    // Poles, curbs, workers
    const poleGeo = new THREE.CylinderGeometry(0.6, 0.8, 28, 10);
    disposables.push(poleGeo);
    for (const f of course.features) {
      if (f.kind === "pole" && f.pts[0]) { const m = new THREE.Mesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x9ca3af })); m.position.copy(v3(f.pts[0], 14)); scene.add(m); }
      if (f.kind === "worker" && f.pts[0]) { const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 5.5, 10), new THREE.MeshLambertMaterial({ color: 0x16a34a })); m.position.copy(v3(f.pts[0], 2.75)); scene.add(m); }
      if (f.kind === "curb" && f.pts.length >= 2) {
        for (let i = 1; i < f.pts.length; i++) {
          const a = f.pts[i - 1], c2 = f.pts[i];
          const len = Math.hypot(c2.x - a.x, c2.y - a.y);
          const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 1), new THREE.MeshLambertMaterial({ color: 0xd1d5db }));
          m.position.copy(v3({ x: (a.x + c2.x) / 2, y: (a.y + c2.y) / 2 }, 0.3));
          m.rotation.y = Math.atan2(c2.y - a.y, c2.x - a.x);
          scene.add(m);
        }
      }
    }

    // Cones (instanced)
    const coneGeo = new THREE.ConeGeometry(0.45, 2.3, 16);
    coneGeo.translate(0, 1.15, 0);
    const baseGeo = new THREE.BoxGeometry(1.2, 0.12, 1.2);
    baseGeo.translate(0, 0.06, 0);
    disposables.push(coneGeo, baseGeo);
    const orange = new THREE.MeshLambertMaterial({ color: 0xff6a13 });
    const green = new THREE.MeshLambertMaterial({ color: 0x22c55e });
    const black = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
    const n = course.cones.length;
    if (n) {
      const conesI = new THREE.InstancedMesh(coneGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
      const baseI = new THREE.InstancedMesh(baseGeo, black, n);
      const mtx = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      course.cones.forEach((k, i) => {
        if (k.kind === "pointer") {
          // Lying on its side: rotate the cone's +Y tip onto +X, then yaw toward `rot`.
          q.setFromEuler(new THREE.Euler(0, k.rot ?? 0, -Math.PI / 2, "YXZ"));
          mtx.compose(v3(k, 0.45), q, new THREE.Vector3(1, 1, 1));
          conesI.setMatrixAt(i, mtx);
          baseI.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
        } else {
          mtx.makeTranslation(k.x, 0, -k.y);
          conesI.setMatrixAt(i, mtx);
          baseI.setMatrixAt(i, mtx);
        }
        conesI.setColorAt(i, k.kind === "timing" ? green.color : orange.color);
      });
      scene.add(conesI, baseI);
      disposables.push(conesI, baseI);
    }

    // Driving line
    const lineGeo = new THREE.BufferGeometry().setFromPoints(sim.samples.map((s) => v3(s.p, 0.08)));
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 }));
    scene.add(line);
    disposables.push(lineGeo);

    // Timing lights
    for (const l of [course.start, course.finish]) {
      if (!l) continue;
      for (const p of [l.a, l.b]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3, 0.6), new THREE.MeshLambertMaterial({ color: 0x111827 })); m.position.copy(v3(p, 1.5)); scene.add(m); }
    }

    // Car
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(14, 3, 6), new THREE.MeshLambertMaterial({ color: 0xdc2626 }));
    body.position.y = 2;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(6, 1.8, 5.2), new THREE.MeshLambertMaterial({ color: 0x111827 }));
    cabin.position.set(-1, 4.2, 0);
    car.add(body, cabin);
    scene.add(car);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(cx, 0, -cy);
    controls.enabled = false;

    const samples = sim.samples;
    const at = (t: number) => {
      let lo = 0, hi = samples.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].t < t) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const pointAtS = (s: number) => {
      let lo = 0, hi = samples.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].s < s) lo = mid + 1; else hi = mid; }
      return samples[lo].p;
    };

    let last = performance.now();
    let raf = 0;
    let hudTick = 0;
    let lastView: View | null = null;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const S = state.current;
      if (S.scrub >= 0) { S.t = S.scrub; S.scrub = -1; }
      if (S.playing) { S.t += dt * S.speed; if (S.t > sim.timeS + 1.5) S.t = 0; }
      const i = at(Math.min(S.t, sim.timeS));
      const smp = samples[i];
      const ahead = pointAtS(smp.s + 8);
      const dir = Math.atan2(ahead.y - smp.p.y, ahead.x - smp.p.x);
      car.position.copy(v3(smp.p));
      car.rotation.y = dir;

      if (S.view !== lastView) {
        controls.enabled = S.view === "orbit";
        if (S.view === "orbit") { camera.position.set(cx + 200, 500, -cy + 400); controls.target.set(cx, 0, -cy); }
        lastView = S.view;
      }
      car.visible = S.view !== "driver";
      if (S.view === "driver") {
        const look = pointAtS(smp.s + 30 + smp.v * 0.5);
        camera.position.copy(v3(smp.p, 3.6));
        camera.lookAt(v3(look, 2));
      } else if (S.view === "chase") {
        const back = { x: smp.p.x - Math.cos(dir) * 32, y: smp.p.y - Math.sin(dir) * 32 };
        camera.position.lerp(v3(back, 13), 0.15);
        camera.lookAt(v3(pointAtS(smp.s + 25), 2));
      } else controls.update();

      if (++hudTick % 6 === 0) setHud({ mph: smp.v / FT_PER_S_PER_MPH, t: smp.t, s: smp.s });
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [course, sim, basemap]);

  return (
    <div className="run3d">
      <div ref={hostRef} className="run3d-canvas" />
      <div className="run3d-hud">
        <div className="hud-speed">{hud.mph.toFixed(0)}<span>mph</span></div>
        <div>{hud.t.toFixed(2)} s · {hud.s.toFixed(0)} ft</div>
        <div className="hud-note">Simulated: {course.settings.car.name}{course.settings.wet ? ", wet" : ""}</div>
      </div>
      <div className="run3d-bar">
        <button onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
        <button onClick={() => { state.current.scrub = 0; }}>Restart</button>
        <input type="range" min={0} max={sim.timeS} step={0.05} value={Math.min(hud.t, sim.timeS)} onChange={(e) => { state.current.scrub = +e.target.value; setPlaying(false); }} />
        <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
          {[0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <div className="seg">
          {(["driver", "chase", "orbit"] as View[]).map((v) => <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{v === "driver" ? "Driver" : v === "chase" ? "Chase" : "Free orbit"}</button>)}
        </div>
        <button className="close" onClick={onClose}>Close 3D</button>
      </div>
    </div>
  );
}
