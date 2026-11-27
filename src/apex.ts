// Apex (studio.apexsites.club) integration: browser-approved sign-in, the club's
// events, course maps linked to events, and the community track-map library.
import type { Course, Feature } from "./model";
import type { LatLng } from "./geo";

export const APEX_URL = "https://studio.apexsites.club";
const STORE = "acd.apex";

export interface ApexOrg { id: string; name: string; role: "admin" | "editor" | "viewer" }
export interface ApexSession { token: string; email: string | null; orgs: ApexOrg[]; orgId: string | null }
export interface ApexEvent { id: string; name: string; event_date: string; end_date: string | null; venue_name: string | null; category: string | null; is_published: boolean; course_maps: number }
export interface ApexCourseMap { id: string; title: string; is_published: boolean; length_ft: number | null; cone_count: number | null; updated_at: string; media: { url: string } | null }
export interface TrackMapSummary { id: string; name: string; city: string | null; region: string | null; country: string; lat: number; lng: number; notes: string | null; version: number; downloads: number; created_at: string; preview_svg: string | null; organization_id: string; club: string | null; distance_mi?: number }
export interface TrackMapFull extends TrackMapSummary { site: { origin: LatLng; features: Feature[] } }

export class ApexError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function loadSession(): ApexSession | null {
  try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch { return null; }
}
export function saveSession(s: ApexSession | null) {
  if (s) localStorage.setItem(STORE, JSON.stringify(s)); else localStorage.removeItem(STORE);
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.body ? { "Content-Type": "application/json" } : {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${APEX_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApexError("Can't reach Apex. Check your internet connection.", 0);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 401 ? "Your Apex sign-in has expired or was disconnected. Sign in again."
      : res.status === 403 ? "Your Apex role for this club can't do that (editors and admins can)."
      : (j as { error?: string }).error || `Apex error ${res.status}`;
    throw new ApexError(msg, res.status);
  }
  return j as T;
}

export async function openInBrowser(url: string) {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

function deviceName(): string {
  const p = navigator.userAgent;
  return /Windows/.test(p) ? "Windows PC" : /Mac/.test(p) ? "Mac" : /Linux/.test(p) ? "Linux PC" : "computer";
}

/**
 * Starts the browser-approval sign-in. Returns the code to show and a promise
 * that resolves with the session once the user approves (or rejects on deny/expiry/cancel).
 */
export async function startSignIn(signal: AbortSignal): Promise<{ userCode: string; url: string; done: Promise<ApexSession> }> {
  const s = await call<{ device_code: string; user_code: string; verification_url: string; interval: number; expires_in: number }>(
    "/api/v1/app-connect/start",
    { method: "POST", body: JSON.stringify({ app: "ApexSites.club Track Builder", device: deviceName() }) },
  );
  const done = (async () => {
    const until = Date.now() + s.expires_in * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, s.interval * 1000));
      if (signal.aborted) throw new ApexError("Cancelled", 0);
      const p = await call<{ status: string; token?: string; user?: { email: string | null }; orgs?: ApexOrg[] }>(
        "/api/v1/app-connect/poll",
        { method: "POST", body: JSON.stringify({ device_code: s.device_code }) },
      );
      if (p.status === "approved" && p.token) {
        const orgs = p.orgs ?? [];
        const sess: ApexSession = { token: p.token, email: p.user?.email ?? null, orgs, orgId: orgs[0]?.id ?? null };
        saveSession(sess);
        return sess;
      }
      if (p.status === "denied") throw new ApexError("Sign-in was denied in the browser.", 0);
      if (p.status === "expired") break;
    }
    throw new ApexError("The sign-in code expired. Try again.", 0);
  })();
  return { userCode: s.user_code, url: s.verification_url, done };
}

export async function refreshSession(s: ApexSession): Promise<ApexSession> {
  const me = await call<{ user: { email: string | null }; orgs: ApexOrg[] }>("/api/v1/app/me", { token: s.token });
  const next = { ...s, email: me.user.email, orgs: me.orgs, orgId: me.orgs.some((o) => o.id === s.orgId) ? s.orgId : me.orgs[0]?.id ?? null };
  saveSession(next);
  return next;
}

export async function signOut(s: ApexSession) {
  try { await call("/api/v1/app/disconnect", { method: "POST", token: s.token }); } catch { /* token may already be gone */ }
  saveSession(null);
}

export const listEvents = (s: ApexSession, orgId: string, past = false) =>
  call<{ role: string; events: ApexEvent[] }>(`/api/v1/app/orgs/${orgId}/events${past ? "?past=1" : ""}`, { token: s.token });

export const listCourseMaps = (s: ApexSession, eventId: string) =>
  call<{ course_maps: ApexCourseMap[] }>(`/api/v1/app/events/${eventId}/course-maps`, { token: s.token });

export const linkCourseMap = (s: ApexSession, eventId: string, body: {
  title: string; course: Course; image: { mime: "image/svg+xml" | "image/jpeg"; data: string }; length_ft?: number; cone_count: number; is_published: boolean; replace_id?: string; track_map_id?: string;
}) => call<{ course_map: ApexCourseMap }>(`/api/v1/app/events/${eventId}/course-maps`, {
  method: "POST",
  token: s.token,
  body: JSON.stringify({
    title: body.title,
    course: { ...body.course, image: null, apexLink: undefined },
    image: body.image,
    length_ft: body.length_ft,
    cone_count: body.cone_count,
    is_published: body.is_published,
    replace_id: body.replace_id,
    track_map_id: body.track_map_id,
  }),
});

export const searchTrackMaps = (q: string, near?: LatLng) => {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (near) { p.set("lat", String(near.lat)); p.set("lng", String(near.lng)); }
  return call<{ track_maps: TrackMapSummary[] }>(`/api/v1/track-maps?${p}`);
};

export const getTrackMap = (id: string) => call<{ track_map: TrackMapFull }>(`/api/v1/track-maps/${id}`);

export const publishTrackMap = (s: ApexSession, body: {
  organization_id: string; name: string; city?: string; region?: string; notes?: string; lat: number; lng: number;
  site: { origin: LatLng; features: Feature[] }; preview_svg: string; replaces_id?: string;
}) => call<{ track_map: { id: string; name: string; version: number } }>("/api/v1/app/track-maps", { method: "POST", token: s.token, body: JSON.stringify(body) });
