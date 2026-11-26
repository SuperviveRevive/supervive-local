// Real spawn locations per map (data/spawnpoints-204.json, extracted from the client paks).
// A hero placed off-island falls forever (2026-11-24: spawned at (401,0) on SkylandsBreach,
// z reached -19,000 in 20 s), so every human spawn and void rescue goes through here.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import FLOOR_SPAWNS from "./tables/floor-spawns.ts";
import BREACH_FLOOR from "./tables/breach-floor.ts";
import { dirname } from "node:path";
import { join } from "node:path";

type Pt = [number, number, number];
type MapSpawns = { player?: Pt[]; beacon?: Pt[]; bot?: Pt[] };
let table: Record<string, MapSpawns> = {};
try {
  table = JSON.parse(readFileSync(join(import.meta.dir, "data", "spawnpoints-204.json"), "utf8"));
} catch {}
// Terrain-verified subset (z = floor): spawnpoints-204.json starts include ~half that sit over open
// abyss on the client's Breach terrain (no collision → endless fall, the 2026-11-24 "spectate" bug).
const floorVerified = new Set<string>();
try {
  const v = FLOOR_SPAWNS as unknown as Record<string, MapSpawns>;
  if (process.env.LOKI_SPAWN_FLOOR !== "0") for (const [k, m] of Object.entries(v)) if (!k.startsWith("_")) { table[k] = m as MapSpawns; floorVerified.add(k); }
} catch {}
const FLOOR_HEIGHT = Number(process.env.LOKI_SPAWN_FLOOR_Z || 110);

const DROP_HEIGHT = Number(process.env.LOKI_SPAWN_DROP_Z || 300);

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---- learned floors: maps without extracted spawn data (every map but Breach) learn where humans actually
// walk (ServerMove in MOVE_Walking = real client collision). Persisted, so the next match on that map spawns,
// rescues and seats bots on ground the client really has. Seeded from our own test matches.
const LEARNED_FILE = process.env.REVIVE_LEARNED_FLOOR || join(process.env.REVIVE_DATA_DIR || join(import.meta.dir, "..", "local-data"), "match", "learned-floor.json");
const LEARN_CELL = 600, LEARN_CAP = 400, LEARN_MIN = Number(process.env.LOKI_LEARNED_MIN || 3);
let learned: Record<string, Pt[]> = {};
for (const f of [join(import.meta.dir, "data", "learned-floor-seed-204.json"), LEARNED_FILE]) {
  try { const v = JSON.parse(readFileSync(f, "utf8")); for (const [k, pts] of Object.entries(v)) if (Array.isArray(pts)) learned[k] = [...(learned[k] || []), ...(pts as Pt[])]; } catch {}
}
let learnTimer: ReturnType<typeof setTimeout> | null = null;
function learnedFor(map: string): Pt[] {
  if (table[map]?.player?.length || process.env.LOKI_LEARNED === "0") return [];
  const l = learned[map] || [];
  return l.length >= LEARN_MIN ? l : [];
}
/** Records a point a human stood on (Walking). No-op on maps with extracted spawn data. */
export function learnFloor(map: string, x: number, y: number, z: number) {
  if (table[map]?.player?.length || process.env.LOKI_LEARNED === "0") return;
  const l = learned[map] || (learned[map] = []);
  if (l.length >= LEARN_CAP) return;
  if (l.some((p) => Math.abs(p[0] - x) < LEARN_CELL && Math.abs(p[1] - y) < LEARN_CELL)) return;
  l.push([Math.round(x), Math.round(y), Math.round(z)]);
  if (!learnTimer) learnTimer = setTimeout(() => {
    learnTimer = null;
    try { mkdirSync(dirname(LEARNED_FILE), { recursive: true }); writeFileSync(LEARNED_FILE, JSON.stringify(learned)); } catch {}
  }, 10_000);
}

export function hasSpawnPoints(map: string) {
  const m = table[map];
  return !!(m && (m.player?.length || m.beacon?.length)) || learnedFor(map).length > 0;
}

// ---- per-mode spawn override (one match per DS): retail FFA spawns everyone inside its fixed 8000 storm circle at
// (23140, 41420) — data/spawnpoints-ffa-204.json = retail FFA hero positions (flows 7547/7027) that sit on Breach floor.
let modeSpawns: { map: string; pts: Pt[]; name: string } | null = null;
export const FFA_SPAWNS: Pt[] = (() => { try { return JSON.parse(readFileSync(join(import.meta.dir, "data", "spawnpoints-ffa-204.json"), "utf8")); } catch { return []; } })();
/** Use `pts` (z = floor) for every spawn on `map` until cleared (null). */
export function setModeSpawns(map: string | null, pts: Pt[] | null, name = "mode") {
  modeSpawns = map && pts?.length && process.env.LOKI_MODE_SPAWNS !== "0" ? { map, pts, name } : null;
}

/** Deterministic spawn for a player: teams get distinct start points, teammates share one. */
export function spawnPointFor(map: string, team: number, playerId: string): { x: number; y: number; z: number; source: string } {
  if (modeSpawns?.map === map) {
    const b = modeSpawns.pts[((team >= 0 ? team * 7 : 0) + hash(playerId)) % modeSpawns.pts.length]!;
    return { x: b[0], y: b[1], z: b[2] + FLOOR_HEIGHT, source: `${modeSpawns.name}-floor` };
  }
  const m = table[map];
  const list = m?.player?.length ? m.player : m?.beacon?.length ? m.beacon : null;
  if (!list) {
    const l = learnedFor(map);
    if (!l.length) return { x: 0, y: 0, z: 2000, source: "fallback" };
    const b = l[(team >= 0 ? team : hash(playerId)) % l.length]!; // seeds list the map's known start first
    return { x: b[0] + ((hash(playerId) % 3) - 1) * 120, y: b[1], z: b[2] + 60, source: "learned" };
  }
  const base = list[(Math.max(0, team) * 7 + (team < 0 ? hash(playerId) : 0)) % list.length]!;
  if (floorVerified.has(map)) {
    const dx = ((hash(playerId) % 3) - 1) * 150; // teammates side by side, as the drop crew (-150/0/+150)
    return { x: base[0] + dx, y: base[1], z: base[2] + FLOOR_HEIGHT, source: "playerstart-floor" };
  }
  const spread = hash(playerId) % 4;
  return { x: base[0] + (spread % 2) * 120, y: base[1] + (spread >> 1) * 120, z: base[2] + DROP_HEIGHT, source: m?.player?.length ? "playerstart" : "beacon" };
}

export function botSpawnPoints(map: string): Pt[] {
  const m = table[map];
  return m?.bot?.length ? m.bot : m?.beacon || [];
}

/** Nearest terrain-verified spawn floor to (x, y) — where a drop without a real pod lands the hero. */
// Breach terrain collision triangles (cross-checked against retail traffic),
// flattened to [ax,ay,az,bx,by,bz,cx,cy,cz] and bucketed on a 2000 uu grid for floorAt().
const BREACH = "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach";
const CELL = 2000;
let grid: Map<string, number[][]> | null = null;
function loadGrid() {
  if (grid) return grid;
  grid = new Map();
  try {
    const tris = BREACH_FLOOR as unknown as number[][];
    for (const t of tris) {
      const x0 = Math.floor(Math.min(t[0]!, t[3]!, t[6]!) / CELL), x1 = Math.floor(Math.max(t[0]!, t[3]!, t[6]!) / CELL);
      const y0 = Math.floor(Math.min(t[1]!, t[4]!, t[7]!) / CELL), y1 = Math.floor(Math.max(t[1]!, t[4]!, t[7]!) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = `${gx},${gy}`; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(t);
      }
    }
  } catch {}
  return grid;
}

/** Highest terrain z under (x, y) on Breach, or null over open sky. */
export function floorAt(map: string, x: number, y: number): number | null {
  if (map !== BREACH || process.env.LOKI_FLOOR_TRIS === "0") return null;
  const a = loadGrid().get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
  if (!a) return null;
  let best: number | null = null;
  for (const t of a) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t as [number, number, number, number, number, number, number, number, number];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const z = l1 * az + l2 * bz + l3 * cz;
    if (best === null || z > best) best = z;
  }
  return best;
}

/** Landing spot for a drop aimed at (x, y): the exact point when it is over terrain, otherwise the closest
 *  terrain point found by a ring search (up to ~6 km), otherwise the nearest verified spawn floor. */
export function landingFloor(map: string, x: number, y: number): { x: number; y: number; z: number; exact: boolean } | null {
  const z0 = floorAt(map, x, y);
  if (z0 !== null) return { x, y, z: z0 + FLOOR_HEIGHT, exact: true };
  if (map === BREACH && process.env.LOKI_FLOOR_TRIS !== "0") {
    for (let r = 200; r <= 6000; r += 200) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / 300));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        const z = floorAt(map, px, py);
        if (z !== null) return { x: Math.round(px), y: Math.round(py), z: z + FLOOR_HEIGHT, exact: false };
      }
    }
  }
  const n = nearestFloor(map, x, y);
  return n ? { ...n, exact: false } : null;
}

export function nearestFloor(map: string, x: number, y: number): { x: number; y: number; z: number } | null {
  if (!floorVerified.has(map)) {
    let best: Pt | null = null, bd = Infinity;
    for (const p of learnedFor(map)) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = p; } }
    return best ? { x: best[0], y: best[1], z: best[2] + 60 } : null;
  }
  const list = table[map]?.player || [];
  let best: Pt | null = null, bd = Infinity;
  for (const p of list) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = p; } }
  return best ? { x: best[0], y: best[1], z: best[2] + FLOOR_HEIGHT } : null;
}

/** Terrain-verified player starts for a map (z = floor), or [] when the map has none. */
export function floorSpawnList(map: string): Pt[] {
  if (modeSpawns?.map === map) return modeSpawns.pts;
  return floorVerified.has(map) ? (table[map]?.player || []) : learnedFor(map);
}
