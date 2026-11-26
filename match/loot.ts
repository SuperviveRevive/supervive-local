// World loot on LVL_SkylandsBreach: searchable boxes, their SimpleInventory, E-to-interact looting.
//
// Wire facts (all retail-capture-derived, the capture decoder (not shipped) -> capture fixtures (not shipped), gate tools/check-loot.ts;
// spec docs/BREACH-MAP-FEATURES.md §2; reference*):
//   * A box is a dynamic actor (CDO archetype Default__BP_SearchableBox_*_C). Open block: h5 RemoteRole 1, h12 ReplicatedMovement
//     (whole-unit location, BYTE rotation, no trailing bit), h14 Role 3, h17 bIconVisible 1. Its stably named subobject
//     `SimpleInventory` (export outer = box, GUID box+2) carries one field: InventoryData = field 2 of bound 4, a UE 5.4
//     delta-struct fast array of FLokiInventoryItemDataItem (member handles 1-12), same FastArray framing as the ASC's field 8.
//   * Descriptor IDs (h1) number from 0 per box and survive removals; ReplicationIDs number from 1; ArrayReplicationKey moves by one
//     per add and per delete (retail: 3 deletes took it 10 -> 13, base = previous key).
//   * Looting RPCs ride on the client's PlayerController channel as subobject blocks ([rep][isActor=0][guid][packed bits][fields]):
//     LokiInteractionPlayerComponent (bound 6): 3 ServerExecuteUsableInteraction(Usable, Instigator, int32, enum:2, int32),
//     4 ServerStopUsableInteraction(Usable, Instigator, enum:4); LokiInventoryOperationsV2 (bound 16): 10 ServerTakeAll(Source),
//     12 ServerTakeSimpleInventoryItem(Source, int32 ID). Each non-bool parameter has a send bit (0 = zero/null value).
//     Retail's server exports both components (path only, outer = PC). If it has not, the client writes the reference inline:
//     NetGUID 1 (default) + export flags + outer + path (seen in retail before the first export).
//   * Execute -> the server grants GS_Search_Instant (Level 1, InputID 13, SourceObject = box) into the carrier ASC (field 8 delta);
//     the client activates it (ServerTryActivateAbility -> 18 Succeed). Take -> descriptors deleted. Stop -> 20 ClientCancelAbility
//     (mode Authority, bWasEndedByOther 1, the activation key) + the spec's field-8 delete.
//
// Everything here is pure encoding/state; server.ts owns the sockets and calls in through LootManager (LOKI_LOOT=0 disables).
// UNVERIFIED IN-CLIENT: nothing in this file has been seen working in the real 2.0.4 client yet.
import { BitReader, BitWriter } from "./bits.ts";
import { writeQuantizedVector, type GuidExport } from "./protocol.ts";
import * as Gas from "./gas.ts";

export const LOOT_ENABLED = process.env.LOKI_LOOT !== "0";
export const LOOT_CH_BASE = Number(process.env.LOKI_LOOT_CH || 800);
export const LOOT_MAX_BOXES = Math.min(64, Number(process.env.LOKI_LOOT_MAX || 40));
export const LOOT_RANGE = Number(process.env.LOKI_LOOT_RANGE || 600);          // 2D hero->box (cross-checked against retail traffic)
export const LOOT_TAKE_AFTER_STOP_MS = Number(process.env.LOKI_LOOT_TAKE_AFTER_STOP_MS || 2000);
export const LOOT_TAKE_DELAY_MS = Number(process.env.LOKI_LOOT_TAKE_DELAY_MS || 100);     // retail deletes ~0.10 s after the take
export const LOOT_EXPORT_PC_COMPS = process.env.LOKI_LOOT_PC_EXPORT !== "0";
/** Standing on a box (the client's move names one of its components as MovementBase) counts as in reach, whatever the server's
 *  last world position says. Retail flows 7038/7039: every box Execute came 47-118 uu from the box centre with the hero based on
 *  that box's Box_TerrainBlockHazard slab. LOKI_LOOT_ONBOX=0 -> distance check only. */
export const LOOT_ONBOX_IN_RANGE = process.env.LOKI_LOOT_ONBOX !== "0";

// ------------------------------------------------------------------ GUIDs (0x9000-0x9fff; disjoint from the AGENTS.md map)
/** Box actors are dynamic (even): 0x9000 + 0x10*i, SimpleInventory = box + 2. 64 boxes max -> up to 0x93f2. */
export const boxGuid = (i: number) => 0x9000n + BigInt(i) * 0x10n;
export const inventoryGuid = (i: number) => boxGuid(i) + 2n;
/** Per-player PC components (dynamic/even, like retail's 6058 / 8): 0x9c00 + 4*ord (+0 interaction, +2 inventory ops). */
export const interactionGuid = (ord: number) => 0x9c00n + BigInt(ord) * 4n;
export const invOpsGuid = (ord: number) => interactionGuid(ord) + 2n;
/** Static assets (odd): package 0x9e01 + 4*k, object (class / CDO) +2. */
const assetGuid = (k: number) => 0x9e01n + BigInt(k) * 4n;

export interface Asset { pkg: string; obj: string; pkgGuid: bigint; guid: bigint }
const ASSETS: Asset[] = [];
function asset(pkg: string, obj: string): Asset {
  const a = { pkg, obj, pkgGuid: assetGuid(ASSETS.length), guid: assetGuid(ASSETS.length) + 2n };
  ASSETS.push(a);
  return a;
}
/** Package + object exports for an asset (object's outer = package), as retail exports them. */
export function assetExports(a: Asset): GuidExport[] {
  return [{ guid: a.pkgGuid, path: a.pkg, outer: 0n }, { guid: a.guid, path: a.obj, outer: a.pkgGuid }];
}

const BOX_DIR = "/Game/Loki/Usables/SearchableBox";
export const BOX_CLASSES = {
  LukeWarm: asset(`${BOX_DIR}/LootBox/BP_SearchableBox_LukeWarmBiome`, "Default__BP_SearchableBox_LukeWarmBiome_C"),
  Fortress: asset(`${BOX_DIR}/LootBox/BP_SearchableBox_MediumValue_Fortress`, "Default__BP_SearchableBox_MediumValue_Fortress_C"),
} as const;
export type BoxClass = keyof typeof BOX_CLASSES;
export const SEARCH_SPELL = asset(`${BOX_DIR}/GS_Search_Instant`, "Default__GS_Search_Instant_C");
export const SEARCH_INPUT_ID = 13, SEARCH_LEVEL = 1;

// ------------------------------------------------------------------ item table (descriptor values copied from retail boxes)
export type ItemKind = "gold" | "armor" | "bandage" | "repair" | "phoenix";
export interface ItemDef { key: string; kind: ItemKind; cls: Asset; tier: number; star: number; stacks: number; armorTier?: number }
const item = (key: string, kind: ItemKind, pkg: string, tier: number, star: number, stacks: number, armorTier?: number): ItemDef => {
  const name = pkg.split("/").pop()!;
  return { key, kind, cls: asset(pkg, `${name}_C`), tier, star, stacks, armorTier };
};
const ITEMS_DIR = "/Game/Loki/Items";
export const ITEMS: Record<string, ItemDef> = Object.fromEntries([
  // gold: retail GoldPickup_C t0/t1 star -1 stacks -1 OptionalInt = amount (box 2138: 63; deathbox: 38, 1934); 3K = t1 3000
  item("gold", "gold", `${ITEMS_DIR}/Gold/BP_ITEM_GoldPickup`, 0, -1, -1),
  item("gold3k", "gold", `${ITEMS_DIR}/Gold/BP_ITEM_GoldPickup3K`, 1, -1, -1),
  // degradable armor: TierNumber = armor tier, star -1, stacks -1, OptionalInt = floor(Armor/MaxArmor*100), OptionalInt2 = team (-1)
  ...[0, 1, 2, 3].map((t) => item(`armor${t}`, "armor", `${ITEMS_DIR}/DegradableArmor/BP_ITEM_DegradableArmor_T${t}`, t, -1, -1, t)),
  // consumables: retail Bandage_HQ t1 s1 n1, PhoenixKit t1 s1 n1. ArmorRepair values are NOT seen in a retail box (inferred = bandage's).
  item("bandage", "bandage", `${ITEMS_DIR}/Consumables/Bandage/BP_ITEM_Bandage_HQ`, 1, 1, 1),
  item("repair", "repair", `${ITEMS_DIR}/DegradableArmor/BP_Item_ArmorRepair_Consumable`, 1, 1, 1),
  item("phoenix", "phoenix", `${ITEMS_DIR}/Consumables/PhoenixKit/BP_ITEM_PhoenixKit`, 1, 1, 1),
].map((d) => [d.key, d]));
/** Shield points one armor piece of tier T gives in our sim. ESTIMATES (retail MaxArmor per tier not decoded yet). */
export const ARMOR_SHIELD = [Number(process.env.LOKI_LOOT_ARMOR_T0 || 75), 100, 125, 150];

// ------------------------------------------------------------------ box actor block
export const BOX_H = { RemoteRole: 5, ReplicatedMovement: 12, Role: 14, bIconVisible: 17 } as const;
export type V3 = [number, number, number];
export interface BoxMovement { flags: number; loc: V3; rot: V3; vel: V3 }   // rot = BYTE components (0-255), not degrees
export interface BoxActorProps { remoteRole?: number; movement?: BoxMovement; role?: number; iconVisible?: boolean }
export const yawByte = (deg: number) => Math.round((((deg % 360) + 360) % 360) * 256 / 360) & 0xff;

/** FRepMovement as these Loki BP actors write it: 4 flag bits, whole-unit location, byte rotation, whole-unit velocity. */
export function writeBoxMovement(w: BitWriter, m: BoxMovement) {
  Gas.writeBitsN(w, m.flags, 4);
  writeQuantizedVector(w, m.loc[0], m.loc[1], m.loc[2], 1);
  for (const b of m.rot) { w.bit(b !== 0); if (b) w.uint8(b); }
  writeQuantizedVector(w, m.vel[0], m.vel[1], m.vel[2], 1);
}
function readQVec(r: BitReader): V3 {
  const hdr = r.serializeInt(128);
  const n = hdr & 63;
  if (!(hdr & 64)) throw new Error("legacy packed vector");
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = r.bitsFrom(n);
    let v = 0n;
    for (let j = 0; j < n; j++) if ((raw[j >> 3]! >> (j & 7)) & 1) v |= 1n << BigInt(j);
    if (n && (v >> BigInt(n - 1)) & 1n) v -= 1n << BigInt(n);
    out.push(Number(v));
  }
  return out as V3;
}
export function readBoxMovement(r: BitReader): BoxMovement {
  const flags = Gas.readBitsN(r, 4);
  const loc = readQVec(r);
  const rot = [0, 0, 0].map(() => (r.bit() ? r.uint8() : 0)) as V3;
  return { flags, loc, rot, vel: readQVec(r) };
}
/** The box actor-block payload (checksum bit, handles ascending, terminator). */
export function encodeBoxActor(p: BoxActorProps): BitWriter {
  const w = new BitWriter(192);
  w.bit(false);
  if (p.remoteRole !== undefined) { w.packed32(BOX_H.RemoteRole); Gas.writeBitsN(w, p.remoteRole, 3); }
  if (p.movement) { w.packed32(BOX_H.ReplicatedMovement); writeBoxMovement(w, p.movement); }
  if (p.role !== undefined) { w.packed32(BOX_H.Role); Gas.writeBitsN(w, p.role, 3); }
  if (p.iconVisible !== undefined) { w.packed32(BOX_H.bIconVisible); w.bit(p.iconVisible); }
  w.packed32(0);
  return w;
}
/** Decode a box actor block; throws on a handle this codec does not know (callers treat that as SKIP). */
export function decodeBoxActor(buf: Uint8Array, bits: number): BoxActorProps & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  if (r.bit()) throw new Error("checksum bit set");
  const p: BoxActorProps = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    if (h === BOX_H.RemoteRole) p.remoteRole = Gas.readBitsN(r, 3);
    else if (h === BOX_H.ReplicatedMovement) p.movement = readBoxMovement(r);
    else if (h === BOX_H.Role) p.role = Gas.readBitsN(r, 3);
    else if (h === BOX_H.bIconVisible) p.iconVisible = r.bit();
    else throw new Error(`unsupported box handle ${h}`);
  }
  return { ...p, bitsRead: r.pos };
}
export const boxOpenProps = (loc: V3, yaw: number): BoxActorProps =>
  ({ remoteRole: 1, movement: { flags: 0, loc, rot: [0, yaw, 0], vel: [0, 0, 0] }, role: 3, iconVisible: true });

// ------------------------------------------------------------------ SimpleInventory InventoryData
export const INV_FIELD = 2, INV_BOUND = 4;
/** FLokiInventoryItemDataItem members (handles 1-12). Only present members are written (in handle order); a full send has all 12. */
export interface InvDesc {
  id?: number; itemClass?: bigint; tier?: number; star?: number; stacks?: number; opt?: number; opt2?: number;
  enchant?: bigint; additional?: bigint; overrideBase?: bigint; overrideUpgrade?: bigint; effects?: bigint[];
}
export function fullDesc(d: { id: number; itemClass: bigint; tier: number; star: number; stacks: number; opt: number; opt2: number }): InvDesc {
  return { ...d, enchant: 0n, additional: 0n, overrideBase: 0n, overrideUpgrade: 0n, effects: [] };
}
export function writeInvDesc(w: BitWriter, d: InvDesc) {
  const i32 = (h: number, v: number | undefined) => { if (v !== undefined) { w.packed32(h); w.int32(v); } };
  const obj = (h: number, v: bigint | undefined) => { if (v !== undefined) { w.packed32(h); w.packed64(v); } };
  i32(1, d.id); obj(2, d.itemClass); i32(3, d.tier); i32(4, d.star); i32(5, d.stacks); i32(6, d.opt); i32(7, d.opt2);
  obj(8, d.enchant); obj(9, d.additional); obj(10, d.overrideBase); obj(11, d.overrideUpgrade);
  if (d.effects !== undefined) {
    w.packed32(12); w.uint16(d.effects.length);
    d.effects.forEach((g, i) => { w.packed32(i + 1); w.packed64(g); });
    w.packed32(0);
  }
}
export function readInvDesc(r: BitReader): InvDesc {
  const d: InvDesc = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    switch (h) {
      case 1: d.id = r.int32(); break;
      case 2: d.itemClass = r.packed64(); break;
      case 3: d.tier = r.int32(); break;
      case 4: d.star = r.int32(); break;
      case 5: d.stacks = r.int32(); break;
      case 6: d.opt = r.int32(); break;
      case 7: d.opt2 = r.int32(); break;
      case 8: d.enchant = r.packed64(); break;
      case 9: d.additional = r.packed64(); break;
      case 10: d.overrideBase = r.packed64(); break;
      case 11: d.overrideUpgrade = r.packed64(); break;
      case 12: {
        const n = r.uint16(); const e: bigint[] = new Array(n).fill(0n);
        for (let k = r.packed32(); k; k = r.packed32()) { if (k > n) throw new Error("effects index"); e[k - 1] = r.packed64(); }
        d.effects = e; break;
      }
      default: throw new Error(`InventoryData: unknown member handle ${h}`);
    }
  }
  return d;
}
export interface InvDelta { fastDelta?: boolean; arrayKey: number; baseKey: number; deletes?: number[]; items: { repId: number; desc: InvDesc | null }[] }
/** The fast-array payload alone (no field header). */
export function encodeInventoryData(d: InvDelta): BitWriter {
  const w = new BitWriter(1024);
  Gas.writeFastArray(w, { fastDelta: d.fastDelta, arrayKey: d.arrayKey, baseKey: d.baseKey, deletes: d.deletes,
    changed: d.items.map((it) => ({ id: it.repId, write: it.desc ? (x: BitWriter) => writeInvDesc(x, it.desc!) : null })) });
  return w;
}
export function decodeInventoryData(buf: Uint8Array, bits: number, from = 0): InvDelta & { bitsRead: number } {
  const r = new BitReader(buf, bits); r.pos = from;
  const h = Gas.readFastArrayHeader(r);
  const items: InvDelta["items"] = [];
  for (let i = 0; i < h.nChg; i++) { const repId = r.uint32(); items.push({ repId, desc: r.bit() ? readInvDesc(r) : null }); }
  return { fastDelta: h.fastDelta, arrayKey: h.arrayKey, baseKey: h.baseKey, deletes: h.deletes, items, bitsRead: r.pos };
}
/** The SimpleInventory stable-block payload: [SerializeInt(2, 4)][packed bits][fast array]. */
export const encodeInventoryField = (d: InvDelta) => Gas.field(INV_FIELD, INV_BOUND, encodeInventoryData(d));
export function decodeInventoryField(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  const idx = r.serializeIntVar(INV_BOUND), n = r.packed32();
  if (idx !== INV_FIELD) throw new Error(`inventory field ${idx}`);
  const start = r.pos;
  const d = decodeInventoryData(buf, start + n, start);
  if (d.bitsRead !== start + n) throw new Error(`inventory data ${d.bitsRead - start}/${n} bits`);
  return { ...d, bitsRead: d.bitsRead };
}

/** Server-side SimpleInventory state with retail's key/ID rules. */
export class InventoryState {
  items: { repId: number; desc: InvDesc & { id: number } }[] = [];
  key = 0;
  private nextRepId = 1;
  private nextId = 0;
  add(d: Omit<InvDesc, "id">) { const desc = { ...d, id: this.nextId++ }; this.items.push({ repId: this.nextRepId++, desc }); this.key++; return desc; }
  /** Everything as one delta from the empty baseline (what a new connection is sent). */
  full(): InvDelta { return { arrayKey: this.key, baseKey: 0, items: this.items.map((it) => ({ repId: it.repId, desc: it.desc })) }; }
  /** Remove entries by descriptor ID; one key bump per delete, base = previous key. */
  remove(ids: number[]): { delta: InvDelta; removed: (InvDesc & { id: number })[] } | null {
    const gone = this.items.filter((it) => ids.includes(it.desc.id));
    if (!gone.length) return null;
    this.items = this.items.filter((it) => !gone.includes(it));
    const baseKey = this.key; this.key += gone.length;
    return { delta: { arrayKey: this.key, baseKey, deletes: gone.map((g) => g.repId), items: [] }, removed: gone.map((g) => g.desc) };
  }
}

// ------------------------------------------------------------------ C->S
export const INTERACTION = { name: "LokiInteractionPlayerComponent", bound: 6, ClientStopUsableInteraction: 2, ServerExecuteUsableInteraction: 3, ServerStopUsableInteraction: 4 } as const;
export const INVOPS = {
  name: "LokiInventoryOperationsV2", bound: 16, ClientInventoryError: 2, ServerDropCurrency: 3, ServerDropItem: 4, ServerGetFreeGameplayEffect: 5,
  ServerGetFreeItem: 6, ServerSwapItem: 7, ServerSwapItemFromInventory: 8, ServerSwapSlots: 9, ServerTakeAll: 10, ServerTakeItem: 11,
  ServerTakeSimpleInventoryItem: 12, ServerUpgradeItemWithHeroShard: 13, ServerUseItem: 14,
} as const;
export const EndResult = { Invalid: 0, Completed: 1, Failed: 2, Interrupted: 3, RepressInterrupted: 4, RepressRestart: 5, RepressStopped: 6,
  InstigatorDestroyed: 7, InstigatorLivingStateChange: 8, UsableDestroyed: 9, UsableRemoved: 10 } as const;

/** A client object reference: a NetGUID, or (NetGUID 1 = default) an inline export: flags, outer, path, optional checksum. */
export interface ObjRef { guid: bigint; flags?: number; outer?: ObjRef; path?: string; checksum?: number }
export function readObjRef(r: BitReader, depth = 0): ObjRef {
  const guid = r.packed64();
  if (guid !== 1n || depth > 8) return { guid };
  const flags = r.uint8();
  const o: ObjRef = { guid, flags };
  if (flags & 1) { o.outer = readObjRef(r, depth + 1); o.path = r.fstring(); if (flags & 4) o.checksum = r.uint32(); }
  return o;
}
export function writeObjRef(w: BitWriter, o: ObjRef) {
  w.packed64(o.guid);
  if (o.guid !== 1n) return;
  w.uint8(o.flags ?? 0);
  if ((o.flags ?? 0) & 1) { writeObjRef(w, o.outer ?? { guid: 0n }); w.fstring(o.path ?? ""); if ((o.flags ?? 0) & 4) w.uint32(o.checksum ?? 0); }
}
/** Every concrete NetGUID in a reference's outer chain (an inline export is guid 1 + outer + path). */
export function refGuids(o: ObjRef | null | undefined): bigint[] {
  const out: bigint[] = [];
  for (let x = o ?? undefined, d = 0; x && d < 10; x = x.outer, d++) if (x.guid !== 1n && x.guid !== 0n) out.push(x.guid);
  return out;
}
export function describeRef(o: ObjRef | null | undefined): string {
  if (!o) return "null";
  if (o.guid !== 1n) return `0x${o.guid.toString(16)}`;
  return `inline(${o.path ?? "?"} @ ${describeRef(o.outer)})`;
}
/** Inline references the client builds for objects it has no NetGUID for are resolved by proximity (LOKI_INLINE_NEAREST=0 = off). */
export const INLINE_NEAREST = process.env.LOKI_INLINE_NEAREST !== "0";
const optObj = (r: BitReader) => (r.bit() ? readObjRef(r) : null);
const optI32 = (r: BitReader, dflt: number) => (r.bit() ? r.int32() : dflt);
const putObj = (w: BitWriter, o: ObjRef | null) => { w.bit(!!o && o.guid !== 0n); if (o && o.guid !== 0n) writeObjRef(w, o); };
const putI32 = (w: BitWriter, v: number) => { w.bit(v !== 0); if (v !== 0) w.int32(v); };
const putEnum = (w: BitWriter, v: number, n: number) => { w.bit(v !== 0); if (v !== 0) Gas.writeBitsN(w, v, n); };

export interface ExecuteRpc { usable: ObjRef | null; instigator: ObjRef | null; interactionIndex: number; inputType: number; actionIndex: number }
export function decodeExecute(buf: Uint8Array, bits: number): ExecuteRpc & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const usable = optObj(r), instigator = optObj(r), interactionIndex = optI32(r, 0);
  const inputType = r.bit() ? Gas.readBitsN(r, 2) : 0;
  return { usable, instigator, interactionIndex, inputType, actionIndex: optI32(r, 0), bitsRead: r.pos };
}
export function encodeExecute(e: ExecuteRpc) {
  const w = new BitWriter(160);
  putObj(w, e.usable); putObj(w, e.instigator); putI32(w, e.interactionIndex); putEnum(w, e.inputType, 2); putI32(w, e.actionIndex);
  return w;
}
export interface StopRpc { usable: ObjRef | null; instigator: ObjRef | null; result: number }
export function decodeStop(buf: Uint8Array, bits: number): StopRpc & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const usable = optObj(r), instigator = optObj(r);
  return { usable, instigator, result: r.bit() ? Gas.readBitsN(r, 4) : 0, bitsRead: r.pos };
}
export function encodeStop(s: StopRpc) { const w = new BitWriter(96); putObj(w, s.usable); putObj(w, s.instigator); putEnum(w, s.result, 4); return w; }
export interface TakeRpc { source: ObjRef | null; id?: number }
export function decodeTakeAll(buf: Uint8Array, bits: number): TakeRpc & { bitsRead: number } {
  const r = new BitReader(buf, bits); return { source: optObj(r), bitsRead: r.pos };
}
export function encodeTakeAll(t: TakeRpc) { const w = new BitWriter(64); putObj(w, t.source); return w; }
export function decodeTakeOne(buf: Uint8Array, bits: number): TakeRpc & { bitsRead: number } {
  const r = new BitReader(buf, bits); const source = optObj(r); return { source, id: optI32(r, 0), bitsRead: r.pos };
}
export function encodeTakeOne(t: TakeRpc) { const w = new BitWriter(96); putObj(w, t.source); putI32(w, t.id ?? 0); return w; }

/** One client content block: [rep][isActor] (+ object ref when not the actor) [packed bits][payload]. */
export interface ClientBlock { rep: boolean; isActor: boolean; obj?: ObjRef; bits: number; data: Uint8Array }
export function parseClientBlocks(data: Uint8Array, bits: number): ClientBlock[] | null {
  try {
    const r = new BitReader(data, bits);
    const out: ClientBlock[] = [];
    while (r.bitsLeft > 3) {
      const rep = r.bit(), isActor = r.bit();
      const obj = isActor ? undefined : readObjRef(r);
      const n = r.packed32();
      if (n > r.bitsLeft) return null;
      out.push({ rep, isActor, obj, bits: n, data: r.bitsFrom(n) });
    }
    return out;
  } catch { return null; }
}
export function writeClientBlock(w: BitWriter, b: ClientBlock) {
  w.bit(b.rep); w.bit(b.isActor); if (!b.isActor) writeObjRef(w, b.obj ?? { guid: 0n });
  w.packed32(b.bits); if (b.bits) w.bitsFrom(b.data, b.bits);
}

// ------------------------------------------------------------------ S->C ASC traffic for the search spell
/** Field-8 delta granting the search spell (retail: one item, fields 1-7, no ReplicatedInstances). */
export function searchGrantDelta(o: { itemId: number; arrayKey: number; handle: number; ability: bigint; box: bigint; level?: number; inputId?: number }): Gas.AbilitySpecsDelta {
  return { arrayKey: o.arrayKey, baseKey: o.arrayKey - 1, items: [{ id: o.itemId, spec: {
    handle: o.handle, ability: o.ability, abilityName: { hardcoded: 0 }, level: o.level ?? SEARCH_LEVEL, inputId: o.inputId ?? SEARCH_INPUT_ID,
    inputIdPriority: 0, sourceObject: o.box } }] };
}
/** 20 ClientCancelAbility as retail sends it at the Stop: mode Authority, bWasEndedByOther, the client's activation key. */
export const encodeSearchCancel = (handle: number, key: Gas.PredictionKey) =>
  Gas.encodeClientCancelAbility(handle, { mode: Gas.ActivationMode.Authority, endedByOther: true, key });

// ------------------------------------------------------------------ spawns + loot roll
const BREACH = "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach";
export interface BoxSpawn { cls: BoxClass; loc: V3; yaw: number; source: "retail" | "floor" }
/** Retail box spots ([CAP] 7038/7039 opens: location + yaw byte verbatim). */
export const RETAIL_BOXES: BoxSpawn[] = ([
  ["LukeWarm", [-24624, 30132, -8], 220], ["LukeWarm", [5757, 11351, 2], 155], ["LukeWarm", [-1972, 46693, 10], 250],
  ["LukeWarm", [-35046, 7087, -3], 241], ["LukeWarm", [-962, 50541, 8], 141],
  ["Fortress", [-38609, 57472, 0], 186], ["Fortress", [-39741, 55970, 168], 122], ["Fortress", [-40635, 55175, 8], 186],
  ["Fortress", [-38774, 56209, 8], 186], ["Fortress", [-38680, 54746, 176], 216], ["Fortress", [-37010, 50657, 150], 186],
  ["Fortress", [-37009, 54045, 158], 232], ["Fortress", [-34580, 55700, 16], 212],
] as const).map(([cls, loc, yaw]) => ({ cls, loc: [...loc] as V3, yaw, source: "retail" as const }));

export function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Box list for a map: retail spots, then one box beside each terrain-verified player start whose offset point is over terrain
 *  (floorAt z). Only LVL_SkylandsBreach has boxes. */
export function boxSpawns(map: string, floorStarts: [number, number, number][], floorAt: (x: number, y: number) => number | null, max = LOOT_MAX_BOXES): BoxSpawn[] {
  if (map !== BREACH) return [];
  const out: BoxSpawn[] = RETAIL_BOXES.slice(0, max);
  for (const [x, y] of floorStarts) {
    if (out.length >= max) break;
    const px = Math.round(x + 350), py = Math.round(y + 250);
    const z = floorAt(px, py);
    if (z === null) continue;
    if (out.some((b) => Math.hypot(b.loc[0] - px, b.loc[1] - py) < 800)) continue;
    out.push({ cls: "LukeWarm", loc: [px, py, Math.round(z)], yaw: hash32(`${px},${py}`) & 0xff, source: "floor" });
  }
  return out;
}

export interface RolledItem { def: ItemDef; opt: number; opt2: number; stacks: number }
/** Roll one box: always gold, usually one armor piece (T0 45% / T1 30% / T2 18% / T3 7%), sometimes a bandage / repair kit.
 *  Our table (retail's per-box loot tables are not decoded); Fortress boxes roll one tier higher. */
export function rollBox(seed: number, cls: BoxClass): RolledItem[] {
  const r = rng(seed);
  const out: RolledItem[] = [];
  const fortress = cls === "Fortress";
  const gold = fortress && r() < 0.15 ? 3000 : (fortress ? 150 : 40) + Math.floor(r() * (fortress ? 250 : 160));
  out.push({ def: gold >= 3000 ? ITEMS.gold3k! : ITEMS.gold!, opt: gold, opt2: -1, stacks: -1 });
  if (r() < 0.85) {
    const x = r();
    let t = x < 0.45 ? 0 : x < 0.75 ? 1 : x < 0.93 ? 2 : 3;
    if (fortress) t = Math.min(3, t + 1);
    out.push({ def: ITEMS[`armor${t}`]!, opt: 100, opt2: -1, stacks: -1 });
  }
  if (r() < 0.5) { const n = 1 + Math.floor(r() * 2); out.push({ def: ITEMS.bandage!, opt: -1, opt2: -1, stacks: n }); }
  if (r() < 0.2) out.push({ def: ITEMS.repair!, opt: -1, opt2: -1, stacks: 1 });
  return out;
}
export const rolledDesc = (it: RolledItem): Omit<InvDesc, "id"> => {
  const d = fullDesc({ id: 0, itemClass: it.def.cls.guid, tier: it.def.tier, star: it.def.star, stacks: it.stacks, opt: it.opt, opt2: it.opt2 });
  delete (d as InvDesc).id;
  return d;
};
/** Item def from a descriptor's class GUID. */
export const itemByClass = (g: bigint | undefined) => Object.values(ITEMS).find((d) => d.cls.guid === g);

// ------------------------------------------------------------------ the manager (stateful; server.ts drives it)
export interface LootConn { channels: Set<number>; exportedGuids: Set<bigint> }
export interface LootPlayer { id: string; pcGuid: bigint; actorGuid: bigint; channel: number; x: number; y: number; z: number; alive: boolean;
  /** Box index the client's last move was based on (it stands on that box's slab / mesh), set by server.ts; undefined = none. */
  lootBaseBox?: number }
/** A client MovementBase reference (movement.ts MoveBaseRef): NetGUID, or NetGUID 1 + inline export (outer GUID + path). */
export interface BaseRef { guid: bigint; outerGuid?: bigint; path?: string }
/** Base-relative move location -> world, through the box's frame (root location + yaw). The box's slab sits ~3 uu off the root
 *  with its own yaw, so the planar distance to the box is exact to a few uu; the direction is approximate. */
export function boxRelToWorld(loc: V3, yawByte: number, rel: V3): V3 {
  const a = yawByte * 2 * Math.PI / 256, c = Math.cos(a), s = Math.sin(a);
  return [loc[0] + rel[0] * c - rel[1] * s, loc[1] + rel[0] * s + rel[1] * c, loc[2] + rel[2]];
}
export interface SendOpts { ch: number; open?: boolean; close?: boolean; reliable?: boolean; exports?: GuidExport[]; mustBeMapped?: bigint[] }
export interface LootHost<C extends LootConn> {
  log(msg: string): void;
  sendBunch(conn: C, body: (w: BitWriter) => void, opts: SendOpts): void;
  writeNewActor(w: BitWriter, guid: bigint, archetype: bigint, loc: V3, rot: V3): void;
  writeActorBlock(w: BitWriter, payload: BitWriter): void;
  writeStableBlock(w: BitWriter, guid: bigint, payload: BitWriter | null): void;
  conns(): C[];
  ord(p: LootPlayer): number;
  /** The owner's carrier channel + ASC GUID, and how many field-8 items the kit grant used (null = no GAS state yet). */
  carrier(conn: C, p: LootPlayer): { ch: number; asc: bigint; kitItems: number; kitKey: number } | null;
  /** Credit a taken item to the player in the match sim. */
  credit(p: LootPlayer, item: ItemDef, d: InvDesc): void;
  /** [interact] usables that are not searchable boxes (death boxes, interact.ts): true = handled there. */
  foreign?: {
    execute(conn: C, p: LootPlayer, e: ExecuteRpc, nearest?: boolean): boolean;
    stop(conn: C, p: LootPlayer, usable: bigint | undefined, result: number): boolean;
    take(conn: C, p: LootPlayer, source: bigint | undefined, id: number | null): boolean;
  };
}
interface BoxState { i: number; spawn: BoxSpawn; guid: bigint; inv: InventoryState }
interface Interaction { box: number; handle: number; itemId: number; key?: Gas.PredictionKey; startedAt: number; stoppedAt?: number }

export class LootManager<C extends LootConn> {
  boxes: BoxState[] = [];
  private asc = new Map<string, { key: number; nextItem: number; nextHandle: number }>();
  private open = new Map<string, Interaction>();
  private closed = new Map<string, Interaction>();
  private stats = { executes: 0, takes: 0, itemsTaken: 0, goldTaken: 0 };
  constructor(private host: LootHost<C>) {}

  /** (Re)build the world's boxes for a match (called once per world; seed decides the roll). */
  setup(spawns: BoxSpawn[], seed: number) {
    this.boxes = spawns.map((spawn, i) => {
      const inv = new InventoryState();
      for (const it of rollBox((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0, spawn.cls)) inv.add(rolledDesc(it));
      return { i, spawn, guid: boxGuid(i), inv };
    });
    this.open.clear(); this.closed.clear(); this.asc.clear();
    this.host.log(`[loot] world ready: ${this.boxes.length} boxes (${spawns.filter((s) => s.source === "retail").length} retail spots), seed ${seed >>> 0}`);
  }
  reset() { this.boxes = []; this.open.clear(); this.closed.clear(); this.asc.clear(); }
  status() { return { boxes: this.boxes.length, items: this.boxes.reduce((n, b) => n + b.inv.items.length, 0), open: this.open.size, ...this.stats }; }

  /** Open every box channel on one connection (box actor + SimpleInventory with the box's current contents). */
  spawnFor(conn: C) {
    let n = 0;
    for (const b of this.boxes) {
      const ch = LOOT_CH_BASE + b.i;
      if (conn.channels.has(ch)) continue;
      conn.channels.add(ch);
      const cls = BOX_CLASSES[b.spawn.cls];
      const exports: GuidExport[] = [];
      const add = (e: GuidExport[]) => { for (const x of e) if (!conn.exportedGuids.has(x.guid)) exports.push(x); };
      add(assetExports(cls));
      for (const it of b.inv.items) { const d = itemByClass(it.desc.itemClass); if (d) add(assetExports(d.cls)); }
      const uniq = exports.filter((e, k) => exports.findIndex((x) => x.guid === e.guid) === k);
      for (const e of uniq) conn.exportedGuids.add(e.guid);
      uniq.push({ guid: inventoryGuid(b.i), path: "SimpleInventory", outer: b.guid, noLoad: true });
      const actor = encodeBoxActor(boxOpenProps(b.spawn.loc, b.spawn.yaw));
      const inv = b.inv.items.length ? encodeInventoryField(b.inv.full()) : null;
      this.host.sendBunch(conn, (w) => {
        this.host.writeNewActor(w, b.guid, cls.guid, b.spawn.loc, [0, b.spawn.yaw * 360 / 256, 0]);
        this.host.writeActorBlock(w, actor);
        this.host.writeStableBlock(w, inventoryGuid(b.i), inv);
      }, { ch, open: true, reliable: true, exports: uniq, mustBeMapped: [cls.guid] });
      n++;
    }
    if (n) this.host.log(`[loot] ${n} boxes opened on a connection (ch ${LOOT_CH_BASE}-${LOOT_CH_BASE + this.boxes.length - 1})`);
  }

  /** Export the owner's two PC components by stable name (outer = PC), as retail's server does. */
  exportPcComponents(conn: C, p: LootPlayer) {
    if (!LOOT_EXPORT_PC_COMPS) return;
    const ord = this.host.ord(p);
    const ex: GuidExport[] = [
      { guid: interactionGuid(ord), path: INTERACTION.name, outer: p.pcGuid, noLoad: true },
      { guid: invOpsGuid(ord), path: INVOPS.name, outer: p.pcGuid, noLoad: true },
    ].filter((e) => !conn.exportedGuids.has(e.guid));
    if (!ex.length) return;
    this.host.sendBunch(conn, () => {}, { ch: p.channel, reliable: true, exports: ex });
    this.host.log(`[loot] exported PC components for ${p.id}: interaction 0x${interactionGuid(ord).toString(16)} invops 0x${invOpsGuid(ord).toString(16)}`);
  }

  /** Is this NetGUID / inline path one of this player's two loot components? */
  private compOf(p: LootPlayer, o: ObjRef | undefined): "interaction" | "invops" | null {
    if (!o) return null;
    const ord = this.host.ord(p);
    if (o.guid === interactionGuid(ord)) return "interaction";
    if (o.guid === invOpsGuid(ord)) return "invops";
    if (o.guid === 1n && o.outer?.guid === p.pcGuid) {
      if (o.path === INTERACTION.name || /InteractionPlayerComponent/i.test(o.path ?? "")) return "interaction";
      if (o.path === INVOPS.name || /InventoryOperations/i.test(o.path ?? "")) return "invops";
    }
    return null;
  }

  /** A PC-channel bunch from its owner. Returns the actor-block remainder (for the PC's own RPC handler) or null when nothing in it
   *  was a loot block (caller then handles the bunch exactly as before). */
  onPcBunch(conn: C, p: LootPlayer, data: Uint8Array, bits: number): { handled: number; actorBlocks: ClientBlock[] } | null {
    const blocks = parseClientBlocks(data, bits);
    if (!blocks) return null;
    let handled = 0;
    for (const b of blocks) {
      if (b.isActor || b.rep) continue;
      const comp = this.compOf(p, b.obj);
      if (!comp) { this.host.log(`[loot] pc subobject block not ours: ${describeRef(b.obj)} bits=${b.bits} from ${p.id}`); continue; }
      handled++;
      const fr = new BitReader(b.data, b.bits);
      const bound = comp === "interaction" ? INTERACTION.bound : INVOPS.bound;
      while (fr.bitsLeft > 0) {
        const idx = fr.serializeIntVar(bound), n = fr.packed32();
        if (n > fr.bitsLeft) { this.host.log(`[loot] ${comp} field ${idx} overflow`); break; }
        const f = fr.bitsFrom(n);
        try { this.onRpc(conn, p, comp, idx, f, n); } catch (e) { this.host.log(`[loot] ${comp} rpc ${idx} failed: ${e instanceof Error ? e.message : e}`); }
      }
    }
    if (!handled) return null;
    return { handled, actorBlocks: blocks.filter((b) => b.isActor) };
  }

  private boxByGuid(g: bigint | undefined) { return g === undefined ? undefined : this.boxes.find((b) => b.guid === g); }
  private boxByInventory(g: bigint | undefined) { return g === undefined ? undefined : this.boxes.find((b) => inventoryGuid(b.i) === g); }
  private boxByRef(o: ObjRef | null | undefined) {
    for (const g of refGuids(o)) { const b = this.boxByGuid(g) ?? this.boxByInventory(g); if (b) return b; }
    return undefined;
  }
  private nearestBox(p: LootPlayer) {
    let best: BoxState | undefined, bd = Infinity;
    for (const b of this.boxes) {
      if (!this.inRange(p, b)) continue;
      const d = p.lootBaseBox === b.i ? -1 : Math.hypot(p.x - b.spawn.loc[0], p.y - b.spawn.loc[1]);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  private inRange(p: LootPlayer, b: BoxState) {
    if (LOOT_ONBOX_IN_RANGE && p.lootBaseBox === b.i) return true;
    return Math.hypot(p.x - b.spawn.loc[0], p.y - b.spawn.loc[1]) <= LOOT_RANGE;
  }
  /** The box a client MovementBase belongs to (the box actor itself, or a component of it: outer = box, e.g. Box_TerrainBlockHazard,
   *  exported inline because we never name it), with its world transform for the base-relative location. */
  resolveBase(ref: BaseRef | undefined): { i: number; world: (rel: V3) => V3 } | null {
    if (!ref) return null;
    const g = ref.guid === 1n ? ref.outerGuid : ref.guid;
    const b = g === undefined ? undefined : this.boxes.find((x) => x.guid === g || inventoryGuid(x.i) === g);
    if (!b) return null;
    return { i: b.i, world: (rel) => boxRelToWorld(b.spawn.loc, b.spawn.yaw, rel) };
  }

  private onRpc(conn: C, p: LootPlayer, comp: "interaction" | "invops", idx: number, f: Uint8Array, n: number) {
    if (comp === "interaction" && idx === INTERACTION.ServerExecuteUsableInteraction) {
      const e = decodeExecute(f, n);
      this.execute(conn, p, e);
    } else if (comp === "interaction" && idx === INTERACTION.ServerStopUsableInteraction) {
      const s = decodeStop(f, n);
      this.stop(conn, p, s.usable, s.result);
    } else if (comp === "invops" && idx === INVOPS.ServerTakeAll) {
      const t = decodeTakeAll(f, n);
      this.take(conn, p, t.source?.guid, null);
    } else if (comp === "invops" && idx === INVOPS.ServerTakeSimpleInventoryItem) {
      const t = decodeTakeOne(f, n);
      this.take(conn, p, t.source?.guid, t.id ?? 0);
    } else {
      this.host.log(`[loot] ${comp} rpc idx=${idx} bits=${n} from ${p.id} (not handled)`);
    }
  }

  /** [interact] the shared per-player ASC field-8 counters (one key sequence for every server-granted usable spell). */
  sharedAsc(conn: C, p: LootPlayer) { return this.ascState(conn, p); }
  private ascState(conn: C, p: LootPlayer) {
    const car = this.host.carrier(conn, p);
    if (!car) return null;
    let s = this.asc.get(p.id);
    if (!s) { s = { key: car.kitKey, nextItem: car.kitItems + 1, nextHandle: 900000 + this.host.ord(p) * 1000 }; this.asc.set(p.id, s); }
    return { car, s };
  }

  private execute(conn: C, p: LootPlayer, e: ExecuteRpc) {
    let b = this.boxByRef(e.usable);
    if (!b && this.host.foreign?.execute(conn, p, e, false)) return;
    if (!b && e.usable?.guid === 1n && INLINE_NEAREST) {
      b = this.nearestBox(p);
      if (!b && this.host.foreign?.execute(conn, p, e, true)) return;
      if (b) this.host.log(`[loot] execute: inline usable ${describeRef(e.usable)} -> nearest box ${b.i}`);
    }
    if (!b) { this.host.log(`[loot] execute refused: usable ${describeRef(e.usable)} is not a box (player at ${Math.round(p.x)},${Math.round(p.y)})`); return; }
    if (!p.alive) { this.host.log(`[loot] execute refused: ${p.id} dead`); return; }
    if (!this.inRange(p, b)) { this.host.log(`[loot] execute refused: ${p.id} out of range ${Math.round(Math.hypot(p.x - b.spawn.loc[0], p.y - b.spawn.loc[1]))} > ${LOOT_RANGE}`); return; }
    const cur = this.open.get(p.id);
    if (cur && cur.box === b.i) { this.host.log(`[loot] execute repeat on box ${b.i} by ${p.id}`); return; }
    if (cur) this.stop(conn, p, this.boxes[cur.box]?.guid, EndResult.Interrupted);
    const st = this.ascState(conn, p);
    if (!st) { this.host.log(`[loot] execute refused: ${p.id} has no carrier/ASC yet`); return; }
    const { car, s } = st;
    const handle = s.nextHandle++, itemId = s.nextItem++;
    s.key++;
    const delta = searchGrantDelta({ itemId, arrayKey: s.key, handle, ability: SEARCH_SPELL.guid, box: b.guid });
    const exports = assetExports(SEARCH_SPELL).filter((x) => !conn.exportedGuids.has(x.guid));
    for (const x of exports) conn.exportedGuids.add(x.guid);
    this.host.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, car.asc, [Gas.ascField(Gas.ASC.ActivatableAbilities, Gas.encodeActivatableAbilities(delta))]),
      { ch: car.ch, reliable: true, exports, mustBeMapped: [SEARCH_SPELL.guid] });
    this.open.set(p.id, { box: b.i, handle, itemId, startedAt: Date.now() });
    this.closed.delete(p.id);
    this.stats.executes++;
    this.host.log(`[loot] execute ${p.id} box ${b.i} (${b.spawn.cls}, ${b.inv.items.length} items) d2D=${Math.round(Math.hypot(p.x - b.spawn.loc[0], p.y - b.spawn.loc[1]))}${p.lootBaseBox === b.i ? " on-box" : ""} -> grant GS_Search_Instant handle=${handle} item=${itemId} key=${s.key}`);
  }

  /** ServerTryActivateAbility hook: true when the handle is a live loot search spec (the caller then skips its normal handling). */
  onActivate(conn: C, p: LootPlayer, handle: number, key: Gas.PredictionKey): boolean {
    const it = this.open.get(p.id);
    if (!it || it.handle !== handle) return false;
    it.key = key;
    const st = this.ascState(conn, p);
    if (st) this.host.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, st.car.asc,
      [Gas.ascField(Gas.ASC.ClientActivateAbilitySucceed, Gas.encodeClientActivateAbilitySucceed(handle, key))]), { ch: st.car.ch, reliable: true });
    this.host.log(`[loot] search activated by ${p.id} handle=${handle} key=${key.current}`);
    return true;
  }
  isLootHandle(p: LootPlayer, handle: number) { return this.open.get(p.id)?.handle === handle; }

  private stop(conn: C, p: LootPlayer, ref: bigint | ObjRef | null | undefined, result: number) {
    // a concrete GUID must match the open box; an inline ref (or none) means "whatever this player has open"
    let usable: bigint | undefined;
    if (typeof ref === "bigint") usable = ref;
    else if (ref && ref.guid !== 1n) usable = ref.guid;
    else if (ref) usable = this.boxByRef(ref)?.guid;
    const it = this.open.get(p.id);
    if ((!it || (usable !== undefined && this.boxes[it.box]?.guid !== usable)) && this.host.foreign?.stop(conn, p, usable, result)) return;
    if (!it || (usable !== undefined && this.boxes[it.box]?.guid !== usable)) { this.host.log(`[loot] stop ignored from ${p.id} (no open interaction on ${typeof ref === "bigint" ? `0x${ref.toString(16)}` : describeRef(ref)})`); return; }
    this.open.delete(p.id);
    it.stoppedAt = Date.now();
    this.closed.set(p.id, it);
    const st = this.ascState(conn, p);
    if (st) {
      st.s.key++;
      const del: Gas.AbilitySpecsDelta = { arrayKey: st.s.key, baseKey: st.s.key - 1, deletes: [it.itemId], items: [] };
      // one ASC block, one bunch: cancel and the spec's removal land in the same packet (retail).
      this.host.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, st.car.asc, [
        Gas.ascField(Gas.ASC.ActivatableAbilities, Gas.encodeActivatableAbilities(del)),
        Gas.ascField(Gas.ASC.ClientCancelAbility, encodeSearchCancel(it.handle, it.key ?? { current: 0 })),
      ]), { ch: st.car.ch, reliable: true });
    }
    this.host.log(`[loot] stop ${p.id} box ${it.box} result=${result} -> cancel handle=${it.handle}`);
  }

  /** TakeAll (id null) / take one (descriptor ID): needs an open interaction on that box, or one stopped < 2 s ago. */
  private take(conn: C, p: LootPlayer, source: bigint | undefined, id: number | null) {
    const b = this.boxByInventory(source);
    if (!b && this.host.foreign?.take(conn, p, source, id)) return;
    if (!b) { this.host.log(`[loot] take refused: source ${source} is not a box inventory`); return; }
    const it = this.open.get(p.id) ?? this.closed.get(p.id);
    const live = it && it.box === b.i && (!it.stoppedAt || Date.now() - it.stoppedAt <= LOOT_TAKE_AFTER_STOP_MS);
    if (!live) { this.host.log(`[loot] take refused: ${p.id} has no interaction on box ${b.i}`); return; }
    if (!this.inRange(p, b)) { this.host.log(`[loot] take refused: ${p.id} out of range`); return; }
    const ids = id === null ? b.inv.items.map((x) => x.desc.id) : [id];
    const res = b.inv.remove(ids);
    if (!res) { this.host.log(`[loot] take ${p.id} box ${b.i}: nothing (${id === null ? "empty" : `bad id ${id}`})`); return; }
    for (const d of res.removed) {
      const def = itemByClass(d.itemClass);
      if (def) this.host.credit(p, def, d);
      this.stats.itemsTaken++;
      if (def?.kind === "gold") this.stats.goldTaken += d.opt ?? 0;
    }
    this.stats.takes++;
    const payload = encodeInventoryField(res.delta);
    setTimeout(() => this.broadcastInventory(b, payload), LOOT_TAKE_DELAY_MS);
    this.host.log(`[loot] take${id === null ? " all" : ` id ${id}`} ${p.id} box ${b.i}: ${res.removed.map((d) => `${itemByClass(d.itemClass)?.key ?? "?"}${d.opt !== undefined && d.opt >= 0 ? `(${d.opt})` : ""}`).join(", ")} -> key ${b.inv.key}`);
  }

  private broadcastInventory(b: BoxState, payload: BitWriter) {
    const ch = LOOT_CH_BASE + b.i;
    for (const conn of this.host.conns()) {
      if (!conn.channels.has(ch)) continue;
      this.host.sendBunch(conn, (w) => this.host.writeStableBlock(w, inventoryGuid(b.i), payload), { ch, reliable: true });
    }
  }

  /** The player died / left: close their interaction the way a Stop would (no client RPC needed). */
  endInteraction(conn: C | undefined, p: LootPlayer, why: string) {
    if (!this.open.has(p.id)) return;
    if (conn) this.stop(conn, p, undefined, EndResult.InstigatorLivingStateChange);
    else this.open.delete(p.id);
    this.host.log(`[loot] interaction of ${p.id} ended (${why})`);
  }
  forgetPlayer(id: string) { this.open.delete(id); this.closed.delete(id); this.asc.delete(id); }
}
