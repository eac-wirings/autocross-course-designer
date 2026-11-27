import type { LatLng, Pt } from "./geo";

export type ConeKind = "standing" | "pointer" | "timing";
export type ConeGroup = "gate" | "slalom" | "offset" | "wall" | "start" | "finish" | "slow" | "apex" | "free";

export interface Cone {
  id: string;
  x: number;
  y: number;
  kind: ConeKind;
  /** Pointer cones: direction the cone tip points, radians (0 = east, CCW). */
  rot?: number;
  /** Cones placed by a gate/slalom/wall tool share a group id so the checker can measure them together. */
  groupId?: string;
  group?: ConeGroup;
}

export type FeatureKind =
  | "paved" // usable pavement; course must stay inside
  | "obstacle" // solid object area: building, fence, planter, wall
  | "pole" // light pole / tree (single point)
  | "curb" // curb line (kart margin exception)
  | "surface" // hole, grate, manhole, gravel patch
  | "spectator" // unprotected viewing area
  | "paddock"
  | "grid"
  | "nogo" // don't use: grass, closed sections, areas the site owner excluded
  | "worker" // worker station (single point)
  // Event facilities (single points)
  | "timing" // timing & scoring trailer / truck
  | "registration"
  | "tech" // tech inspection
  | "restroom"
  | "firstaid" // first aid / EMT
  | "extinguisher" // fire extinguisher station
  | "impound"
  | "emergency"; // emergency vehicle access / staging

/** The zone types shown first in the UI: where the course goes, where people park, and what's off limits. */
export const ZONE_KINDS: FeatureKind[] = ["paved", "paddock", "nogo", "grid", "spectator"];

/** Event facilities traditionally marked on an autocross site plan. */
export const EVENT_KINDS: FeatureKind[] = ["timing", "registration", "tech", "firstaid", "extinguisher", "restroom", "impound", "emergency"];

export interface Feature {
  id: string;
  kind: FeatureKind;
  pts: Pt[];
  closed: boolean;
  label?: string;
  /** Locked zones can't be reshaped, cut, added to or deleted until unlocked. */
  locked?: boolean;
}

export interface Line2 {
  a: Pt;
  b: Pt;
}

export interface ImageOverlay {
  dataUrl: string;
  /** Lower-left corner in local feet, and size in feet. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  pxW: number;
  pxH: number;
}

export interface CarProfile {
  name: string;
  latG: number;
  accelG: number;
  brakeG: number;
  topMph: number;
}

export interface Settings {
  karts: boolean;
  multipleCarsOnCourse: boolean;
  wet: boolean;
  nationalsLevel: boolean;
  car: CarProfile;
}

export interface Course {
  version: 1;
  name: string;
  origin: LatLng;
  cones: Cone[];
  features: Feature[];
  /** Control points of the intended driving line, start → finish. */
  line: Pt[];
  /** The line as the user drew it, before slaloms/offsets were woven in. Cleared when the line is edited. */
  baseLine?: Pt[];
  /** Where this course is linked on Apex (Link to event), so it can be updated in one click. */
  apexLink?: { orgId: string; eventId: string; eventName: string; courseMapId: string; title: string };
  /** The community track map the site came from, for publishing new versions. */
  trackMap?: { id: string; orgId: string; name: string; version: number };
  start: Line2 | null;
  finish: Line2 | null;
  image: ImageOverlay | null;
  settings: Settings;
}

export const CAR_PRESETS: CarProfile[] = [
  { name: "Fast street car (C8 Corvette class)", latG: 1.15, accelG: 0.75, brakeG: 1.15, topMph: 180 },
  { name: "Typical street car (sport sedan)", latG: 0.95, accelG: 0.45, brakeG: 1.0, topMph: 130 },
  { name: "Small roadster (Miata class)", latG: 1.0, accelG: 0.38, brakeG: 1.0, topMph: 125 },
  { name: "Prepared / modified car", latG: 1.35, accelG: 0.85, brakeG: 1.3, topMph: 160 },
  { name: "Kart", latG: 1.6, accelG: 0.7, brakeG: 1.3, topMph: 80 },
];

export const FEATURE_INFO: Record<FeatureKind, { label: string; color: string; closed: boolean; point: boolean; help: string; emoji?: string }> = {
  paved: { label: "Course area", color: "#38bdf8", closed: true, point: false, help: "Where the course may go (usable pavement). Cones and the driving line must stay inside. You can draw several." },
  nogo: { label: "Don't use", color: "#e11d48", closed: true, point: false, help: "Off limits: grass, closed or broken sections, areas the site owner excluded. The course must stay out of it." },
  obstacle: { label: "Solid obstacle", color: "#dc2626", closed: true, point: false, help: "Buildings, fences, walls, planters. 25 ft minimum margin (50 ft with karts)." },
  pole: { label: "Light pole / tree", color: "#b91c1c", closed: false, point: true, help: "Single solid object. 25 ft minimum margin (50 ft with karts)." },
  curb: { label: "Curb", color: "#f97316", closed: false, point: false, help: "Curb line. 25 ft minimum margin, karts do not raise it." },
  surface: { label: "Surface hazard", color: "#a16207", closed: true, point: false, help: "Holes, grates, manholes, gravel, broken pavement. The course must avoid them." },
  spectator: { label: "Spectator area", color: "#7c3aed", closed: true, point: false, help: "Unprotected viewing area. 75 ft minimum margin." },
  paddock: { label: "Paddock", color: "#a3e635", closed: true, point: false, help: "Paddock. 75 ft minimum margin; finish must not aim here." },
  grid: { label: "Grid", color: "#0891b2", closed: true, point: false, help: "Grid / staging. 75 ft minimum margin; finish must not aim here." },
  worker: { label: "Worker station", color: "#16a34a", closed: false, point: true, help: "Course worker station. Should cover the course and sit away from the car path." },
  timing: { label: "Timing & scoring", color: "#0ea5e9", closed: false, point: true, emoji: "⏱", help: "Timing truck or trailer. Needs a clear view of the start and finish lights and 75 ft from the course." },
  registration: { label: "Registration", color: "#6366f1", closed: false, point: true, emoji: "📋", help: "Registration / check-in. Near the site entrance, away from the course." },
  tech: { label: "Tech inspection", color: "#64748b", closed: false, point: true, emoji: "🔧", help: "Tech inspection lane, before cars reach grid." },
  firstaid: { label: "First aid / EMT", color: "#ef4444", closed: false, point: true, emoji: "➕", help: "First aid kit or EMT location, with a clear path onto the course." },
  extinguisher: { label: "Fire extinguisher", color: "#dc2626", closed: false, point: true, emoji: "🧯", help: "Fire extinguisher. Usually one at each worker station, at grid and at timing." },
  restroom: { label: "Restrooms", color: "#14b8a6", closed: false, point: true, emoji: "🚻", help: "Restrooms or portable toilets, in the paddock away from the course." },
  impound: { label: "Impound", color: "#a855f7", closed: false, point: true, emoji: "⚖", help: "Impound area for post-run checks, if your event uses one." },
  emergency: { label: "Emergency access", color: "#f43f5e", closed: false, point: true, emoji: "🚑", help: "Where an ambulance or fire truck enters the site and reaches the course. Keep it unblocked." },
};

export const DEFAULT_ORIGIN: LatLng = { lat: 39.8283, lng: -98.5795 };

export function newCourse(origin: LatLng = DEFAULT_ORIGIN): Course {
  return {
    version: 1,
    name: "Untitled course",
    origin,
    cones: [],
    features: [],
    line: [],
    start: null,
    finish: null,
    image: null,
    settings: { karts: false, multipleCarsOnCourse: false, wet: false, nationalsLevel: false, car: CAR_PRESETS[0] },
  };
}

let idCounter = 0;
export const uid = (p = "id") => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

export function isEmpty(c: Course) {
  return c.cones.length === 0 && c.features.length === 0 && c.line.length === 0 && !c.start && !c.finish && !c.image;
}
