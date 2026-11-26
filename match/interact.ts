// Breach E-interactables beyond the searchable boxes of loot.ts: the in-match shop (basecamp shopkeeper + vending machines, the
// GameState's Comp_GameState_SkylandShop, the PC's Comp_PlayerController_Shop_Skylands buy RPCs), the PlayerState gold wallet, and
// death boxes (BP_DeathBox_C, looted through loot.ts's Execute / TakeAll / Stop with GS_DeathboxOpenOrRevive).
//
// Evidence (retail capture, Breach flows 7038 + 7039; gate tools/check-interact.ts; fixtures the capture decoder (not shipped) ->
// capture fixtures (not shipped) and the capture decoder (not shipped) -> capture fixtures (not shipped); inventory in AGENTS.md
// 2026-11-25 "interact"). Every encoder below reproduces its retail payloads bit-for-bit:
//   * Shopkeeper (LokiShopkeeper, 19 net fields): rep layout = AActor's h2 bHidden / h5 RemoteRole / h14 Role + BP h24 (a bool, 1 on the
//     remote-purchase GoldForAll shops, absent on vending machines: AllowsRemotePurchase). Its four ware arrays are custom-delta fields
//     11-14 (field header SerializeInt(idx, 19)), LEGACY fast arrays: [1][i32 ArrayKey][i32 BaseKey][i32 0 deletes][i32 n] then per item
//     [u32 ReplicationID][FLokiShopInventory: packed ItemClass, i32 Quantity, i32 PriceOverride, 3-bit ShopItemSource, bool bPrototype]
//     with no presence bit and no terminator (84 bits per item). Retail's GoldForAll open = rep block only, wares 0.7 s later in a
//     rep-less actor block; a vending machine's open carries rep layout + fields 11 and 13 in one block (1721 bits).
//   * Comp_GameState_SkylandShop (stable under the GameState): h14 GlobalShopkeep (null on retail Breach: V opens nothing), h16
//     BasecampShopkeep (the hidden GoldForAll at (0,0,-10000)). The client's bonfire menu buys from BasecampShopkeep remotely.
//   * Comp_PlayerController_Shop_Skylands (bound 14): C->S 7 TryABuyItem([send][FLokiShopInventory 84b], [send][Shopkeep],
//     bIsRemotePurchase) unreliable; S->C 5 ClientOnShopItemPurchased([send][struct], [send][Shopkeep]) reliable, 40-172 ms later, with
//     the PlayerState's h75 WalletStorage (TArray<int32> of 3, element 1 = gold) + h76 GoldSpentValue in the same instant.
//   * BP_DeathBox_C: h5 1, h12 movement (whole-unit loc, byte rot, no rotation sent), h14 3, h15 Instigator (dead hero), h17 bIconVisible,
//     h18 PlayerState (dead player's), h21 bIsMostRecentDeathBox, h23 ServerSpawnTime (float, server world time); h19 bOpen_ShardRes /
//     h20 bOpen_Item toggled at Execute (19 0, 20 1) and Stop (20 0). Subobjects SimpleInventory (loot.ts codec) + LokiTeam ([0][h3][u8 team][0]).
//
// NOT evidence (ours): what the shop grants (no inventory item actors exist yet -> sim credit: bandage heal, repair = shield refill,
// T4 armor = shield; other wares are listed but refused), death-box contents (rolled like a LukeWarm box), vending spots beyond the 12
// retail ones, shop open from a bonfire (client-side, never seen on our server). UNVERIFIED IN-CLIENT: all of it.
import { BitReader, BitWriter } from "./bits.ts";
import type { GuidExport } from "./protocol.ts";
import * as Gas from "./gas.ts";
import * as Loot from "./loot.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
export const INTERACT_ENABLED = env("LOKI_INTERACT", "1") !== "0";
export const WALLET_ENABLED = INTERACT_ENABLED && env("LOKI_WALLET", "1") !== "0";
export const SHOP_ENABLED = INTERACT_ENABLED && env("LOKI_SHOP", "1") !== "0";
/** GlobalShopkeep = the basecamp shop, so V opens it anywhere (retail Breach leaves it null; the -LokiServerShopGlobal). */
export const SHOP_GLOBAL = SHOP_ENABLED && env("LOKI_SHOP_GLOBAL", "1") !== "0";
export const VENDING_ENABLED = SHOP_ENABLED && env("LOKI_SHOP_VENDING", "1") !== "0";
/** Charge for wares we cannot credit (no item actor wire yet). Off: those buys are refused (retail sends nothing on a refusal). */
export const SHOP_SELL_ALL = env("LOKI_SHOP_SELL_ALL", "0") === "1";
export const SHOP_RANGE = Number(env("LOKI_SHOP_RANGE", "600"));
export const SHOP_REPLY_MS = Number(env("LOKI_SHOP_REPLY_MS", "60"));
export const SHOP_START_GOLD = Number(env("LOKI_SHOP_START_GOLD", "0"));
export const BANDAGE_HEAL = Number(env("LOKI_SHOP_BANDAGE_HEAL", "300"));
export const DEATHBOX_ENABLED = INTERACT_ENABLED && env("LOKI_DEATHBOX", "1") !== "0";
export const DEATHBOX_MAX = Math.min(80, Number(env("LOKI_DEATHBOX_MAX", "60")));
export const DEATHBOX_RANGE = Number(env("LOKI_DEATHBOX_RANGE", "600"));
export const CH_BASECAMP = Number(env("LOKI_INTERACT_CH", "900"));
export const CH_VENDING = CH_BASECAMP + 1;     // 901-915
export const CH_DEATHBOX = CH_BASECAMP + 20;   // 920-999

// ------------------------------------------------------------------ GUIDs (0xA0000-0xA7fff; disjoint from AGENTS.md's map)
export const shopCompGuid = (ord: number) => 0xa0000n + BigInt(ord) * 4n;   // per player, outer = PC
export const GUID_GS_SHOPCOMP = 0xa0100n;                                     // outer = GameState
export const GUID_BASECAMP = 0xa0200n;
export const vendingGuid = (i: number) => 0xa0300n + BigInt(i) * 0x10n;
export const deathBoxGuid = (i: number) => 0xa4000n + BigInt(i) * 0x10n;     // +2 SimpleInventory, +4 LokiTeam
const assetGuid = (k: number) => 0xa1001n + BigInt(k) * 4n;

const ASSETS: Loot.Asset[] = [];
function asset(pkg: string, obj: string): Loot.Asset {
  const a = { pkg, obj, pkgGuid: assetGuid(ASSETS.length), guid: assetGuid(ASSETS.length) + 2n };
  ASSETS.push(a);
  return a;
}
const SHOP_DIR = "/Game/Loki/Environment/Blueprints/FreeShop";
export const SHOPKEEPERS = {
  GoldForAll: asset(`${SHOP_DIR}/BP_Shop_SkylandsShopkeep_GoldForAll`, "Default__BP_Shop_SkylandsShopkeep_GoldForAll_C"),
  VendingMachine: asset(`${SHOP_DIR}/BP_Shop_SkylandsShopkeep_VendingMachine`, "Default__BP_Shop_SkylandsShopkeep_VendingMachine_C"),
} as const;
export const DEATHBOX_CLASS = asset("/Game/Loki/Usables/SearchableBox/DeathBox/BP_DeathBox", "Default__BP_DeathBox_C");
export const DEATHBOX_SPELL = asset("/Game/Loki/Usables/SearchableBox/GS_DeathboxOpenOrRevive", "Default__GS_DeathboxOpenOrRevive_C");

/** Item classes as class objects (`<Name>_C`, outer = package), the wares' ItemClass. Loot's own assets are reused where they exist. */
const ITEMS = "/Game/Loki/Items";
const ware = (pkg: string) => asset(pkg, `${pkg.split("/").pop()}_C`);
export type CreditKind = "heal" | "repair" | "armor" | "gold" | "none";
export interface WareDef { key: string; cls: Loot.Asset; price: number; credit: CreditKind; shield?: number }
/** CurrentWares1 of every Breach shopkeeper (retail: 11 entries, Quantity -1, PriceOverride -1, ShopItemSource 1, identical on the
 *  GoldForAll and every vending machine in both flows). Prices = what the retail client sent and the server charged
 *  (Bandage_HQ 200, ArmorRepair 400, PhoenixKit 1000); the rest have no retail purchase -> price unknown (refused unless SELL_ALL). */
export const WARES: WareDef[] = [
  { key: "bandage", cls: Loot.ITEMS.bandage!.cls, price: 200, credit: "heal" },
  { key: "repair", cls: Loot.ITEMS.repair!.cls, price: 400, credit: "repair" },
  { key: "recall", cls: ware(`${ITEMS}/Consumables/DeployCapturePoint/BP_Item_RecallCapturePoint`), price: -1, credit: "none" },
  { key: "phoenix", cls: Loot.ITEMS.phoenix!.cls, price: 1000, credit: "none" },
  { key: "aoeteleport", cls: ware(`${ITEMS}/ActiveItems/AoETeleport/BP_ITEM_Active_AoETeleport_Trinket`), price: -1, credit: "none" },
  { key: "nuke", cls: ware(`${ITEMS}/ActiveItems/TacticalNuke/BP_ITEM_Consumable_TacticalNuke`), price: -1, credit: "none" },
  { key: "mostwanted", cls: ware("/Game/Loki/Core/TeamAugments/InWorld/MostWanted/BP_ITEM_MostWanted_Pickup_Consumable"), price: -1, credit: "none" },
  { key: "jumppad", cls: ware(`${ITEMS}/Consumables/JumpPad/BP_ITEM_Jumppad`), price: -1, credit: "none" },
  { key: "mobilerespawn", cls: ware(`${ITEMS}/Consumables/MobileRespawn/BP_ITEM_MobileRespawnBeacon`), price: -1, credit: "none" },
  { key: "tempground", cls: ware(`${ITEMS}/ActiveItems/TemporaryGround/BP_ITEM_ConsumableTemporaryGround`), price: -1, credit: "none" },
  { key: "anomaly", cls: ware(`${ITEMS}/Consumables/Anomaly/BP_ITEM_Anomaly`), price: -1, credit: "none" },
];
/** VIPWares1 (field 13) on a vending machine: one item, Quantity 1, PriceOverride 777 (retail 7038: DegradableArmor_T4). */
export const VIP_WARE: WareDef = { key: "armor4", cls: ware(`${ITEMS}/DegradableArmor/BP_ITEM_DegradableArmor_T4`), price: 777, credit: "armor",
  shield: Number(env("LOKI_SHOP_T4_SHIELD", "175")) };

// ------------------------------------------------------------------ shopkeeper wire
export const SHOP_FIELDS = 19;
export const WARE_FIELD = { CurrentWares1: 11, SpecialWares1: 12, VIPWares1: 13, RegionSpecificWares1: 14 } as const;
export const SHOP_H = { bHidden: 2, RemoteRole: 5, Role: 14, AllowsRemotePurchase: 24 } as const;
export interface ShopInventory { itemClass: bigint; quantity: number; priceOverride: number; source: number; prototype: boolean }
export const wareEntry = (cls: bigint, quantity = -1, priceOverride = -1): ShopInventory => ({ itemClass: cls, quantity, priceOverride, source: 1, prototype: false });

export function writeShopInventory(w: BitWriter, s: ShopInventory) {
  w.packed64(s.itemClass); w.int32(s.quantity); w.int32(s.priceOverride); Gas.writeBitsN(w, s.source, 3); w.bit(s.prototype);
}
export function readShopInventory(r: BitReader): ShopInventory {
  return { itemClass: r.packed64(), quantity: r.int32(), priceOverride: r.int32(), source: Gas.readBitsN(r, 3), prototype: r.bit() };
}
export interface WareArray { arrayKey: number; baseKey: number; deletes?: number[]; items: { repId: number; inv: ShopInventory }[] }
/** Legacy (delta-struct off) fast array: header bit 1, keys, counts, then [ReplicationID][item] with no presence bit / terminator. */
export function encodeWareArray(a: WareArray): BitWriter {
  const w = new BitWriter(256 + a.items.length * 120);
  const dels = a.deletes ?? [];
  w.bit(true); w.int32(a.arrayKey); w.int32(a.baseKey); w.int32(dels.length); w.int32(a.items.length);
  for (const d of dels) w.uint32(d);
  for (const it of a.items) { w.uint32(it.repId); writeShopInventory(w, it.inv); }
  return w;
}
export function decodeWareArray(buf: Uint8Array, bits: number, from = 0): WareArray & { bitsRead: number; headerBit: boolean } {
  const r = new BitReader(buf, bits); r.pos = from;
  const headerBit = r.bit();
  const arrayKey = r.int32(), baseKey = r.int32(), nd = r.int32(), nc = r.int32();
  if (nd < 0 || nd > 256 || nc < 0 || nc > 256) throw new Error("ware array counts");
  const deletes: number[] = []; for (let i = 0; i < nd; i++) deletes.push(r.uint32());
  const items: WareArray["items"] = [];
  for (let i = 0; i < nc; i++) { const repId = r.uint32(); items.push({ repId, inv: readShopInventory(r) }); }
  return { arrayKey, baseKey, deletes: nd ? deletes : undefined, items, bitsRead: r.pos, headerBit };
}
export const wareList = (entries: ShopInventory[]): WareArray => ({ arrayKey: entries.length, baseKey: 0, items: entries.map((inv, i) => ({ repId: i + 1, inv })) });

export interface ShopRep { hidden?: boolean; remoteRole?: number; role?: number; allowsRemote?: boolean }
/** Rep-layout part of a shopkeeper actor block (checksum bit, handles ascending, terminator). */
export function writeShopRep(w: BitWriter, p: ShopRep) {
  w.bit(false);
  if (p.hidden !== undefined) { w.packed32(SHOP_H.bHidden); w.bit(p.hidden); }
  if (p.remoteRole !== undefined) { w.packed32(SHOP_H.RemoteRole); Gas.writeBitsN(w, p.remoteRole, 3); }
  if (p.role !== undefined) { w.packed32(SHOP_H.Role); Gas.writeBitsN(w, p.role, 3); }
  if (p.allowsRemote !== undefined) { w.packed32(SHOP_H.AllowsRemotePurchase); w.bit(p.allowsRemote); }
  w.packed32(0);
}
export function readShopRep(r: BitReader): ShopRep {
  if (r.bit()) throw new Error("checksum bit set");
  const p: ShopRep = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    if (h === SHOP_H.bHidden) p.hidden = r.bit();
    else if (h === SHOP_H.RemoteRole) p.remoteRole = Gas.readBitsN(r, 3);
    else if (h === SHOP_H.Role) p.role = Gas.readBitsN(r, 3);
    else if (h === SHOP_H.AllowsRemotePurchase) p.allowsRemote = r.bit();
    else throw new Error(`unsupported shopkeeper handle ${h}`);
  }
  return p;
}
export interface ShopBlock { rep?: ShopRep; wares: { field: number; arr: WareArray }[] }
/** A shopkeeper actor-block payload: optional rep layout, then the custom-delta ware fields (SerializeInt(idx, 19) + packed bits). */
export function encodeShopBlock(b: ShopBlock): BitWriter {
  const w = new BitWriter(2048);
  if (b.rep) writeShopRep(w, b.rep);
  for (const f of b.wares) { const x = Gas.field(f.field, SHOP_FIELDS, encodeWareArray(f.arr)); w.bitsFrom(x.buffer(), x.bits); }
  return w;
}
export function decodeShopBlock(buf: Uint8Array, bits: number, hasRep: boolean): ShopBlock & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const out: ShopBlock = { wares: [] };
  if (hasRep) out.rep = readShopRep(r);
  while (r.bitsLeft > 0) {
    const field = r.serializeIntVar(SHOP_FIELDS), n = r.packed32();
    if (n > r.bitsLeft) throw new Error("ware field overflow");
    const start = r.pos;
    const arr = decodeWareArray(buf, start + n, start);
    if (arr.bitsRead !== start + n) throw new Error(`ware field ${field}: ${arr.bitsRead - start}/${n} bits`);
    if (!arr.headerBit) throw new Error("ware array header bit 0");
    out.wares.push({ field, arr });
    r.pos = start + n;
  }
  return { ...out, bitsRead: r.pos };
}

// ------------------------------------------------------------------ Comp_GameState_SkylandShop
export const GSCOMP_H = { GlobalShopkeep: 14, BasecampShopkeep: 16 } as const;
export function encodeShopComp(c: { global?: bigint; basecamp?: bigint }): BitWriter {
  const w = new BitWriter(96);
  w.bit(false);
  if (c.global !== undefined) { w.packed32(GSCOMP_H.GlobalShopkeep); w.packed64(c.global); }
  if (c.basecamp !== undefined) { w.packed32(GSCOMP_H.BasecampShopkeep); w.packed64(c.basecamp); }
  w.packed32(0);
  return w;
}
export function decodeShopComp(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  if (r.bit()) throw new Error("checksum bit set");
  const c: { global?: bigint; basecamp?: bigint } = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    if (h === GSCOMP_H.GlobalShopkeep) c.global = r.packed64();
    else if (h === GSCOMP_H.BasecampShopkeep) c.basecamp = r.packed64();
    else throw new Error(`unsupported shop component handle ${h}`);
  }
  return { ...c, bitsRead: r.pos };
}

// ------------------------------------------------------------------ Comp_PlayerController_Shop_Skylands RPCs
export const PCSHOP = { name: "Comp_PlayerController_Shop_Skylands", bound: 14, ServerBuyShopSaleItem: 3, ServerSwapSlotAndBuyItem: 4,
  ClientOnShopItemPurchased: 5, ClientToggleShop: 6, TryABuyItem: 7, TryBuyImaginaryItem: 8, TryHandleBought: 11 } as const;
/** 11 TryHandleBought(AActor* Target): [send][object ref] (retail 7547: 9 bits, Target = NetGUID 0x7e). */
export function decodeHandleBought(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  const target = r.bit() ? Loot.readObjRef(r) : null;
  return { target, bitsRead: r.pos };
}
export function encodeHandleBought(target: Loot.ObjRef | null): BitWriter {
  const w = new BitWriter(96); w.bit(!!target && target.guid !== 0n); if (target && target.guid !== 0n) Loot.writeObjRef(w, target); return w;
}
export interface BuyRpc { item: ShopInventory | null; shopkeep: Loot.ObjRef | null; remote?: boolean }
export function decodeBuy(buf: Uint8Array, bits: number, withRemote: boolean): BuyRpc & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const item = r.bit() ? readShopInventory(r) : null;
  const shopkeep = r.bit() ? Loot.readObjRef(r) : null;
  const out: BuyRpc = { item, shopkeep };
  if (withRemote) out.remote = r.bit();
  return { ...out, bitsRead: r.pos };
}
export function encodeBuy(b: BuyRpc, withRemote: boolean): BitWriter {
  const w = new BitWriter(160);
  w.bit(!!b.item); if (b.item) writeShopInventory(w, b.item);
  const sk = b.shopkeep && b.shopkeep.guid !== 0n ? b.shopkeep : null;
  w.bit(!!sk); if (sk) Loot.writeObjRef(w, sk);
  if (withRemote) w.bit(!!b.remote);
  return w;
}

// ------------------------------------------------------------------ PlayerState wallet
export const PS_H = { WalletStorage: 75, GoldSpentValue: 76 } as const;
export const WALLET_SLOTS = 3;
/** h75 WalletStorage (uint16 ArrayNum 3, element handle 1 = gold) + h76 GoldSpentValue: retail's 121-bit PS block. */
export function encodeWallet(gold: number, spent?: number): BitWriter {
  const w = new BitWriter(160);
  w.bit(false);
  w.packed32(PS_H.WalletStorage); w.uint16(WALLET_SLOTS); w.packed32(1); w.int32(gold); w.packed32(0);
  if (spent !== undefined) { w.packed32(PS_H.GoldSpentValue); w.int32(spent); }
  w.packed32(0);
  return w;
}
export function decodeWallet(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  if (r.bit()) throw new Error("checksum bit set");
  let gold: number | undefined, spent: number | undefined, slots = 0;
  for (let h = r.packed32(); h; h = r.packed32()) {
    if (h === PS_H.WalletStorage) {
      slots = r.uint16();
      for (let e = r.packed32(); e; e = r.packed32()) { const v = r.int32(); if (e === 1) gold = v; }
    } else if (h === PS_H.GoldSpentValue) spent = r.int32();
    else throw new Error(`unsupported wallet handle ${h}`);
  }
  return { gold, spent, slots, bitsRead: r.pos };
}

// ------------------------------------------------------------------ death box wire
export const DB_H = { RemoteRole: 5, ReplicatedMovement: 12, Role: 14, Instigator: 15, bIconVisible: 17, PlayerState: 18,
  bOpen_ShardRes: 19, bOpen_Item: 20, bIsMostRecentDeathBox: 21, bHasBeenSalvaged: 22, ServerSpawnTime: 23 } as const;
export interface DeathBoxProps {
  remoteRole?: number; movement?: Loot.BoxMovement; role?: number; instigator?: bigint; iconVisible?: boolean; playerState?: bigint;
  openShardRes?: boolean; openItem?: boolean; mostRecent?: boolean; salvaged?: boolean; spawnTime?: number;
}
export function encodeDeathBox(p: DeathBoxProps): BitWriter {
  const w = new BitWriter(256);
  const b = (h: number, v: boolean | undefined) => { if (v !== undefined) { w.packed32(h); w.bit(v); } };
  w.bit(false);
  if (p.remoteRole !== undefined) { w.packed32(DB_H.RemoteRole); Gas.writeBitsN(w, p.remoteRole, 3); }
  if (p.movement) { w.packed32(DB_H.ReplicatedMovement); Loot.writeBoxMovement(w, p.movement); }
  if (p.role !== undefined) { w.packed32(DB_H.Role); Gas.writeBitsN(w, p.role, 3); }
  if (p.instigator !== undefined) { w.packed32(DB_H.Instigator); w.packed64(p.instigator); }
  b(DB_H.bIconVisible, p.iconVisible);
  if (p.playerState !== undefined) { w.packed32(DB_H.PlayerState); w.packed64(p.playerState); }
  b(DB_H.bOpen_ShardRes, p.openShardRes); b(DB_H.bOpen_Item, p.openItem); b(DB_H.bIsMostRecentDeathBox, p.mostRecent);
  b(DB_H.bHasBeenSalvaged, p.salvaged);
  if (p.spawnTime !== undefined) { w.packed32(DB_H.ServerSpawnTime); w.float(p.spawnTime); }
  w.packed32(0);
  return w;
}
export function decodeDeathBox(buf: Uint8Array, bits: number): DeathBoxProps & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  if (r.bit()) throw new Error("checksum bit set");
  const p: DeathBoxProps = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    switch (h) {
      case DB_H.RemoteRole: p.remoteRole = Gas.readBitsN(r, 3); break;
      case DB_H.ReplicatedMovement: p.movement = Loot.readBoxMovement(r); break;
      case DB_H.Role: p.role = Gas.readBitsN(r, 3); break;
      case DB_H.Instigator: p.instigator = r.packed64(); break;
      case DB_H.bIconVisible: p.iconVisible = r.bit(); break;
      case DB_H.PlayerState: p.playerState = r.packed64(); break;
      case DB_H.bOpen_ShardRes: p.openShardRes = r.bit(); break;
      case DB_H.bOpen_Item: p.openItem = r.bit(); break;
      case DB_H.bIsMostRecentDeathBox: p.mostRecent = r.bit(); break;
      case DB_H.bHasBeenSalvaged: p.salvaged = r.bit(); break;
      case DB_H.ServerSpawnTime: p.spawnTime = r.float(); break;
      default: throw new Error(`unsupported deathbox handle ${h}`);
    }
  }
  return { ...p, bitsRead: r.pos };
}
/** LokiTeam stable subobject: [0][h3 ReplicatedTeamIndex uint8][0] (retail 25 bits). */
export function encodeLokiTeam(team: number): BitWriter {
  const w = new BitWriter(32); w.bit(false); w.packed32(3); w.uint8(team); w.packed32(0); return w;
}
export function decodeLokiTeam(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  if (r.bit()) throw new Error("checksum bit set");
  let team: number | undefined;
  for (let h = r.packed32(); h; h = r.packed32()) { if (h === 3) team = r.uint8(); else throw new Error(`LokiTeam handle ${h}`); }
  return { team, bitsRead: r.pos };
}
export const deathBoxOpenProps = (loc: Loot.V3, instigator: bigint, ps: bigint, spawnTime: number): DeathBoxProps => ({
  remoteRole: 1, movement: { flags: 0, loc, rot: [0, 0, 0], vel: [0, 0, 0] }, role: 3, instigator, iconVisible: true, playerState: ps,
  mostRecent: true, spawnTime,
});

// ------------------------------------------------------------------ spots
export interface ShopSpawn { loc: Loot.V3; yaw: number }
/** Vending machines: the 12 distinct retail spots (7038 + 7039 opens; location NetQuantize10, yaw from the spawn rotation). */
export const RETAIL_VENDING: ShopSpawn[] = ([
  [[-21564.4, 45446.4, 0], 282.541], [[-30449.9, 41076.9, 0], 274.999], [[-9159.0, 6899.3, 0.2], 319.213], [[525.8, 6547.6, 0.2], 279.998],
  [[-8225.9, 18253.0, 0.2], 225.0], [[-2199.8, 40846.6, 2.0], 319.999], [[-16571.7, 35259.0, 450], 316.939], [[-190.5, 45327.7, 0], 312.078],
  [[-20803.7, 9717.9, 0], 240.002], [[-36609.6, 8447.4, -10], 279.998], [[-25534.9, 24040.5, 0], 226.467], [[-35242.8, 28808.7, 150], 305.002],
] as const).map(([loc, yaw]) => ({ loc: [...loc] as Loot.V3, yaw }));
export const BASECAMP_LOC: Loot.V3 = [0, 0, -10000];

// ------------------------------------------------------------------ the manager
export interface IxConn extends Loot.LootConn {}
export interface IxPlayer extends Loot.LootPlayer { psGuid: bigint; team: number; isBot?: boolean }
export interface IxHost<C extends IxConn> {
  log(msg: string): void;
  sendBunch(conn: C, body: (w: BitWriter) => void, opts: Loot.SendOpts): void;
  writeNewActor(w: BitWriter, guid: bigint, archetype: bigint, loc: Loot.V3, rot: Loot.V3): void;
  writeActorBlock(w: BitWriter, payload: BitWriter, hasRep: boolean): void;
  writeStableBlock(w: BitWriter, guid: bigint, hasRep: boolean, payload: BitWriter | null): void;
  conns(): C[];
  /** Each joined connection's own (human) player. */
  owners(): { conn: C; p: IxPlayer }[];
  ord(p: IxPlayer): number;
  gameStateGuid: bigint;
  gameStateCh: number;
  worldTime(): number;
  floorAt(x: number, y: number): number | null;
  gold(p: IxPlayer): number;
  spendGold(p: IxPlayer, amount: number): number | null;
  credit(p: IxPlayer, kind: CreditKind | "loot", amount: number, def?: Loot.ItemDef, d?: Loot.InvDesc): string;
  /** loot.ts's shared ASC allocator for this player (field-8 key / item / handle counters), or null. */
  asc(conn: C, p: IxPlayer): { car: { ch: number; asc: bigint }; s: { key: number; nextItem: number; nextHandle: number } } | null;
}
interface DeathBox { i: number; guid: bigint; loc: Loot.V3; inv: Loot.InventoryState; victim: string; team: number; instigator: bigint; ps: bigint;
  spawnTime: number; openBy: Set<string>; gone?: boolean }
interface DbInteraction { box: number; handle: number; itemId: number; key?: Gas.PredictionKey; stoppedAt?: number }
interface Shop { guid: bigint; ch: number; cls: Loot.Asset; spawn: ShopSpawn; remote: boolean; vip: boolean }

export class InteractManager<C extends IxConn> {
  shops: Shop[] = [];
  deathBoxes: DeathBox[] = [];
  private nextDb = 0;
  private dbOpen = new Map<string, DbInteraction>();
  private dbClosed = new Map<string, DbInteraction>();
  private walletSent = new Map<string, string>();
  private spent = new Map<string, number>();
  private startGold = new Set<string>();
  stats = { buys: 0, refused: 0, goldSpent: 0, deathBoxes: 0, dbExecutes: 0, dbTakes: 0 };
  constructor(private host: IxHost<C>) {}

  reset() {
    this.shops = []; this.deathBoxes = []; this.nextDb = 0; this.dbOpen.clear(); this.dbClosed.clear();
    this.walletSent.clear(); this.spent.clear(); this.startGold.clear();
  }
  status() { return { shops: this.shops.length, deathBoxes: this.deathBoxes.filter((b) => !b.gone).length, ...this.stats }; }

  private setupShops() {
    if (this.shops.length || !SHOP_ENABLED) return;
    this.shops.push({ guid: GUID_BASECAMP, ch: CH_BASECAMP, cls: SHOPKEEPERS.GoldForAll, spawn: { loc: BASECAMP_LOC, yaw: 0 }, remote: true, vip: false });
    if (VENDING_ENABLED) RETAIL_VENDING.slice(0, 15).forEach((spawn, i) =>
      this.shops.push({ guid: vendingGuid(i), ch: CH_VENDING + i, cls: SHOPKEEPERS.VendingMachine, spawn, remote: false, vip: true }));
  }

  /** Ship asset exports in small export-only bunches on the GameState channel (one bunch cannot carry 30 paths). */
  private exportAssets(conn: C, assets: Loot.Asset[]) {
    const todo = assets.filter((a) => !conn.exportedGuids.has(a.guid));
    for (let k = 0; k < todo.length; k += 3) {
      const ex: GuidExport[] = [];
      for (const a of todo.slice(k, k + 3)) for (const e of Loot.assetExports(a)) if (!conn.exportedGuids.has(e.guid)) { conn.exportedGuids.add(e.guid); ex.push(e); }
      if (ex.length) this.host.sendBunch(conn, () => {}, { ch: this.host.gameStateCh, reliable: true, exports: ex });
    }
  }
  private wareEntries(): ShopInventory[] { return WARES.map((w) => wareEntry(w.cls.guid)); }

  /** Shops + existing death boxes + the owner's shop component, on one connection (Breach only; server.ts decides when). */
  spawnFor(conn: C, owner: IxPlayer | undefined) {
    if (owner) this.exportPcComponent(conn, owner);
    if (owner && SHOP_START_GOLD > 0 && !this.startGold.has(owner.id)) { this.startGold.add(owner.id); this.host.credit(owner, "gold", SHOP_START_GOLD); }
    if (SHOP_ENABLED) {
      this.setupShops();
      this.exportAssets(conn, [...this.shops.map((s) => s.cls), ...WARES.map((w) => w.cls), VIP_WARE.cls]);
      for (const s of this.shops) {
        if (conn.channels.has(s.ch)) continue;
        conn.channels.add(s.ch);
        const rot: Loot.V3 = [0, s.spawn.yaw, 0];
        if (s.remote) {
          // retail GoldForAll: open = rep only (h2 hidden, h5, h14, h24), the wares follow in a rep-less actor block
          const rep = encodeShopBlock({ rep: { hidden: true, remoteRole: 1, role: 3, allowsRemote: true }, wares: [] });
          this.host.sendBunch(conn, (w) => { this.host.writeNewActor(w, s.guid, s.cls.guid, s.spawn.loc, rot); this.host.writeActorBlock(w, rep, true); },
            { ch: s.ch, open: true, reliable: true, mustBeMapped: [s.cls.guid] });
          const wares = encodeShopBlock({ wares: [{ field: WARE_FIELD.CurrentWares1, arr: wareList(this.wareEntries()) }] });
          this.host.sendBunch(conn, (w) => this.host.writeActorBlock(w, wares, false), { ch: s.ch, reliable: true });
        } else {
          const blk = encodeShopBlock({ rep: { remoteRole: 1, role: 3 }, wares: [
            { field: WARE_FIELD.CurrentWares1, arr: wareList(this.wareEntries()) },
            { field: WARE_FIELD.VIPWares1, arr: wareList([wareEntry(VIP_WARE.cls.guid, 1, VIP_WARE.price)]) }] });
          this.host.sendBunch(conn, (w) => { this.host.writeNewActor(w, s.guid, s.cls.guid, s.spawn.loc, rot); this.host.writeActorBlock(w, blk, true); },
            { ch: s.ch, open: true, reliable: true, mustBeMapped: [s.cls.guid] });
        }
      }
      // Comp_GameState_SkylandShop: BasecampShopkeep (+ GlobalShopkeep so V opens it)
      const comp = encodeShopComp({ global: SHOP_GLOBAL ? GUID_BASECAMP : undefined, basecamp: GUID_BASECAMP });
      const ex: GuidExport[] = conn.exportedGuids.has(GUID_GS_SHOPCOMP) ? [] : [{ guid: GUID_GS_SHOPCOMP, path: "Comp_GameState_SkylandShop", outer: this.host.gameStateGuid, noLoad: true }];
      for (const e of ex) conn.exportedGuids.add(e.guid);
      this.host.sendBunch(conn, (w) => this.host.writeStableBlock(w, GUID_GS_SHOPCOMP, true, comp), { ch: this.host.gameStateCh, reliable: true, exports: ex });
      this.host.log(`[shop] ${this.shops.length} shopkeepers on a connection (basecamp ch ${CH_BASECAMP}${VENDING_ENABLED ? `, vending ch ${CH_VENDING}-${CH_VENDING + this.shops.length - 2}` : ""}), global=${SHOP_GLOBAL}`);
    }
    if (DEATHBOX_ENABLED) for (const b of this.deathBoxes) if (!b.gone) this.openDeathBox(conn, b);
    if (owner) this.syncWallet(conn, owner, true);
  }

  private exportPcComponent(conn: C, p: IxPlayer) {
    if (!SHOP_ENABLED) return;
    const g = shopCompGuid(this.host.ord(p));
    if (conn.exportedGuids.has(g)) return;
    conn.exportedGuids.add(g);
    this.host.sendBunch(conn, () => {}, { ch: p.channel, reliable: true, exports: [{ guid: g, path: PCSHOP.name, outer: p.pcGuid, noLoad: true }] });
  }

  // ---------------------------------------------------------------- wallet
  /** PS h75/h76 to the owner when the purse moved (or always, with force). */
  syncWallet(conn: C, p: IxPlayer, force = false) {
    if (!WALLET_ENABLED) return;
    const gold = this.host.gold(p), spent = this.spent.get(p.id) ?? 0;
    const sig = `${gold}/${spent}`;
    if (!force && this.walletSent.get(p.id) === sig) return;
    if (!conn.channels.has(p.channel - 1)) return;
    this.walletSent.set(p.id, sig);
    const w = encodeWallet(gold, spent);
    this.host.sendBunch(conn, (x) => this.host.writeActorBlock(x, w, true), { ch: p.channel - 1, reliable: true });
  }
  tick() { for (const { conn, p } of this.host.owners()) this.syncWallet(conn, p); }

  // ---------------------------------------------------------------- PC bunches (shop RPCs)
  private isShopComp(p: IxPlayer, o: Loot.ObjRef | undefined) {
    if (!o) return false;
    if (o.guid === shopCompGuid(this.host.ord(p))) return true;
    return o.guid === 1n && o.outer?.guid === p.pcGuid && (o.path === PCSHOP.name || /shop/i.test(o.path ?? ""));
  }
  /** Pull this player's shop-component RPC blocks out of a PC bunch. Returns null when there were none; otherwise the remaining blocks
   *  re-encoded (bits 0 = nothing left) for the existing loot / PC handlers. */
  onPcBunch(conn: C, p: IxPlayer, data: Uint8Array, bits: number): { data: Uint8Array; bits: number } | null {
    if (!SHOP_ENABLED) return null;
    const blocks = Loot.parseClientBlocks(data, bits);
    if (!blocks || !blocks.some((b) => !b.isActor && this.isShopComp(p, b.obj))) return null;
    const rest = new BitWriter(bits + 64);
    for (const b of blocks) {
      if (b.isActor || !this.isShopComp(p, b.obj)) { Loot.writeClientBlock(rest, b); continue; }
      if (b.obj?.guid === 1n) { const g = shopCompGuid(this.host.ord(p)); conn.exportedGuids.add(g); }
      const fr = new BitReader(b.data, b.bits);
      while (fr.bitsLeft > 0) {
        const idx = fr.serializeIntVar(PCSHOP.bound), n = fr.packed32();
        if (n > fr.bitsLeft) { this.host.log(`[shop] rpc ${idx} overflow`); break; }
        const f = fr.bitsFrom(n);
        try {
          if (idx === PCSHOP.TryABuyItem) this.buy(conn, p, decodeBuy(f, n, true));
          else if (idx === PCSHOP.TryHandleBought) {
            // retail FFA 7547: sent right after each armory ServerBuyItem (armory.ts), [send][Target NetGUID]; no server reply isolated
            const t = decodeHandleBought(f, n);
            this.host.log(`[shop] TryHandleBought from ${p.id} target=${Loot.describeRef(t.target)} (no reply, as retail)`);
          } else this.host.log(`[shop] rpc idx=${idx} bits=${n} from ${p.id} (not handled)`);
        } catch (e) { this.host.log(`[shop] rpc ${idx} failed: ${e instanceof Error ? e.message : e}`); }
      }
    }
    return { data: rest.buffer(), bits: rest.bits };
  }

  /** Retail's checks (shopkeeper, range or remote, ware, price, wallet) -> charge, credit, ClientOnShopItemPurchased + wallet. */
  buy(conn: C, p: IxPlayer, b: BuyRpc) {
    const refuse = (why: string) => { this.stats.refused++; this.host.log(`[shop] buy refused ${p.id}: ${why}`); };
    if (!b.item) return refuse("no item");
    const guids = Loot.refGuids(b.shopkeep);
    let shop = this.shops.find((s) => guids.includes(s.guid));
    if (!shop && (!b.shopkeep || b.shopkeep.guid === 1n) && Loot.INLINE_NEAREST) {
      // client named a shopkeeper we never gave it a GUID for: nearest in range, else the remote (global) shop for a remote buy
      let bd = SHOP_RANGE;
      for (const s of this.shops) { const d = Math.hypot(p.x - s.spawn.loc[0], p.y - s.spawn.loc[1]); if (d <= bd) { bd = d; shop = s; } }
      if (!shop && b.remote) shop = this.shops.find((s) => s.remote);
      if (shop) this.host.log(`[shop] inline shopkeep ${Loot.describeRef(b.shopkeep)} -> shop 0x${shop.guid.toString(16)}`);
    }
    if (!shop) return refuse(`shopkeep ${Loot.describeRef(b.shopkeep)} is not ours (player at ${Math.round(p.x)},${Math.round(p.y)})`);
    if (!p.alive) return refuse("dead");
    if (!(shop.remote && b.remote)) {
      const d = Math.hypot(p.x - shop.spawn.loc[0], p.y - shop.spawn.loc[1]);
      if (d > SHOP_RANGE) return refuse(`out of range ${Math.round(d)} > ${SHOP_RANGE}`);
    }
    const def = WARES.find((w) => w.cls.guid === b.item!.itemClass) ?? (shop.vip && VIP_WARE.cls.guid === b.item.itemClass ? VIP_WARE : undefined);
    if (!def) return refuse(`class ${b.item.itemClass} is not a ware of this shop`);
    const price = def.price >= 0 ? def.price : b.item.priceOverride;
    if (price < 0) return refuse(`${def.key}: no price`);
    if (def.credit === "none" && !SHOP_SELL_ALL) return refuse(`${def.key}: no item wire yet (LOKI_SHOP_SELL_ALL=1 charges anyway)`);
    const left = this.host.spendGold(p, price);
    if (left === null) return refuse(`${def.key} costs ${price}, purse ${this.host.gold(p)}`);
    this.spent.set(p.id, (this.spent.get(p.id) ?? 0) + price);
    this.stats.buys++; this.stats.goldSpent += price;
    const got = this.host.credit(p, def.credit, def.credit === "armor" ? def.shield ?? 0 : def.credit === "heal" ? BANDAGE_HEAL : 0);
    const reply = Gas.field(PCSHOP.ClientOnShopItemPurchased, PCSHOP.bound, encodeBuy({ item: b.item, shopkeep: { guid: shop.guid } }, false));
    const comp = shopCompGuid(this.host.ord(p));
    setTimeout(() => {
      this.host.sendBunch(conn, (w) => this.host.writeStableBlock(w, comp, false, reply), { ch: p.channel, reliable: true });
      this.syncWallet(conn, p, true);
    }, SHOP_REPLY_MS);
    this.host.log(`[shop] ${p.id} bought ${def.key} for ${price}${b.remote ? " (remote)" : ""} -> purse ${left}, ${got}`);
  }

  // ---------------------------------------------------------------- death boxes
  onDeath(victim: IxPlayer, seed: number) {
    if (!DEATHBOX_ENABLED) return;
    const live = this.deathBoxes.filter((b) => !b.gone);
    if (live.length >= DEATHBOX_MAX) this.removeDeathBox(live[0]!);
    const i = this.nextDb++ % 80;
    const old = this.deathBoxes.find((b) => b.i === i && !b.gone); if (old) this.removeDeathBox(old);
    for (const b of this.deathBoxes) if (b.victim === victim.id && !b.gone) this.setProps(b, { mostRecent: false });
    const fz = this.host.floorAt(victim.x, victim.y);
    const loc: Loot.V3 = [Math.round(victim.x), Math.round(victim.y), Math.round(fz ?? victim.z)];
    const inv = new Loot.InventoryState();
    for (const it of Loot.rollBox(seed >>> 0, "LukeWarm")) inv.add(Loot.rolledDesc(it));
    const box: DeathBox = { i, guid: deathBoxGuid(i), loc, inv, victim: victim.id, team: Math.max(0, victim.team), instigator: victim.actorGuid,
      ps: victim.psGuid, spawnTime: this.host.worldTime(), openBy: new Set() };
    this.deathBoxes = this.deathBoxes.filter((b) => b.i !== i);
    this.deathBoxes.push(box);
    this.stats.deathBoxes++;
    for (const conn of this.host.conns()) this.openDeathBox(conn, box);
    this.host.log(`[deathbox] ${victim.id} -> box ${i} at (${loc.join(",")}) ${inv.items.length} items`);
  }
  private openDeathBox(conn: C, b: DeathBox) {
    const ch = CH_DEATHBOX + b.i;
    if (conn.channels.has(ch)) return;
    conn.channels.add(ch);
    const ex: GuidExport[] = [];
    const add = (a: Loot.Asset) => { for (const e of Loot.assetExports(a)) if (!conn.exportedGuids.has(e.guid)) { conn.exportedGuids.add(e.guid); ex.push(e); } };
    add(DEATHBOX_CLASS);
    for (const it of b.inv.items) { const d = Loot.itemByClass(it.desc.itemClass); if (d) add(d.cls); }
    ex.push({ guid: b.guid + 2n, path: "SimpleInventory", outer: b.guid, noLoad: true }, { guid: b.guid + 4n, path: "LokiTeam", outer: b.guid, noLoad: true });
    const actor = encodeDeathBox({ ...deathBoxOpenProps(b.loc, b.instigator, b.ps, b.spawnTime), mostRecent: this.isMostRecent(b) });
    const inv = b.inv.items.length ? Loot.encodeInventoryField(b.inv.full()) : null;
    this.host.sendBunch(conn, (w) => {
      this.host.writeNewActor(w, b.guid, DEATHBOX_CLASS.guid, b.loc, [0, 0, 0]);
      this.host.writeActorBlock(w, actor, true);
      this.host.writeStableBlock(w, b.guid + 2n, false, inv);
      this.host.writeStableBlock(w, b.guid + 4n, true, encodeLokiTeam(b.team));
    }, { ch, open: true, reliable: true, exports: ex, mustBeMapped: [DEATHBOX_CLASS.guid] });
  }
  private isMostRecent(b: DeathBox) { return !this.deathBoxes.some((x) => x !== b && !x.gone && x.victim === b.victim && x.spawnTime > b.spawnTime); }
  private setProps(b: DeathBox, p: DeathBoxProps) {
    const payload = encodeDeathBox(p);
    for (const conn of this.host.conns()) {
      const ch = CH_DEATHBOX + b.i;
      if (conn.channels.has(ch)) this.host.sendBunch(conn, (w) => this.host.writeActorBlock(w, payload, true), { ch, reliable: true });
    }
  }
  private removeDeathBox(b: DeathBox) {
    b.gone = true;
    for (const conn of this.host.conns()) {
      const ch = CH_DEATHBOX + b.i;
      if (!conn.channels.has(ch)) continue;
      conn.channels.delete(ch);
      this.host.sendBunch(conn, () => {}, { ch, close: true, reliable: true });
    }
  }
  private dbByGuid(g: bigint | undefined) { return this.deathBoxes.find((b) => !b.gone && b.guid === g); }

  /** loot.ts foreign hooks: Execute / Stop / Take on a usable that is not a searchable box. True = handled here. */
  execute(conn: C, p: IxPlayer, e: Loot.ExecuteRpc, nearest = false): boolean {
    let b: DeathBox | undefined;
    for (const g of Loot.refGuids(e.usable)) if ((b = this.dbByGuid(g) ?? this.deathBoxes.find((x) => !x.gone && (x.guid + 2n === g || x.guid + 4n === g)))) break;
    if (!b && nearest) {
      let bd = DEATHBOX_RANGE;
      for (const x of this.deathBoxes) { if (x.gone) continue; const d = Math.hypot(p.x - x.loc[0], p.y - x.loc[1]); if (d <= bd) { bd = d; b = x; } }
      if (b) this.host.log(`[deathbox] execute: inline usable ${Loot.describeRef(e.usable)} -> nearest box ${b.i}`);
    }
    if (!b) return false;
    const d = Math.hypot(p.x - b.loc[0], p.y - b.loc[1]);
    if (!p.alive) { this.host.log(`[deathbox] execute refused: ${p.id} dead`); return true; }
    if (d > DEATHBOX_RANGE) { this.host.log(`[deathbox] execute refused: ${p.id} out of range ${Math.round(d)} > ${DEATHBOX_RANGE}`); return true; }
    const cur = this.dbOpen.get(p.id);
    if (cur && cur.box === b.i) { this.host.log(`[deathbox] execute repeat on box ${b.i} by ${p.id}`); return true; }
    if (cur) this.stop(conn, p, undefined, Loot.EndResult.Interrupted);
    const st = this.host.asc(conn, p);
    if (!st) { this.host.log(`[deathbox] execute refused: ${p.id} has no carrier/ASC yet`); return true; }
    const handle = st.s.nextHandle++, itemId = st.s.nextItem++;
    st.s.key++;
    const delta = Loot.searchGrantDelta({ itemId, arrayKey: st.s.key, handle, ability: DEATHBOX_SPELL.guid, box: b.guid });
    const ex = Loot.assetExports(DEATHBOX_SPELL).filter((x) => !conn.exportedGuids.has(x.guid));
    for (const x of ex) conn.exportedGuids.add(x.guid);
    this.host.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, st.car.asc, [Gas.ascField(Gas.ASC.ActivatableAbilities, Gas.encodeActivatableAbilities(delta))]),
      { ch: st.car.ch, reliable: true, exports: ex, mustBeMapped: [DEATHBOX_SPELL.guid] });
    this.dbOpen.set(p.id, { box: b.i, handle, itemId });
    this.dbClosed.delete(p.id);
    if (!b.openBy.size) this.setProps(b, { openShardRes: false, openItem: true });   // retail 4ca00400 at the Execute
    b.openBy.add(p.id);
    this.stats.dbExecutes++;
    this.host.log(`[deathbox] execute ${p.id} box ${b.i} (${b.victim}, ${b.inv.items.length} items) -> grant GS_DeathboxOpenOrRevive handle=${handle} key=${st.s.key}`);
    return true;
  }
  onActivate(conn: C, p: IxPlayer, handle: number, key: Gas.PredictionKey): boolean {
    const it = this.dbOpen.get(p.id);
    if (!it || it.handle !== handle) return false;
    it.key = key;
    const st = this.host.asc(conn, p);
    if (st) this.host.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, st.car.asc,
      [Gas.ascField(Gas.ASC.ClientActivateAbilitySucceed, Gas.encodeClientActivateAbilitySucceed(handle, key))]), { ch: st.car.ch, reliable: true });
    return true;
  }
  stop(conn: C, p: IxPlayer, usable: bigint | undefined, result: number): boolean {
    const it = this.dbOpen.get(p.id);
    const b = it ? this.deathBoxes.find((x) => x.i === it.box) : undefined;
    if (!it || !b || (usable !== undefined && b.guid !== usable)) return false;
    this.dbOpen.delete(p.id);
    it.stoppedAt = Date.now();
    this.dbClosed.set(p.id, it);
    const st = this.host.asc(conn, p);
    if (st) {
      st.s.key++;
      const del: Gas.AbilitySpecsDelta = { arrayKey: st.s.key, baseKey: st.s.key - 1, deletes: [it.itemId], items: [] };
      this.host.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, st.car.asc, [
        Gas.ascField(Gas.ASC.ActivatableAbilities, Gas.encodeActivatableAbilities(del)),
        Gas.ascField(Gas.ASC.ClientCancelAbility, Loot.encodeSearchCancel(it.handle, it.key ?? { current: 0 })),
      ]), { ch: st.car.ch, reliable: true });
    }
    b.openBy.delete(p.id);
    if (!b.openBy.size && !b.gone) this.setProps(b, { openItem: false });   // retail 500000 at the Stop
    this.host.log(`[deathbox] stop ${p.id} box ${b.i} result=${result}`);
    return true;
  }
  take(conn: C, p: IxPlayer, source: bigint | undefined, id: number | null): boolean {
    const b = this.deathBoxes.find((x) => !x.gone && x.guid + 2n === source);
    if (!b) return false;
    const it = this.dbOpen.get(p.id) ?? this.dbClosed.get(p.id);
    if (!it || it.box !== b.i || (it.stoppedAt && Date.now() - it.stoppedAt > Loot.LOOT_TAKE_AFTER_STOP_MS)) {
      this.host.log(`[deathbox] take refused: ${p.id} has no interaction on box ${b.i}`); return true;
    }
    const res = b.inv.remove(id === null ? b.inv.items.map((x) => x.desc.id) : [id]);
    if (!res) { this.host.log(`[deathbox] take ${p.id} box ${b.i}: nothing`); return true; }
    const got = res.removed.map((d) => { const def = Loot.itemByClass(d.itemClass); return def ? this.host.credit(p, "loot", 0, def, d) : "?"; });
    this.stats.dbTakes++;
    const payload = Loot.encodeInventoryField(res.delta);
    setTimeout(() => {
      for (const c of this.host.conns()) {
        const ch = CH_DEATHBOX + b.i;
        if (c.channels.has(ch)) this.host.sendBunch(c, (w) => this.host.writeStableBlock(w, b.guid + 2n, false, payload), { ch, reliable: true });
      }
    }, Loot.LOOT_TAKE_DELAY_MS);
    this.host.log(`[deathbox] take ${p.id} box ${b.i}: ${got.join(", ")}`);
    return true;
  }
  endInteraction(conn: C | undefined, p: IxPlayer) {
    if (!this.dbOpen.has(p.id)) return;
    if (conn) this.stop(conn, p, undefined, Loot.EndResult.InstigatorLivingStateChange); else this.dbOpen.delete(p.id);
  }
  forgetPlayer(id: string) { this.dbOpen.delete(id); this.dbClosed.delete(id); this.walletSent.delete(id); }
}
