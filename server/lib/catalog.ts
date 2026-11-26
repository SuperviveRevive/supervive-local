// Game data, all of it generated on first setup from the player's OWN install (see tools/setup.ts),
// plus the queue list in <data>/queues.json which the host may edit freely. Nothing here is bundled.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { Catalog, Entry } from "../../tools/gen/catalog.ts";
import type { QueueDef } from "../../tools/gen/modes.ts";

export type { Entry, QueueDef };
export const CLIENT_BUILD = "release2.4.live-156430-shipping";

const EMPTY: Catalog = { generatedAt: "", source: "none", heroes: [], heroCosmetics: [], emotes: [], titles: [], slotCosmetics: [], lobbyPlatforms: [], maps: [] };

function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback; } catch (e) {
    console.error(`[catalog] cannot read ${file}: ${(e as Error).message}`);
    return fallback;
  }
}

let cache: { mtime: number; catalog: Catalog } | null = null;
export function catalog(): Catalog {
  const f = join(DATA_DIR, "generated", "catalog.json");
  const m = existsSync(f) ? statSync(f).mtimeMs : 0;
  if (!cache || cache.mtime !== m) cache = { mtime: m, catalog: { ...EMPTY, ...readJson(f, EMPTY) } };
  return cache.catalog;
}

let qcache: { mtime: number; queues: QueueDef[] } | null = null;
export function queues(): QueueDef[] {
  const f = join(DATA_DIR, "queues.json");
  const m = existsSync(f) ? statSync(f).mtimeMs : 0;
  if (!qcache || qcache.mtime !== m) {
    const raw = readJson<{ queues?: Partial<QueueDef>[] }>(f, {}).queues || [];
    qcache = {
      mtime: m,
      queues: raw.filter((q) => q.id && q.map).map((q) => ({
        id: String(q.id), name: String(q.name || q.id), alias: String(q.alias || ""), map: String(q.map),
        teamSize: Math.max(1, Number(q.teamSize) || 1), teams: Math.max(1, Number(q.teams) || 1),
        maxPartySize: Math.max(1, Number(q.maxPartySize) || Number(q.teamSize) || 1), botFill: q.botFill !== false,
      })),
    };
  }
  return qcache.queues;
}

/** The client may append "-ranked" to a queue id; the Local Edition has no ranked play, so it maps back. */
export function queueById(id: unknown): QueueDef | undefined {
  const all = queues();
  const s = String(id ?? "").toLowerCase().replace(/(-ranked)+$/, "");
  return all.find((q) => q.id.toLowerCase() === s) || (s ? undefined : all[0]);
}

export const allEntries = (): Entry[] => {
  const c = catalog();
  return [...c.heroes, ...c.heroCosmetics, ...c.emotes, ...c.titles, ...c.slotCosmetics, ...c.lobbyPlatforms];
};

export const defaultHero = () => catalog().heroes[0]?.id || "";

/** A hero's base skin: the bundle under the hero's folder whose name says "Default", else its first bundle. */
export function defaultSkinFor(heroId: string): string {
  const c = catalog();
  const hero = c.heroes.find((h) => h.ids.some((i) => i.toLowerCase() === heroId.toLowerCase()));
  if (!hero) return "";
  const mine = c.heroCosmetics.filter((b) => b.hero?.toLowerCase() === hero.hero?.toLowerCase());
  return (mine.find((b) => /default/i.test(b.name) && !/_[A-Z]{3}$/.test(b.name)) || mine[0])?.id || "";
}
