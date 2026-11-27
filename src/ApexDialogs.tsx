// Dialogs for Apex: sign in, link a course to an event, community track maps.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  APEX_URL, ApexError, getTrackMap, linkCourseMap, listCourseMaps, listEvents, openInBrowser, publishTrackMap,
  refreshSession, saveSession, searchTrackMaps, signOut, startSignIn,
  type ApexCourseMap, type ApexEvent, type ApexSession, type TrackMapFull, type TrackMapSummary,
} from "./apex";
import { exportSvg } from "./io";
import { bbox, toLatLng, type LatLng } from "./geo";
import { EVENT_KINDS, ZONE_KINDS, type Course, type FeatureKind } from "./model";

const errText = (e: unknown) => (e instanceof ApexError || e instanceof Error ? e.message : String(e));
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const svgImg = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// ---------------------------------------------------------------- sign in

export function ApexAccountDialog({ session, onSession, onClose }: { session: ApexSession | null; onSession(s: ApexSession | null): void; onClose(): void }) {
  const [code, setCode] = useState<{ userCode: string; url: string } | null>(null);
  const [msg, setMsg] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    // Refresh the club list each time the dialog opens.
    if (session) refreshSession(session).then(onSession).catch((e) => { if (e instanceof ApexError && e.status === 401) { saveSession(null); onSession(null); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = async () => {
    setMsg("");
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      const s = await startSignIn(ac.signal);
      setCode({ userCode: s.userCode, url: s.url });
      await openInBrowser(s.url);
      const sess = await s.done;
      setCode(null);
      onSession(sess);
      setMsg(sess.orgs.length ? "" : "Signed in, but this account isn't a member of any club with Apex.");
    } catch (e) {
      setCode(null);
      if (!ac.signal.aborted) setMsg(errText(e));
    }
  };

  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>Apex account</h2>
        {session ? (
          <>
            <p>Signed in as <b>{session.email ?? "your Apex account"}</b>.</p>
            {session.orgs.length > 0 ? (
              <label className="row">Club
                <select value={session.orgId ?? ""} onChange={(e) => { const s = { ...session, orgId: e.target.value }; saveSession(s); onSession(s); }}>
                  {session.orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.role})</option>)}
                </select>
              </label>
            ) : <p className="gen-error">This account isn't a member of any club with Apex.</p>}
            <p className="small">Linking courses to events and sharing site maps needs the editor or admin role for the club.</p>
          </>
        ) : code ? (
          <>
            <p>Approve the sign-in in your browser. Check that it shows this code:</p>
            <div className="apex-code">{code.userCode}</div>
            <p className="small">Waiting for approval… <a href="#" onClick={(e) => { e.preventDefault(); openInBrowser(code.url); }}>Open the page again</a></p>
          </>
        ) : (
          <>
            <p>Sign in with your club's Apex account (studio.apexsites.club) to link courses to your events and share site maps with other clubs.</p>
            <p className="small">Your browser opens Apex. Sign in there as usual and click <b>Approve</b>. The app never sees your password, and you can disconnect it any time in Apex under Settings → Security.</p>
          </>
        )}
        {msg && <p className="gen-error">{msg}</p>}
        <div className="actions">
          {session && <button onClick={async () => { await signOut(session); onSession(null); }}>Sign out</button>}
          {code && <button onClick={() => { abort.current?.abort(); setCode(null); }}>Cancel sign-in</button>}
          <button onClick={onClose}>Close</button>
          {!session && !code && <button className="primary" onClick={begin}>Sign in with Apex</button>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- link to event

export function LinkEventDialog({ session, course, stats, onLinked, onClose, onSignIn }: {
  session: ApexSession | null;
  course: Course;
  stats: { lengthFt?: number };
  onLinked(link: NonNullable<Course["apexLink"]>, message: string): void;
  onClose(): void;
  onSignIn(): void;
}) {
  const [orgId, setOrgId] = useState(course.apexLink?.orgId ?? session?.orgId ?? "");
  const [past, setPast] = useState(false);
  const [events, setEvents] = useState<ApexEvent[] | null>(null);
  const [eventId, setEventId] = useState(course.apexLink?.eventId ?? "");
  const [existing, setExisting] = useState<ApexCourseMap[]>([]);
  const [replaceId, setReplaceId] = useState(course.apexLink?.courseMapId ?? "");
  const [title, setTitle] = useState(course.apexLink?.title ?? "Course map");
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const org = session?.orgs.find((o) => o.id === orgId);

  useEffect(() => {
    if (!session || !orgId) return;
    setEvents(null);
    listEvents(session, orgId, past).then((r) => setEvents(r.events)).catch((e) => { setEvents([]); setMsg(errText(e)); });
  }, [session, orgId, past]);
  useEffect(() => {
    if (!session || !eventId) { setExisting([]); return; }
    listCourseMaps(session, eventId).then((r) => {
      setExisting(r.course_maps);
      if (!r.course_maps.some((m) => m.id === replaceId)) setReplaceId("");
    }).catch(() => setExisting([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, eventId]);

  if (!session) {
    return (
      <div className="modal-bg"><div className="modal">
        <h2>Link to an event</h2>
        <p>Sign in to Apex first to see your club's events.</p>
        <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={onSignIn}>Sign in with Apex</button></div>
      </div></div>
    );
  }
  const ev = events?.find((e) => e.id === eventId);
  const canWrite = org && org.role !== "viewer";
  const ready = !!ev && canWrite && course.line.length > 1 && !busy;

  const submit = async () => {
    if (!ev) return;
    setBusy(true);
    setMsg("");
    try {
      const svg = exportSvg(course, `${ev.name} · ${title}`);
      const r = await linkCourseMap(session, ev.id, {
        title, course, svg, length_ft: stats.lengthFt, is_published: publish,
        cone_count: course.cones.length, replace_id: replaceId || undefined, track_map_id: course.trackMap?.id,
      });
      onLinked({ orgId, eventId: ev.id, eventName: ev.name, courseMapId: r.course_map.id, title },
        `${replaceId ? "Updated" : "Linked"} "${title}" on ${ev.name}${publish ? "; it shows on the club website" : " (hidden from the website)"}.`);
    } catch (e) {
      setMsg(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg">
      <div className="modal wide">
        <h2>Link to an event</h2>
        {session.orgs.length > 1 && (
          <label className="row">Club
            <select value={orgId} onChange={(e) => { setOrgId(e.target.value); setEventId(""); }}>
              {session.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
        {org?.role === "viewer" && <p className="gen-error">Your role in {org.name} is viewer. An editor or admin can link course maps.</p>}
        <div className="seg-row">
          <button className={!past ? "on" : ""} onClick={() => setPast(false)}>Upcoming</button>
          <button className={past ? "on" : ""} onClick={() => setPast(true)}>Past year</button>
        </div>
        <div className="event-list">
          {events === null ? <p className="small">Loading events…</p> : events.length === 0 ? <p className="small">No {past ? "past" : "upcoming"} events in Apex for this club.</p> : events.map((e) => (
            <label key={e.id} className={`event-row ${e.id === eventId ? "on" : ""}`}>
              <input type="radio" name="ev" checked={e.id === eventId} onChange={() => setEventId(e.id)} />
              <span><b>{e.name}</b><br /><span className="small">{fmtDate(e.event_date)}{e.venue_name ? ` · ${e.venue_name}` : ""}{e.course_maps ? ` · ${e.course_maps} course map${e.course_maps > 1 ? "s" : ""}` : ""}</span></span>
            </label>
          ))}
        </div>
        {ev && (
          <>
            {existing.length > 0 && (
              <label className="row">Save as
                <select value={replaceId} onChange={(e) => { setReplaceId(e.target.value); const m = existing.find((x) => x.id === e.target.value); if (m) setTitle(m.title); }}>
                  <option value="">A new course map</option>
                  {existing.map((m) => <option key={m.id} value={m.id}>Replace "{m.title}"</option>)}
                </select>
              </label>
            )}
            <label className="row">Title <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Course A" /></label>
            <label className="chk"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Show on the club website with the event</label>
          </>
        )}
        {course.line.length < 2 && <p className="gen-error">Draw the driving line first.</p>}
        {msg && <p className="gen-error">{msg}</p>}
        <div className="actions">
          <button onClick={() => openInBrowser(`${APEX_URL}/dashboard/events${ev ? `/${ev.id}` : ""}`)}>Open in Apex</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={submit}>{busy ? "Uploading…" : replaceId ? "Update course map" : "Link course map"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- community track maps

export function CommunityDialog({ near, onLoad, onClose }: { near: LatLng; onLoad(m: TrackMapFull): void; onClose(): void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<TrackMapSummary[] | null>(null);
  const [sel, setSel] = useState<TrackMapSummary | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async (text: string) => {
    setMsg("");
    try { setRows((await searchTrackMaps(text, near)).track_maps); } catch (e) { setRows([]); setMsg(errText(e)); }
  };
  useEffect(() => { search(""); /* nearest first */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-bg">
      <div className="modal wide">
        <h2>Community track maps</h2>
        <p className="small">Site maps other clubs have shared: course area, Don't-use zones, obstacles and facilities. Nearest to the map view first.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); search(q); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by venue, city or state" style={{ flex: 1 }} />
          <button type="submit">Search</button>
        </form>
        <div className="community">
          <div className="event-list">
            {rows === null ? <p className="small">Loading…</p> : rows.length === 0 ? <p className="small">No shared maps found{q ? ` for "${q}"` : ""}. Map the site yourself and share it with Site map → Share this site.</p> : rows.map((r) => (
              <label key={r.id} className={`event-row ${sel?.id === r.id ? "on" : ""}`}>
                <input type="radio" name="tm" checked={sel?.id === r.id} onChange={() => setSel(r)} />
                <span><b>{r.name}</b><br /><span className="small">{[r.city, r.region].filter(Boolean).join(", ")}{r.distance_mi !== undefined ? ` · ${r.distance_mi < 1 ? "here" : `${Math.round(r.distance_mi)} mi`}` : ""}{r.club ? ` · by ${r.club}` : ""}{r.version > 1 ? ` · v${r.version}` : ""}</span></span>
              </label>
            ))}
          </div>
          <div className="preview">
            {sel?.preview_svg ? <img src={svgImg(sel.preview_svg)} alt={sel.name} /> : <p className="small">{sel ? "No preview." : "Pick a map to preview it."}</p>}
            {sel?.notes && <p className="small">{sel.notes}</p>}
          </div>
        </div>
        {msg && <p className="gen-error">{msg}</p>}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!sel || busy} onClick={async () => {
            if (!sel) return;
            setBusy(true);
            try { onLoad((await getTrackMap(sel.id)).track_map); } catch (e) { setMsg(errText(e)); setBusy(false); }
          }}>{busy ? "Loading…" : "Use this site map"}</button>
        </div>
      </div>
    </div>
  );
}

const SHARE_KINDS = new Set<FeatureKind>([...ZONE_KINDS, ...EVENT_KINDS, "obstacle", "pole", "curb", "surface", "worker"]);

export function ShareSiteDialog({ session, course, onShared, onClose, onSignIn }: {
  session: ApexSession | null;
  course: Course;
  onShared(tm: NonNullable<Course["trackMap"]>, message: string): void;
  onClose(): void;
  onSignIn(): void;
}) {
  const own = course.trackMap && session?.orgs.some((o) => o.id === course.trackMap!.orgId) ? course.trackMap : undefined;
  const [orgId, setOrgId] = useState(own?.orgId ?? session?.orgId ?? "");
  const [name, setName] = useState(own?.name ?? course.name ?? "");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [notes, setNotes] = useState("");
  const [asVersion, setAsVersion] = useState(!!own);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const features = useMemo(() => course.features.filter((f) => SHARE_KINDS.has(f.kind) && f.pts.length), [course.features]);
  const paved = features.filter((f) => f.kind === "paved" && f.pts.length >= 3);

  if (!session) {
    return (
      <div className="modal-bg"><div className="modal">
        <h2>Share this site</h2>
        <p>Sign in to Apex to share your site map with other clubs.</p>
        <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={onSignIn}>Sign in with Apex</button></div>
      </div></div>
    );
  }
  const org = session.orgs.find((o) => o.id === orgId);
  const submit = async () => {
    setBusy(true);
    setMsg("");
    try {
      const b = bbox(paved.flatMap((f) => f.pts));
      const center = toLatLng({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, course.origin);
      const siteOnly: Course = { ...course, cones: [], line: [], start: null, finish: null, features };
      const r = await publishTrackMap(session, {
        organization_id: orgId, name: name.trim(), city: city.trim() || undefined, region: region.trim() || undefined, notes: notes.trim() || undefined,
        lat: center.lat, lng: center.lng, site: { origin: course.origin, features }, preview_svg: exportSvg(siteOnly, name.trim()),
        replaces_id: asVersion && own ? own.id : undefined,
      });
      onShared({ id: r.track_map.id, orgId, name: r.track_map.name, version: r.track_map.version },
        `Shared "${r.track_map.name}"${r.track_map.version > 1 ? ` as version ${r.track_map.version}` : ""} with the community.`);
    } catch (e) {
      setMsg(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>Share this site with the community</h2>
        <p className="small">Shares the site map only: {features.length} zones, objects and facilities. Cones, the driving line and timing lines stay private. Anyone using the app can load it.</p>
        {session.orgs.length > 1 && (
          <label className="row">Shared by
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {session.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
        <label className="row">Venue name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bader Field" /></label>
        <label className="row">City <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Atlantic City" /></label>
        <label className="row">State <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="NJ" maxLength={20} /></label>
        <label className="row">Notes <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Surface, gate access, site owner rules…" rows={3} /></label>
        {own && <label className="chk"><input type="checkbox" checked={asVersion} onChange={(e) => setAsVersion(e.target.checked)} /> Publish as version {own.version + 1} of your club's "{own.name}" (replaces it in the library)</label>}
        {!paved.length && <p className="gen-error">Mark the Course area first: a shared site needs at least one.</p>}
        {org?.role === "viewer" && <p className="gen-error">Your role in {org.name} is viewer. An editor or admin can share site maps.</p>}
        {msg && <p className="gen-error">{msg}</p>}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim() || !paved.length || !org || org.role === "viewer"} onClick={submit}>{busy ? "Sharing…" : "Share"}</button>
        </div>
      </div>
    </div>
  );
}
