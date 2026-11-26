// Retail world replay (LOKI_RETAIL_WORLD=1, default on): the retail server's first seconds of *world* actors
// (respawn beacons, oracles, capture points, switches, vault doors, landmarks, shops, forges, trains, WorldSettings,
// storm, map icons…) captured from real SUPERVIVE matches (recorded retail match traffic → the capture decoder (not shipped) →
// data/retail-world-*.json) and replayed bit-for-bit, with the retail NetGUIDs, on fresh channels.
// Player-owned actors (PC/PS/TeamState/GameState/heroes) stay ours.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BitWriter } from "./bits.ts";
import { writeNetGuid } from "./protocol.ts";

export interface RetailExport { guid: bigint; flags: number; outer: bigint; path: string; checksum: number | null }
export interface RetailBunch {
  t: number; ch: number; open: boolean; close: boolean; rel: boolean;
  exports: RetailExport[]; must: bigint[]; nb: number; body: Uint8Array;
}
export interface RetailWorld {
  name: string; level: string; bunches: RetailBunch[];
  table: Map<bigint, [string, bigint]>;
  guidByPath: Map<string, bigint>;
  channelMap: Map<number, number>;
}

const DIR = join(import.meta.dir, "data");
const cache = new Map<string, RetailWorld | null>();

function fullPath(table: Map<bigint, [string, bigint]>, g: bigint, depth = 0): string {
  const e = table.get(g);
  if (!e || depth > 12) return "";
  return e[1] && table.has(e[1]) ? `${fullPath(table, e[1], depth + 1)}.${e[0]}` : e[0];
}

function load(name: string): RetailWorld | null {
  if (cache.has(name)) return cache.get(name)!;
  const file = join(DIR, `retail-world-${name}.json`);
  if (!existsSync(file)) { cache.set(name, null); return null; }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const table = new Map<bigint, [string, bigint]>();
  for (const [g, [p, o]] of Object.entries<[string, string]>(raw.table)) table.set(BigInt(g), [p, BigInt(o)]);
  const rooted = (g: bigint, d = 0): boolean => {
    if (g === 0n) return true;
    const e = table.get(g);
    return !!e && d < 16 && rooted(e[1], d + 1);
  };
  const channelMap = new Map<number, number>();
  const base = Number(process.env.LOKI_RETAIL_CH_BASE || 1000);
  const bunches: RetailBunch[] = raw.bunches.map((b: any) => {
    if (!channelMap.has(b.ch)) channelMap.set(b.ch, base + channelMap.size);
    return {
      t: b.t, ch: b.ch, open: b.open, close: b.close, rel: b.rel, nb: b.nb,
      body: Buffer.from(b.body, "hex"),
      must: b.must.map((g: string) => BigInt(g)),
      // Drop exports hanging off actors we never replay (e.g. the retail player's PC subobjects).
      exports: b.exports.map((e: any) => ({ guid: BigInt(e[0]), flags: e[1], outer: BigInt(e[2]), path: e[3], checksum: e[4] }))
        .filter((e: RetailExport) => rooted(e.outer)),
    };
  });
  const guidByPath = new Map<string, bigint>();
  for (const g of table.keys()) { const p = fullPath(table, g); if (p && !guidByPath.has(p)) guidByPath.set(p, g); }
  const w: RetailWorld = { name, level: raw.level, bunches, table, guidByPath, channelMap };
  cache.set(name, w);
  return w;
}

/** Which retail capture matches a map + GameState class (both retail flows are on LVL_SkylandsBreach). */
export function pickRetailWorld(map: string, gameStateCls: string): RetailWorld | null {
  if (process.env.LOKI_RETAIL_WORLD === "0") return null;
  if (!/LVL_SkylandsBreach$/.test(map)) return null;
  const forced = process.env.LOKI_RETAIL_WORLD_NAME;
  const name = forced || (/Breach|Solos|BattleRoyale|TurboBR/i.test(gameStateCls) ? "breach" : "ffa");
  const w = load(name);
  return w && w.level === map ? w : null;
}

function writeRetailExport(w: BitWriter, e: RetailExport) {
  writeNetGuid(w, e.guid);
  w.uint8(e.flags);
  if (e.flags & 1) {
    writeNetGuid(w, e.outer);
    if (e.outer >= 1n) w.uint8(0);
    w.fstring(e.path);
    if (e.flags & 4) w.uint32((e.checksum ?? 0) >>> 0);
  }
}

/** Export sections (bHasRepLayoutExport=0, int32 count, entries) split so each fits one raw bunch. */
export function exportSections(exports: RetailExport[], maxBits = 7000): Array<{ data: Uint8Array; bits: number }> {
  const out: Array<{ data: Uint8Array; bits: number }> = [];
  let group: RetailExport[] = [];
  let groupBits = 33;
  const flush = () => {
    if (!group.length) return;
    const w = new BitWriter(groupBits + 64);
    w.bit(false); w.int32(group.length);
    for (const e of group) writeRetailExport(w, e);
    out.push({ data: w.buffer(), bits: w.bits });
    group = []; groupBits = 33;
  };
  for (const e of exports) {
    const probe = new BitWriter(256); writeRetailExport(probe, e);
    if (groupBits + probe.bits > maxBits) flush();
    group.push(e); groupBits += probe.bits;
  }
  flush();
  return out;
}

/** Merged bunch data = [uint16 count + must-be-mapped GUIDs] + retail body. */
export function bunchData(b: RetailBunch): { data: Uint8Array; bits: number } {
  const w = new BitWriter(b.nb + 64 + b.must.length * 40);
  if (b.must.length) { w.uint16(b.must.length); for (const g of b.must) writeNetGuid(w, g); }
  w.bitsFrom(b.body, b.nb);
  return { data: w.buffer(), bits: w.bits };
}

/** Bit slice [start, start+n) of src as a fresh buffer. */
export function sliceBits(src: Uint8Array, start: number, n: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(n / 8) || 1);
  for (let i = 0; i < n; i++) {
    const s = start + i;
    if (src[s >> 3] & (1 << (s & 7))) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}
