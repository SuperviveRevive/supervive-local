// In-match Armory purchases (the ALL ITEMS / armory cards of the in-match shop) and the match gold purse rules for FFA / Breach.
//
// Evidence (retail capture; fixtures the capture decoder (not shipped) -> capture fixtures (not shipped); gate tools/check-armory.ts):
//   * Comp_PlayerController_Armory (bound 11 = UActorComponent's 2 net props + native LokiPlayerControllerArmoryComponentBase's 3 +
//     the Angelscript level's 2 props and 3 server functions sorted by name: 7 ServerBuyItem(FArmoryShopItem), 8
//     ServerSellSlotAndBuyItem(Item, UClass* SlotClass, int32 SlotIndex), 9 ServerSwapSlotAndBuyKit(Item, SlotClass, SlotIndex)).
//     Indices from the FClassNetCache mirror (the reference notes) and confirmed by both retail buys in FFA
//     flow 7547: field 7 decodes to exactly its 1767 / 1927 bits.
//   * FArmoryShopItem as an RPC parameter: [send bit] then every member, in retail's offset order: ItemClass (object ref), ItemType
//     (EArmoryShopItemType, 3 bits: 1 Power / 2 Equipment / 3 Boot), StarCount int32, Price int32, KitID FString, AssetId
//     (PrimaryAssetType FName + PrimaryAssetName FName, UPackageMap FName form), bPrototype bit. Retail: LastStand 1000 gold,
//     Gauntlets_02 500 gold, StarCount 1, ItemType 2, AssetId Equipment:<DA name>.
//   * Right after each buy the client sends Comp_PlayerController_Shop_Skylands field 11 TryHandleBought(AActor* Target) (9 bits:
//     send + one NetGUID). Handled in interact.ts (logged only; retail sends nothing back for it that we could isolate).
//   * Retail's answer (both buys): NO reply RPC. Within 50 ms: the owner PlayerState's h75 WalletStorage (gold falls by Price, h76
//     GoldSpentValue NOT sent - ConsumeWalletCurrency(bIsPurchase=false), reference LokiArmory.h:6-9), the new item actor's channel open
//     (BP_ITEM_* dynamic actor, 280-304 bits), the carrier's PlayerInventory fast array (65 bits), its ASC (granted GEs, 1840-2173 bits)
//     and, for Gauntlets_02, the carrier AttributeSetHealth (Health/MaxHealth up). All kept in the fixture file's "grant" rows.
//   * Purse (FFA warm-up flows 7027 + 7547): owner wallet 2500 ~10 s after join, then +750 steps (kills; 8 of 8 steps exactly 750,
//     plus two +25 pickups). Breach flow 7038 starts at 0. Breach hero kill gold = floor(600 + 600*(Level-1)/14) (reference
//     LokiPlayerCards.h:222, "34 of 34 kills in flows 7039/7038").
//
// NOT evidence (ours): we cannot grant the item on the wire yet (no item actor / PlayerInventory / GE wire), so a buy charges the
// purse and credits a sim-side effect instead: max-HP + heal scaled by the price (LOKI_ARMORY_HP_PER_GOLD), echoing retail's grips
// raising MaxHealth. Duplicate buys of the same AssetId are refused for the rest of the match (the client re-sends when no item shows up; the HP bonus
// outlives death). The
// FFA +750 is attributed to kills (the steps line up with the kill feed's cadence but were not cross-checked kill by kill).
// UNVERIFIED IN-CLIENT: all of it.
import { BitReader, BitWriter } from "./bits.ts";
import type { GuidExport } from "./protocol.ts";
import * as Gas from "./gas.ts";
import * as Loot from "./loot.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
export const ARMORY_ENABLED = env("LOKI_ARMORY", "1") !== "0";
export const ARMORY_MAX_PRICE = Number(env("LOKI_ARMORY_MAX_PRICE", "10000"));
export const ARMORY_HP_PER_GOLD = Number(env("LOKI_ARMORY_HP_PER_GOLD", "0.15"));
export const ARMORY_EXPORT_COMP = env("LOKI_ARMORY_EXPORT", "1") !== "0";
export const PURSE_ENABLED = env("LOKI_PURSE", "1") !== "0";
export const FFA_START_GOLD = Number(env("LOKI_FFA_START_GOLD", "2500"));
export const FFA_KILL_GOLD = Number(env("LOKI_FFA_KILL_GOLD", "750"));
export const BREACH_KILL_GOLD = env("LOKI_BREACH_KILL_GOLD", "1") !== "0";
export const BREACH_KILL_LEVEL = Number(env("LOKI_BREACH_KILL_LEVEL", "1"));

// ------------------------------------------------------------------ GUIDs (0xA8000-0xA87ff; disjoint from AGENTS.md's map)
/** Per player Comp_PlayerController_Armory (dynamic/even, outer = PC), like interact.ts's shop component. */
export const armoryCompGuid = (ord: number) => 0xa8000n + BigInt(ord) * 4n;

// ------------------------------------------------------------------ wire
export const ARMORY = { name: "Comp_PlayerController_Armory", bound: 11, ServerBuyItem: 7, ServerSellSlotAndBuyItem: 8,
  ServerSwapSlotAndBuyKit: 9 } as const;
export const ITEM_TYPE = { None: 0, Power: 1, Equipment: 2, Boot: 3 } as const;
export type NetName = { hardcoded: number } | { name: string; number?: number };
export function writeNetName(w: BitWriter, n: NetName) {
  if ("hardcoded" in n) { w.bit(true); w.packed32(n.hardcoded); } else { w.bit(false); w.fstring(n.name); w.int32(n.number ?? 0); }
}
export function readNetName(r: BitReader): NetName {
  if (r.bit()) return { hardcoded: r.packed32() };
  const name = r.fstring(), number = r.int32();
  return number ? { name, number } : { name };
}
export const nameText = (n: NetName) => ("hardcoded" in n ? `#${n.hardcoded}` : n.name);

export interface ArmoryShopItem {
  itemClass: Loot.ObjRef | null; itemType: number; starCount: number; price: number; kitId: string;
  assetType: NetName; assetName: NetName; prototype: boolean;
}
export function writeArmoryItem(w: BitWriter, it: ArmoryShopItem) {
  const cls = it.itemClass ?? { guid: 0n };
  Loot.writeObjRef(w, cls); Gas.writeBitsN(w, it.itemType, 3); w.int32(it.starCount); w.int32(it.price); w.fstring(it.kitId);
  writeNetName(w, it.assetType); writeNetName(w, it.assetName); w.bit(it.prototype);
}
export function readArmoryItem(r: BitReader): ArmoryShopItem {
  const ref = Loot.readObjRef(r);
  return { itemClass: ref.guid === 0n ? null : ref, itemType: Gas.readBitsN(r, 3), starCount: r.int32(), price: r.int32(), kitId: r.fstring(),
    assetType: readNetName(r), assetName: readNetName(r), prototype: r.bit() };
}
export interface ArmoryRpc { item: ArmoryShopItem | null; slotClass?: Loot.ObjRef | null; slotIndex?: number }
/** ServerBuyItem (7): [send][FArmoryShopItem]. Sell / Swap (8 / 9) add [send][UClass ref] and [send][int32 SlotIndex]. */
export function decodeArmoryRpc(buf: Uint8Array, bits: number, withSlot: boolean): ArmoryRpc & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const out: ArmoryRpc = { item: r.bit() ? readArmoryItem(r) : null };
  if (withSlot) { out.slotClass = r.bit() ? Loot.readObjRef(r) : null; out.slotIndex = r.bit() ? r.int32() : 0; }
  return { ...out, bitsRead: r.pos };
}
export function encodeArmoryRpc(a: ArmoryRpc, withSlot: boolean): BitWriter {
  const w = new BitWriter(2400);
  w.bit(!!a.item); if (a.item) writeArmoryItem(w, a.item);
  if (withSlot) {
    const sc = a.slotClass && a.slotClass.guid !== 0n ? a.slotClass : null;
    w.bit(!!sc); if (sc) Loot.writeObjRef(w, sc);
    w.bit(!!a.slotIndex); if (a.slotIndex) w.int32(a.slotIndex);
  }
  return w;
}
/** Leaf name of an item class reference ("BP_ITEM_..._C"), inline or by GUID (the caller's table). */
export const classText = (o: Loot.ObjRef | null | undefined) => (o ? (o.guid === 1n ? o.path ?? "?" : `0x${o.guid.toString(16)}`) : "null");

/** Breach hero kill gold (cross-checked against retail traffic): floor(600 + 600*(Level-1)/14), Level clamped 1..15. */
export const breachKillGold = (level: number) => Math.floor(600 + (600 * (Math.min(15, Math.max(1, level)) - 1)) / 14);

// ------------------------------------------------------------------ the manager
export interface ArPlayer extends Loot.LootPlayer { team: number; isBot?: boolean }
export interface ArHost<C extends Loot.LootConn> {
  log(msg: string): void;
  sendBunch(conn: C, body: (w: BitWriter) => void, opts: Loot.SendOpts): void;
  ord(p: ArPlayer): number;
  /** "ffa" | "breach" | other mode key (server.ts modeProfile key; null profile on Breach = "breach"). */
  mode(): string;
  player(id: string): ArPlayer | undefined;
  connOf(p: ArPlayer): C | undefined;
  gold(p: ArPlayer): number;
  spendGold(p: ArPlayer, amount: number): number | null;
  grantGold(p: ArPlayer, amount: number): number;
  /** Sim-side effect of an armory item: raise max HP by `hp` and heal by it; returns a log string. */
  boost(p: ArPlayer, hp: number): string;
  /** Push the PlayerState wallet (h75) to the owner now. */
  syncWallet(conn: C, p: ArPlayer): void;
}

export class ArmoryManager<C extends Loot.LootConn> {
  private owned = new Map<string, Set<string>>();
  private startGold = new Set<string>();
  stats = { buys: 0, refused: 0, goldSpent: 0, killGold: 0 };
  constructor(private host: ArHost<C>) {}
  reset() { this.owned.clear(); this.startGold.clear(); }
  status() { return { ...this.stats }; }

  /** Owner joined (Breach-island maps): export its armory component; FFA purse = retail's 2500 start. */
  onJoin(conn: C, p: ArPlayer) {
    if (ARMORY_ENABLED && ARMORY_EXPORT_COMP) {
      const g = armoryCompGuid(this.host.ord(p));
      if (!conn.exportedGuids.has(g)) {
        conn.exportedGuids.add(g);
        const ex: GuidExport[] = [{ guid: g, path: ARMORY.name, outer: p.pcGuid, noLoad: true }];
        this.host.sendBunch(conn, () => {}, { ch: p.channel, reliable: true, exports: ex });
      }
    }
    if (PURSE_ENABLED && this.host.mode() === "ffa" && FFA_START_GOLD > 0 && !this.startGold.has(p.id)) {
      this.startGold.add(p.id);
      this.host.log(`[armory] ${p.id} FFA start purse +${FFA_START_GOLD} = ${this.host.grantGold(p, FFA_START_GOLD)}`);
    }
  }

  /** Sim kill: the killer's purse (FFA 750 flat, Breach the level formula). The sim bonus outlives death (match.ts grantMaxHp), so
   *  the owned set does too: an item is bought once per match. */
  onKill(killerId: string, victimId: string) {
    if (!PURSE_ENABLED || !killerId || killerId === victimId) return;
    const k = this.host.player(killerId);
    if (!k) return;
    const mode = this.host.mode();
    const amount = mode === "ffa" ? FFA_KILL_GOLD : mode === "breach" && BREACH_KILL_GOLD ? breachKillGold(BREACH_KILL_LEVEL) : 0;
    if (amount <= 0) return;
    this.stats.killGold += amount;
    const total = this.host.grantGold(k, amount);
    if (!k.isBot) this.host.log(`[armory] kill gold ${killerId} +${amount} = ${total} (${mode})`);
  }

  private isArmoryComp(p: ArPlayer, o: Loot.ObjRef | undefined) {
    if (!o) return false;
    if (o.guid === armoryCompGuid(this.host.ord(p))) return true;
    return o.guid === 1n && (o.path === ARMORY.name || /Armory/.test(o.path ?? ""));
  }
  /** Pull this player's Armory RPC blocks out of a PC bunch; null when there were none, else the rest re-encoded. */
  onPcBunch(conn: C, p: ArPlayer, data: Uint8Array, bits: number): { data: Uint8Array; bits: number } | null {
    if (!ARMORY_ENABLED) return null;
    const blocks = Loot.parseClientBlocks(data, bits);
    if (!blocks || !blocks.some((b) => !b.isActor && this.isArmoryComp(p, b.obj))) return null;
    const rest = new BitWriter(bits + 64);
    for (const b of blocks) {
      if (b.isActor || !this.isArmoryComp(p, b.obj)) { Loot.writeClientBlock(rest, b); continue; }
      const fr = new BitReader(b.data, b.bits);
      while (fr.bitsLeft > 0) {
        const idx = fr.serializeIntVar(ARMORY.bound), n = fr.packed32();
        if (n > fr.bitsLeft) { this.host.log(`[armory] rpc ${idx} overflow`); break; }
        const f = fr.bitsFrom(n);
        try {
          if (idx === ARMORY.ServerBuyItem) this.buy(conn, p, decodeArmoryRpc(f, n, false), "buy");
          else if (idx === ARMORY.ServerSellSlotAndBuyItem || idx === ARMORY.ServerSwapSlotAndBuyKit)
            this.buy(conn, p, decodeArmoryRpc(f, n, true), idx === ARMORY.ServerSwapSlotAndBuyKit ? "swap" : "sell");
          else this.host.log(`[armory] rpc idx=${idx} bits=${n} from ${p.id} (not handled)`);
        } catch (e) { this.host.log(`[armory] rpc ${idx} failed: ${e instanceof Error ? e.message : e}`); }
      }
    }
    return { data: rest.buffer(), bits: rest.bits };
  }

  /** Retail AuthBuyItem order (cross-checked against retail traffic): player, can-buy, price vs wallet -> charge (wallet only). */
  buy(conn: C, p: ArPlayer, a: ArmoryRpc, how: string) {
    const refuse = (why: string) => { this.stats.refused++; this.host.log(`[armory] ${how} refused ${p.id}: ${why}`); };
    const it = a.item;
    if (!it) return refuse("no item");
    const asset = `${nameText(it.assetType)}:${nameText(it.assetName)}`;
    const label = `${asset} (${classText(it.itemClass)}${how !== "buy" ? `, slot ${classText(a.slotClass)}#${a.slotIndex}` : ""})`;
    if (!p.alive) return refuse(`${label}: dead`);
    if (!(it.price > 0 && it.price <= ARMORY_MAX_PRICE)) return refuse(`${label}: price ${it.price}`);
    if (!it.itemClass) return refuse(`${label}: no item class`);
    const own = this.owned.get(p.id) ?? new Set<string>();
    if (own.has(asset)) return refuse(`${label}: already bought this match (no item wire yet)`);
    const left = this.host.spendGold(p, it.price);
    if (left === null) return refuse(`${label} costs ${it.price}, purse ${this.host.gold(p)}`);
    own.add(asset); this.owned.set(p.id, own);
    this.stats.buys++; this.stats.goldSpent += it.price;
    const got = this.host.boost(p, Math.round(it.price * ARMORY_HP_PER_GOLD));
    this.host.syncWallet(conn, p);
    this.host.log(`[armory] ${p.id} ${how} ${label} star ${it.starCount} for ${it.price} -> purse ${left}, ${got} (item not granted on the wire)`);
  }
}
