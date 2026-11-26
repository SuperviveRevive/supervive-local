/**
 * gas.ts — SUPERVIVE 2.0.4 Gameplay Ability System + damage/kill-feed wire codecs for the clean-room server.
 * Pure functions only (no server state). Every encoder returns the *parameter payload* (what follows the field header);
 * `field()` adds the header (SerializeInt(index, bound) variable width + SerializeIntPacked(bits)).
 *
 * NOTES — what is measured and what is not. These codecs were checked bit-for-bit against recorded retail payloads
 * (20,201 distinct payloads); the recordings and that gate are not part of this repository.
 * ---------------------------------------------------------------------------------------------------------------------------
 * Fixture sources:
 *   F  retail-derived fixtures: Tests/LokiRpcConformanceFixtures.inl
 *      (2531 C->S ASC payloads + independent python reference decode), Tests/LokiDamageRpcFixtures.inl (3),
 *      Tests/LokiKitDamageRpcFixtures.inl (5), Tests/LokiKillFeedFixtures.inl (7), LokiRpcGate.cpp boot self-check rows (6).
 *   R  our own extraction from recorded retail match traffic*.tsv (recorded retail traffic, release2.4.live-156430-shipping) by
 *      the capture decoder (not shipped) -> capture fixtures (not shipped) (S->C local-ASC field-loop entries, PC fields 116/117, GS 61).
 * A PASS = decoder consumes exactly the payload, decoded values equal the fixture's reference columns where it has them, and the
 * encoder reproduces the payload BIT-IDENTICALLY. Measured (distinct payloads, full run):
 *   C->S  36 ServerCancelAbility 76/76, 40 ServerEndAbility 37/37, 46 ServerSetReplicatedEvent 466/466,
 *         50 ServerTryActivateAbility 691/691 (+1 self-check), 57 ServerSetBufferedSpell 97/97,
 *         58 ServerSetDerivedPredictionKeys 435/435.
 *         51 ServerTryActivateAbilityWithEventData 49/49 (+5) and 48 ServerSetReplicatedTargetData 680/680 are PREFIX-ONLY: handle,
 *         InputPressed, key (48: OrigKey + target-data handle header [send][UniqueId u8][DataNum u8][first struct index u8]).
 *         The FGameplayEventData / Loki target-data structs behind them are NOT decoded and NOT re-encoded.
 *   S->C  17 ClientActivateAbilityFailed 16/16, 18 ClientActivateAbilitySucceed 694/694, 20 ClientCancelAbility 199/199,
 *         21 ClientEndAbility 556/556, 53 ClientBroadcastPreInterruptSpell 5/5, 54 ClientClearBufferedSpell 19/19,
 *         55 ClientStartBufferedSpell 19/19, 8 ActivatableAbilities 389/389 (+ grantSpecsDelta() = each flow's first grant 5/5),
 *         15 ReplicatedPredictionKeyMap 5844/5844 (+ ackPredictionKeys() rule 5844/5844),
 *         19 ClientActivateAbilitySucceedWithEventData ONLY as encodeSucceedWithEventDataEcho(51): 49/49 retail 19s equal the
 *         paired F 51 minus its InputPressed bit. No free-standing FGameplayEventData encoder.
 *         PC 116 ClientNotifyDamageDealt 3051/3051 + F 3, PC 117 ClientNotifyDamageTaken 479/479 + F 5,
 *         GS 61 MulticastPlayerKilled 476/476 + F 7 (FText histories None and Base — the only two retail used).
 * Not measured (no retail payload exists): 44/45 ServerSetInputPressed/Released (stock [1][Handle int32] assumed),
 *   56 ServerSendReactivationEvent (not implemented), encodeSelectorSubSpellHandles (selector instance h1, [I]), the content-block
 *   header in writeAscRpcBlock (= server.ts writeStableBlock; no retail ASC block is re-encoded header-for-header),
 *   field 10 ActiveGameplayEffects (not implemented; the gecommon.py documents its handle table), damage RPCs with a GE
 *   context HitResult (decoder throws; none in retail), non-null equipment snapshot classes (encoded, but every retail row was null).
 * Retail facts the codecs encode: an object parameter of 53 is sent with presence bit 1 even when null; the 17 key is a bare int16
 *   scalar; acked prediction keys are written as issued (client key with Base, SI 0; server key SI 1); kill-feed Base-history
 *   namespace is an allocated empty FString ([int32 1]["\0"]).
 * Header bounds: ASC GetMaxIndex 59 -> 60, LokiPlayerController 161 -> 162, GameState 62 -> 63 (LokiKillFeed
 *   RetailFieldMax; for index 61 bounds 62 and 63 give the same 6 bits and every retail GS block parses under both, so the capture
 *   cannot separate them — 63 is used).
 * Grant tables (tables/hero-kits.ts): Ronin = rows flown in tests; retailFireFoxGrants() = the FireFox grant measured from match
 *   traffic (34 specs incl. shared passives); other hunters = rows generated from the game's cooked hero assets, unverified on the wire.
 */
import { BitReader, BitWriter } from "./bits.ts";
import KITS from "./tables/hero-kits.ts";

export type Guid = number | bigint;
const big = (g: Guid) => BigInt(g);

// ------------------------------------------------------------------ field indices / bounds
export const ASC_BOUND = 60;
export const PC_BOUND = 162;
export const GS_BOUND = 63;
export const ASC = {
  ActivatableAbilities: 8, ActiveGameplayEffects: 10, ReplicatedPredictionKeyMap: 15,
  ClientActivateAbilityFailed: 17, ClientActivateAbilitySucceed: 18, ClientActivateAbilitySucceedWithEventData: 19,
  ClientCancelAbility: 20, ClientEndAbility: 21, ClientTryActivateAbility: 24,
  ServerAbilityRPCBatch: 35, ServerCancelAbility: 36, ServerEndAbility: 40,
  ServerSetInputPressed: 44, ServerSetInputReleased: 45, ServerSetReplicatedEvent: 46, ServerSetReplicatedEventWithPayload: 47,
  ServerSetReplicatedTargetData: 48, ServerTryActivateAbility: 50, ServerTryActivateAbilityWithEventData: 51,
  ClientActivateCorrectedAbility: 52, ClientBroadcastPreInterruptSpell: 53, ClientClearBufferedSpell: 54, ClientStartBufferedSpell: 55,
  ServerSendReactivationEvent: 56, ServerSetBufferedSpell: 57, ServerSetDerivedPredictionKeys: 58,
} as const;
export const PC = { ClientNotifyDamageDealt: 116, ClientNotifyDamageTaken: 117 } as const;
export const GS = { MulticastPlayerKilled: 61 } as const;

// ------------------------------------------------------------------ bit primitives
export function writeBitsN(w: BitWriter, value: number, n: number) {
  for (let i = 0; i < n; i++) w.bit(((value >>> i) & 1) !== 0);
}
export function readBitsN(r: BitReader, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) if (r.bit()) v |= 1 << i;
  return v >>> 0;
}
const readI16 = (r: BitReader) => { const v = readBitsN(r, 16); return v & 0x8000 ? v - 0x10000 : v; };
const readU16 = (r: BitReader) => readBitsN(r, 16);
const guidOut = (r: BitReader): number => Number(r.packed64());

/** Copy `bits` bits of `src` (LSB-first) starting at bit `from` into `w`. */
export function copyBits(w: BitWriter, src: Uint8Array, from: number, bits: number) {
  for (let i = 0; i < bits; i++) { const p = from + i; w.bit(((src[p >> 3]! >> (p & 7)) & 1) !== 0); }
}

/** Field header + payload: SerializeInt(index, bound) (variable width) + SerializeIntPacked(bits) + payload. */
export function field(index: number, bound: number, payload: BitWriter): BitWriter {
  const w = new BitWriter(64 + payload.bits);
  w.serializeIntVar(index, bound);
  w.packed32(payload.bits);
  if (payload.bits) w.bitsFrom(payload.buffer(), payload.bits);
  return w;
}
export const ascField = (index: number, payload: BitWriter) => field(index, ASC_BOUND, payload);
export const pcField = (index: number, payload: BitWriter) => field(index, PC_BOUND, payload);
export const gsField = (index: number, payload: BitWriter) => field(index, GS_BOUND, payload);

/** Split a field loop (RPC/custom-delta fields after any RepLayout block). */
export function readFieldLoop(buf: Uint8Array, bits: number, bound: number, from = 0) {
  const r = new BitReader(buf, bits); r.skip(from);
  const out: { index: number; bits: number; start: number }[] = [];
  while (r.pos < bits) {
    const index = r.serializeIntVar(bound);
    const n = r.packed32();
    if (r.pos + n > bits) throw new Error("field overruns block");
    out.push({ index, bits: n, start: r.pos });
    r.skip(n);
  }
  return out;
}

/**
 * ASC stable-subobject content block on the carrier (PlayerState_HeroAffiliated) actor channel:
 * [bHasRepLayout][bIsActor 0][NetGUID][bStablyNamed 1][retail extra bit 0][packed payload bits][payload].
 * Same header as server.ts writeStableBlock. Not re-encoded against a retail block header (see NOTES).
 */
export function writeAscRpcBlock(w: BitWriter, ascGuid: Guid, fields: BitWriter[]) {
  const payload = new BitWriter(256);
  for (const f of fields) payload.bitsFrom(f.buffer(), f.bits);
  w.bit(false); w.bit(false); w.packed64(big(ascGuid)); w.bit(true); w.bit(false);
  w.packed32(payload.bits);
  if (payload.bits) w.bitsFrom(payload.buffer(), payload.bits);
}

// ------------------------------------------------------------------ GAS value types
/** Retail FPredictionKey: [Valid][HasBase if Valid][ServerInitiated][Current int16 if Valid][Base int16 if HasBase] = 2/19/35 bits. */
export interface PredictionKey { current: number; base?: number; serverInitiated?: boolean }
export function writePredictionKey(w: BitWriter, k: PredictionKey) {
  const valid = k.current !== 0;
  const hasBase = valid && !!k.base;
  w.bit(valid);
  if (valid) w.bit(hasBase);
  w.bit(!!k.serverInitiated);
  if (valid) w.int16(k.current);
  if (hasBase) w.int16(k.base!);
}
export function readPredictionKey(r: BitReader): PredictionKey {
  const valid = r.bit();
  const hasBase = valid ? r.bit() : false;
  const si = r.bit();
  const k: PredictionKey = { current: valid ? readI16(r) : 0 };
  if (hasBase) k.base = readI16(r);
  if (si) k.serverInitiated = true;
  return k;
}

export const ActivationMode = { Authority: 0, NonAuthority: 1, Predicting: 2, Confirmed: 3, Rejected: 4 } as const;
/** Retail FGameplayAbilityActivationInfo: mode (3 bits), four fork bools, PredictionKeyWhenActivated = 26 / 42 bits. */
export interface ActivationInfo {
  mode: number; endedByOther?: boolean; serverBuffered?: boolean; ignoreCosts?: boolean; ignoreCooldown?: boolean; key: PredictionKey;
}
export function writeActivationInfo(w: BitWriter, a: ActivationInfo) {
  writeBitsN(w, a.mode, 3);
  w.bit(!!a.endedByOther); w.bit(!!a.serverBuffered); w.bit(!!a.ignoreCosts); w.bit(!!a.ignoreCooldown);
  writePredictionKey(w, a.key);
}
export function readActivationInfo(r: BitReader): ActivationInfo {
  const mode = readBitsN(r, 3);
  const endedByOther = r.bit(), serverBuffered = r.bit(), ignoreCosts = r.bit(), ignoreCooldown = r.bit();
  return { mode, endedByOther, serverBuffered, ignoreCosts, ignoreCooldown, key: readPredictionKey(r) };
}

/** FLokiBufferedSpellData: Handle int32, SwapperIndex int32, BufferTime float, PredictionKey (116 bits with its send bit). */
export interface BufferedSpellData { handle: number; swapperIndex: number; bufferTime: number; key: PredictionKey }
function writeBuffered(w: BitWriter, d: BufferedSpellData) { w.int32(d.handle); w.int32(d.swapperIndex); w.float(d.bufferTime); writePredictionKey(w, d.key); }
function readBuffered(r: BitReader): BufferedSpellData {
  return { handle: r.int32(), swapperIndex: r.int32(), bufferTime: r.float(), key: readPredictionKey(r) };
}

export const ReplicatedEvent = {
  GenericConfirm: 0, GenericCancel: 1, InputPressed: 2, InputReleased: 3, GenericSignalFromClient: 4, GenericSignalFromServer: 5,
  GameCustom1: 6, GameCustom2: 7, GameCustom3: 8, GameCustom4: 9, GameCustom5: 10, GameCustom6: 11,
} as const;

// ------------------------------------------------------------------ RPC parameter framing (FRepLayout::SendPropertiesForRPC)
// Per parent parameter: a bool is just its value bit; anything else gets a send bit = !Identical(param, zero). A struct parameter
// is never identical to null, so its bit is always 1; a scalar/enum/object equal to zero is sent as a lone 0 bit.
const sendStruct = (w: BitWriter, body: () => void) => { w.bit(true); body(); };
const sendScalar = (w: BitWriter, isZero: boolean, body: () => void) => { w.bit(!isZero); if (!isZero) body(); };
function readOpt<T>(r: BitReader, body: () => T): T | null { return r.bit() ? body() : null; }

// ---- S->C replies
/** 18 ClientActivateAbilitySucceed(Handle, PredictionKey): 53 bits (69 with a based key). */
export function encodeClientActivateAbilitySucceed(handle: number, key: PredictionKey) {
  const w = new BitWriter(80); sendStruct(w, () => w.int32(handle)); sendStruct(w, () => writePredictionKey(w, key)); return w;
}
/** 17 ClientActivateAbilityFailed(Handle, int16 PredictionKey): 50 bits (a zero key is a lone 0 bit). */
export function encodeClientActivateAbilityFailed(handle: number, keyCurrent: number) {
  const w = new BitWriter(64); sendStruct(w, () => w.int32(handle)); sendScalar(w, keyCurrent === 0, () => w.int16(keyCurrent)); return w;
}
/** 20 ClientCancelAbility / 21 ClientEndAbility(Handle, ActivationInfo): 60 bits (76 with a based key). */
export function encodeClientEndAbility(handle: number, info: ActivationInfo) {
  const w = new BitWriter(96); sendStruct(w, () => w.int32(handle)); sendStruct(w, () => writeActivationInfo(w, info)); return w;
}
export const encodeClientCancelAbility = encodeClientEndAbility;
/** 54 ClientClearBufferedSpell(Handle): 33 bits. */
export function encodeClientClearBufferedSpell(handle: number) { const w = new BitWriter(40); sendStruct(w, () => w.int32(handle)); return w; }
/** 55 ClientStartBufferedSpell(FLokiBufferedSpellData): 116 bits. */
export function encodeClientStartBufferedSpell(d: BufferedSpellData) { const w = new BitWriter(128); sendStruct(w, () => writeBuffered(w, d)); return w; }
/** 53 ClientBroadcastPreInterruptSpell(Spell). Retail sends the presence bit as 1 even for a null spell ([1][packed 0] = 9 bits,
 *  62/62 retail calls), so it is written like a struct parameter. */
export function encodeClientBroadcastPreInterruptSpell(spell: Guid) {
  const w = new BitWriter(32); sendStruct(w, () => w.packed64(big(spell))); return w;
}
/**
 * 19 ClientActivateAbilitySucceedWithEventData(Handle, PredictionKey, FGameplayEventData) as the echo of a client 51
 * ServerTryActivateAbilityWithEventData(Handle, bool InputPressed, PredictionKey, FGameplayEventData): the same bits with the
 * InputPressed bit (bit 33) removed. The event data itself is opaque here.
 */
export function encodeSucceedWithEventDataEcho(payload51: Uint8Array, bits51: number) {
  const w = new BitWriter(bits51);
  copyBits(w, payload51, 0, 33);
  copyBits(w, payload51, 34, bits51 - 34);
  return w;
}

// ---- C->S decoders (and encoders, for bots / tests)
export interface TryActivate { handle: number; inputPressed: boolean; key: PredictionKey; prefixBits: number }
/** 50 ServerTryActivateAbility(Handle, bool InputPressed, PredictionKey); also the prefix of 51 (whose event data follows). */
export function decodeServerTryActivateAbility(buf: Uint8Array, bits: number): TryActivate {
  const r = new BitReader(buf, bits);
  const handle = readOpt(r, () => r.int32()) ?? 0;
  const inputPressed = r.bit();
  const key = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  return { handle, inputPressed, key, prefixBits: r.pos };
}
export function encodeServerTryActivateAbility(handle: number, inputPressed: boolean, key: PredictionKey) {
  const w = new BitWriter(80); sendStruct(w, () => w.int32(handle)); w.bit(inputPressed); sendStruct(w, () => writePredictionKey(w, key)); return w;
}
/** 51: prefix as 50, then the FGameplayEventData (not decoded: `eventDataBits` bits from `prefixBits`). */
export function decodeServerTryActivateAbilityWithEventData(buf: Uint8Array, bits: number) {
  const p = decodeServerTryActivateAbility(buf, bits);
  return { ...p, eventDataBits: bits - p.prefixBits };
}
/** 36 ServerCancelAbility(Handle, ActivationInfo). */
export function decodeServerCancelAbility(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  return { handle: readOpt(r, () => r.int32()) ?? 0, info: readOpt(r, () => readActivationInfo(r)), bitsRead: (r.pos) };
}
export function encodeServerCancelAbility(handle: number, info: ActivationInfo) { return encodeClientEndAbility(handle, info); }
/** 40 ServerEndAbility(Handle, ActivationInfo, PredictionKey). */
export function decodeServerEndAbility(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  const handle = readOpt(r, () => r.int32()) ?? 0;
  const info = readOpt(r, () => readActivationInfo(r));
  const key = readOpt(r, () => readPredictionKey(r));
  return { handle, info, key, bitsRead: r.pos };
}
export function encodeServerEndAbility(handle: number, info: ActivationInfo, key: PredictionKey) {
  const w = encodeClientEndAbility(handle, info); sendStruct(w, () => writePredictionKey(w, key)); return w;
}
/** 44 ServerSetInputPressed / 45 ServerSetInputReleased(Handle) — UNVERIFIED (no retail payload). */
export function decodeServerSetInput(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits); return { handle: readOpt(r, () => r.int32()) ?? 0, bitsRead: r.pos };
}
export function encodeServerSetInput(handle: number) { const w = new BitWriter(40); sendStruct(w, () => w.int32(handle)); return w; }
/** 46 ServerSetReplicatedEvent(EventType 4 bits, Handle, OriginalPredictionKey, CurrentPredictionKey). */
export interface ReplicatedEventRpc { event: number; handle: number; origKey: PredictionKey; curKey: PredictionKey }
export function decodeServerSetReplicatedEvent(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  const event = readOpt(r, () => readBitsN(r, 4)) ?? 0;
  const handle = readOpt(r, () => r.int32()) ?? 0;
  const origKey = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  const curKey = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  return { event, handle, origKey, curKey, bitsRead: r.pos };
}
export function encodeServerSetReplicatedEvent(e: ReplicatedEventRpc) {
  const w = new BitWriter(96);
  sendScalar(w, e.event === 0, () => writeBitsN(w, e.event, 4));
  sendStruct(w, () => w.int32(e.handle));
  sendStruct(w, () => writePredictionKey(w, e.origKey));
  sendStruct(w, () => writePredictionKey(w, e.curKey));
  return w;
}
/** 48 ServerSetReplicatedTargetData: prefix only (Handle, OriginalPredictionKey, target-data handle header). */
export function decodeServerSetReplicatedTargetDataPrefix(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  const handle = readOpt(r, () => r.int32()) ?? 0;
  const origKey = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  const prefixBits = r.pos;
  const tdSend = r.bit();
  const td = tdSend ? { uniqueId: r.uint8(), dataNum: r.uint8(), firstIndex: r.uint8() } : null;
  return { handle, origKey, prefixBits, tdSend, td, tailBits: bits - prefixBits };
}
/** 57 ServerSetBufferedSpell(FLokiBufferedSpellData). */
export function decodeServerSetBufferedSpell(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits); return { data: readOpt(r, () => readBuffered(r)), bitsRead: r.pos };
}
export function encodeServerSetBufferedSpell(d: BufferedSpellData) { return encodeClientStartBufferedSpell(d); }
/** 58 ServerSetDerivedPredictionKeys(Handle, InvokeKey, DashEndPredictionKey, EndKey). */
export interface DerivedKeys { handle: number; invoke: PredictionKey; dashEnd: PredictionKey; end: PredictionKey }
export function decodeServerSetDerivedPredictionKeys(buf: Uint8Array, bits: number) {
  const r = new BitReader(buf, bits);
  const handle = readOpt(r, () => r.int32()) ?? 0;
  const invoke = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  const dashEnd = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  const end = readOpt(r, () => readPredictionKey(r)) ?? { current: 0 };
  return { handle, invoke, dashEnd, end, bitsRead: r.pos };
}
export function encodeServerSetDerivedPredictionKeys(d: DerivedKeys) {
  const w = new BitWriter(160);
  sendStruct(w, () => w.int32(d.handle));
  for (const k of [d.invoke, d.dashEnd, d.end]) sendStruct(w, () => writePredictionKey(w, k));
  return w;
}

// ------------------------------------------------------------------ FastArray (NetDeltaSerialize) — fields 8 / 15
export interface FastArrayItem { id: number; write?: ((w: BitWriter) => void) | null }
export interface FastArrayDelta { fastDelta?: boolean; arrayKey: number; baseKey: number; deletes?: number[]; changed: FastArrayItem[] }
/** [bit][ArrayReplicationKey i32][BaseReplicationKey i32][NumDeletes i32][NumChanged i32][deleted ids u32...]
 *  then per changed item [ElementID u32][bHasData bit][handle stream ... packed 0]. */
export function writeFastArray(w: BitWriter, d: FastArrayDelta) {
  const dels = d.deletes ?? [];
  w.bit(d.fastDelta ?? true);
  w.int32(d.arrayKey); w.int32(d.baseKey); w.int32(dels.length); w.int32(d.changed.length);
  for (const id of dels) w.uint32(id);
  for (const it of d.changed) {
    w.uint32(it.id);
    if (!it.write) { w.bit(false); continue; }
    w.bit(true); it.write(w); w.packed32(0);
  }
}
export function readFastArrayHeader(r: BitReader) {
  const fastDelta = r.bit();
  const arrayKey = r.int32(), baseKey = r.int32(), nDel = r.int32(), nChg = r.int32();
  if (nDel < 0 || nDel > 4096 || nChg < 0 || nChg > 4096) throw new Error("fastarray counts");
  const deletes: number[] = []; for (let i = 0; i < nDel; i++) deletes.push(r.uint32());
  return { fastDelta, arrayKey, baseKey, deletes, nChg };
}

/** UPackageMapClient FName: hardcoded [1][packed index] or [0][FString][int32 number]. NAME_None = hardcoded 0. */
export type NetName = { hardcoded: number } | { name: string; number?: number };
function writeNetName(w: BitWriter, n: NetName) {
  if ("hardcoded" in n) { w.bit(true); w.packed32(n.hardcoded); } else { w.bit(false); w.fstring(n.name); w.int32(n.number ?? 0); }
}
function readNetName(r: BitReader): NetName {
  if (r.bit()) return { hardcoded: r.packed32() };
  const name = r.fstring(); const number = r.int32(); return number ? { name, number } : { name };
}

/**
 * FGameplayAbilitySpec as a FastArray item (declaration order, BackwardsCompatible handle stream):
 * 1 Handle, 2 Ability (CDO), 3 AbiltyName (fork FName), 4 Level, 5 InputID, 6 InputIDPriority, 7 SourceObject,
 * 8 ReplicatedInstances (uint16 num + [element handle = index+1][object] ... 0). Only the present fields are written, in handle
 * order — retail's initial grant sends 1..7 (+8 on the very first send / when instances exist), later deltas only what changed.
 */
export interface AbilitySpecItem {
  handle?: number; ability?: Guid; abilityName?: NetName; level?: number; inputId?: number; inputIdPriority?: number;
  sourceObject?: Guid; instances?: Guid[];
}
export function writeAbilitySpecItem(w: BitWriter, s: AbilitySpecItem) {
  if (s.handle !== undefined) { w.packed32(1); w.int32(s.handle); }
  if (s.ability !== undefined) { w.packed32(2); w.packed64(big(s.ability)); }
  if (s.abilityName !== undefined) { w.packed32(3); writeNetName(w, s.abilityName); }
  if (s.level !== undefined) { w.packed32(4); w.int32(s.level); }
  if (s.inputId !== undefined) { w.packed32(5); w.int32(s.inputId); }
  if (s.inputIdPriority !== undefined) { w.packed32(6); w.int32(s.inputIdPriority); }
  if (s.sourceObject !== undefined) { w.packed32(7); w.packed64(big(s.sourceObject)); }
  if (s.instances !== undefined) {
    w.packed32(8); w.uint16(s.instances.length);
    s.instances.forEach((g, i) => { w.packed32(i + 1); w.packed64(big(g)); });
    w.packed32(0);
  }
}
export function readAbilitySpecItem(r: BitReader): AbilitySpecItem {
  const s: AbilitySpecItem = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    switch (h) {
      case 1: s.handle = r.int32(); break;
      case 2: s.ability = guidOut(r); break;
      case 3: s.abilityName = readNetName(r); break;
      case 4: s.level = r.int32(); break;
      case 5: s.inputId = r.int32(); break;
      case 6: s.inputIdPriority = r.int32(); break;
      case 7: s.sourceObject = guidOut(r); break;
      case 8: {
        const n = readU16(r); const inst: Guid[] = new Array(n).fill(0);
        for (let e = r.packed32(); e; e = r.packed32()) inst[e - 1] = guidOut(r);
        s.instances = inst; break;
      }
      default: throw new Error(`ActivatableAbilities: unknown item handle ${h}`);
    }
  }
  return s;
}
export interface AbilitySpecsDelta { fastDelta?: boolean; arrayKey: number; baseKey: number; deletes?: number[]; items: { id: number; spec: AbilitySpecItem | null }[] }
/** ASC field 8 ActivatableAbilities payload (owner-only). */
export function encodeActivatableAbilities(d: AbilitySpecsDelta) {
  const w = new BitWriter(512);
  writeFastArray(w, { fastDelta: d.fastDelta, arrayKey: d.arrayKey, baseKey: d.baseKey, deletes: d.deletes,
    changed: d.items.map((it) => ({ id: it.id, write: it.spec ? (x: BitWriter) => writeAbilitySpecItem(x, it.spec!) : null })) });
  return w;
}
export function decodeActivatableAbilities(buf: Uint8Array, bits: number): AbilitySpecsDelta & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const h = readFastArrayHeader(r);
  const items: { id: number; spec: AbilitySpecItem | null }[] = [];
  for (let i = 0; i < h.nChg; i++) { const id = r.uint32(); items.push({ id, spec: r.bit() ? readAbilitySpecItem(r) : null }); }
  return { fastDelta: h.fastDelta, arrayKey: h.arrayKey, baseKey: h.baseKey, deletes: h.deletes, items, bitsRead: r.pos };
}
/** A fresh grant: one FastArray item per spec, ids 1..n, every field 1..7 plus 8 (retail's first send shape). */
export function grantSpecsDelta(specs: { handle: number; ability: Guid; level: number; inputId: number; sourceObject?: Guid; instances?: Guid[] }[], arrayKey = 1, baseKey = 0): AbilitySpecsDelta {
  return { arrayKey, baseKey, items: specs.map((s, i) => ({ id: i + 1, spec: {
    handle: s.handle, ability: s.ability, abilityName: { hardcoded: 0 }, level: s.level, inputId: s.inputId, inputIdPriority: 0,
    sourceObject: s.sourceObject ?? 0, instances: s.instances ?? [] } })) };
}

/** ASC field 15 ReplicatedPredictionKeyMap: FastArray of FReplicatedPredictionKeyItem (handle 1 = PredictionKey). */
export interface PredictionKeyMapDelta { fastDelta?: boolean; arrayKey: number; baseKey: number; deletes?: number[]; items: { id: number; key: PredictionKey | null }[] }
export function encodePredictionKeyMap(d: PredictionKeyMapDelta) {
  const w = new BitWriter(256);
  writeFastArray(w, { fastDelta: d.fastDelta, arrayKey: d.arrayKey, baseKey: d.baseKey, deletes: d.deletes,
    changed: d.items.map((it) => ({ id: it.id, write: it.key ? (x: BitWriter) => { x.packed32(1); writePredictionKey(x, it.key!); } : null })) });
  return w;
}
export function decodePredictionKeyMap(buf: Uint8Array, bits: number): PredictionKeyMapDelta & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const h = readFastArrayHeader(r);
  const items: { id: number; key: PredictionKey | null }[] = [];
  for (let i = 0; i < h.nChg; i++) {
    const id = r.uint32();
    if (!r.bit()) { items.push({ id, key: null }); continue; }
    let key: PredictionKey | null = null;
    for (let hh = r.packed32(); hh; hh = r.packed32()) { if (hh !== 1) throw new Error("pkmap handle"); key = readPredictionKey(r); }
    items.push({ id, key });
  }
  return { fastDelta: h.fastDelta, arrayKey: h.arrayKey, baseKey: h.baseKey, deletes: h.deletes, items, bitsRead: r.pos };
}
/** Ack prediction keys in the 32-slot ring (FReplicatedPredictionKeyMap::KeyRingBufferSize). Retail-measured over all 5844
 *  distinct retail field-15 payloads (check-gas): item id = (key.current % 32) + 1, items in ascending id order, and the key is
 *  written exactly as it was issued — a client key keeps its Base and SI 0 (pass the PredictionKey the client sent), a
 *  server-initiated key has SI 1 and no base (pass a bare number). ArrayReplicationKey advances by one per item marked dirty;
 *  BaseReplicationKey defaults to arrayKey - keys.length (retail's shape for consecutive acks). */
export function ackPredictionKeys(keys: (PredictionKey | number)[], arrayKey: number, baseKey = arrayKey - keys.length) {
  const items = keys.map((k) => typeof k === "number" ? { current: k, serverInitiated: true } as PredictionKey : k)
    .map((key) => ({ id: (key.current % 32) + 1, key })).sort((a, b) => a.id - b.id);
  return encodePredictionKeyMap({ arrayKey, baseKey, items });
}
export const ackPredictionKey = (key: PredictionKey | number, arrayKey: number, baseKey = arrayKey - 1) => ackPredictionKeys([key], arrayKey, baseKey);

/**
 * GS_*_LMB_Selector ability-instance property block (LokiSpellMirror: its only replicated property, h1 SubSpellHandles,
 * COND_InitialOnly, Ronin = [LA4, LA3, LA2, LA1] spec handles). [I] UNVERIFIED: no retail selector capture exists (all capture
 * flows are FireFox); layout = our RepLayout array convention (bDoChecksum 0, handle 1, uint16 count, element handle i+1 + int32,
 * packed 0, then packed 0 terminator) as used for GameFeatureToggles, which the real client accepts.
 */
export function encodeSelectorSubSpellHandles(handles: number[]) {
  const w = new BitWriter(64 + handles.length * 40);
  w.bit(false); w.packed32(1); w.uint16(handles.length);
  handles.forEach((h, i) => { w.packed32(i + 1); w.int32(h); });
  w.packed32(0); w.packed32(0);
  return w;
}

/** LokiSpellSwapper instance initial block (usmap: CurrentSpell, CurrentSpellRawHandle, SubSpellHandles = h1/h2/h3; the
 *  flown PLAN Q layout): index 0, its raw handle, then the sub handles in SubSpellClasses order. */
export function encodeSwapperInitial(handles: number[], current = 0) {
  const w = new BitWriter(128 + handles.length * 40);
  w.bit(false);
  w.packed32(1); w.int32(current);
  w.packed32(2); w.int32(handles[current] ?? -1);
  w.packed32(3); w.uint16(handles.length);
  handles.forEach((h, i) => { w.packed32(i + 1); w.int32(h); });
  w.packed32(0); w.packed32(0);
  return w;
}

/** LokiGameplaySpell instance: h1 CurrentCharges (retail 974/974 instance blocks: h1 CurrentCharges, h2 NextChargeGrantServerTime,
 *  h3/h4 ReplicatedPhaseData). A charges spell whose instance says 0 charges can never be cast. */
export function encodeSpellCharges(charges: number) {
  const w = new BitWriter(64);
  w.bit(false); w.packed32(1); w.int32(charges); w.packed32(0);
  return w;
}

// ------------------------------------------------------------------ gameplay tags / effect spec
/** FGameplayTag fast net index: 6-bit first segment + continuation bit, then 8 more bits (TrueBitNum 14). */
export function writeTagIndex(w: BitWriter, idx: number) {
  if (idx < 64) writeBitsN(w, idx, 7);
  else { writeBitsN(w, (idx & 63) | 64, 7); writeBitsN(w, idx >>> 6, 8); }
}
export function readTagIndex(r: BitReader) { const f = readBitsN(r, 7); return f & 64 ? (f & 63) | (readBitsN(r, 8) << 6) : f; }
/** FGameplayTagContainer::NetSerialize: [bIsEmpty][count 7 bits][indices]. */
export function writeTagContainer(w: BitWriter, tags: number[]) {
  w.bit(tags.length === 0);
  if (!tags.length) return;
  writeBitsN(w, tags.length, 7);
  for (const t of tags) writeTagIndex(w, t);
}
export function readTagContainer(r: BitReader) {
  if (r.bit()) return [] as number[];
  const n = readBitsN(r, 7); const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(readTagIndex(r));
  return out;
}

export interface EffectContext {
  instigator?: Guid; effectCauser?: Guid; abilityCDO?: Guid; sourceObject?: Guid; actors?: Guid[];
  worldOrigin?: [number, number, number];
}
/** FGameplayEffectContextHandle (retail: no script-struct byte): [valid][RepBits 7][objects by bit][Actors 6-bit count][origin 3 doubles]. */
export function writeEffectContext(w: BitWriter, c: EffectContext | null) {
  w.bit(!!c);
  if (!c) return;
  const nz = (g?: Guid) => g !== undefined && big(g) !== 0n;
  let rb = 0;
  if (nz(c.instigator)) rb |= 1; if (nz(c.effectCauser)) rb |= 2; if (nz(c.abilityCDO)) rb |= 4; if (nz(c.sourceObject)) rb |= 8;
  if (c.actors && c.actors.length) rb |= 16; if (c.worldOrigin) rb |= 64;
  writeBitsN(w, rb, 7);
  if (rb & 1) w.packed64(big(c.instigator!)); if (rb & 2) w.packed64(big(c.effectCauser!));
  if (rb & 4) w.packed64(big(c.abilityCDO!)); if (rb & 8) w.packed64(big(c.sourceObject!));
  if (rb & 16) { writeBitsN(w, c.actors!.length, 6); for (const a of c.actors!) w.packed64(big(a)); }
  if (rb & 64) for (const v of c.worldOrigin!) w.double(v);
}
export function readEffectContext(r: BitReader): EffectContext | null {
  if (!r.bit()) return null;
  const rb = readBitsN(r, 7); const c: EffectContext = {};
  if (rb & 1) c.instigator = guidOut(r); if (rb & 2) c.effectCauser = guidOut(r);
  if (rb & 4) c.abilityCDO = guidOut(r); if (rb & 8) c.sourceObject = guidOut(r);
  if (rb & 16) { const n = readBitsN(r, 6); c.actors = []; for (let i = 0; i < n; i++) c.actors.push(guidOut(r)); }
  if (rb & 32) throw new Error("GE context HitResult not supported");
  if (rb & 64) c.worldOrigin = [r.double(), r.double(), r.double()];
  return c;
}

/** FGameplayModifiedAttribute: FGameplayAttribute { FString AttributeName, TFieldPath Attribute, UStruct* AttributeOwner } + float. */
export interface ModifiedAttribute { name: string; owner: Guid; magnitude: number; pathNames?: NetName[]; pathOwner?: Guid }
function writeModAttr(w: BitWriter, m: ModifiedAttribute) {
  w.fstring(m.name);
  const path = m.pathNames ?? [{ name: m.name }];
  w.int32(path.length);
  for (const n of path) writeNetName(w, n);
  w.packed64(big(m.pathOwner ?? m.owner));
  w.packed64(big(m.owner));
  w.float(m.magnitude);
}
function readModAttr(r: BitReader): ModifiedAttribute {
  const name = r.fstring();
  const n = r.int32(); if (n < 0 || n > 16) throw new Error("FFieldPath length");
  const pathNames: NetName[] = []; for (let i = 0; i < n; i++) pathNames.push(readNetName(r));
  const pathOwner = guidOut(r); const owner = guidOut(r); const magnitude = r.float();
  const m: ModifiedAttribute = { name, owner, magnitude };
  const simple = n === 1 && "name" in pathNames[0]! && pathNames[0]!.name === name && !pathNames[0]!.number;
  if (!simple) m.pathNames = pathNames;
  if (pathOwner !== owner) m.pathOwner = pathOwner;
  return m;
}

/** FGameplayEffectSpec as an RPC parameter (retail fork member order). */
export interface EffectSpec {
  def: Guid; modifiedAttributes: ModifiedAttribute[]; suppressedModifiers?: number[]; bModifiersIgnoreStacks?: boolean;
  duration: number; period: number; chance: number; dynamicGrantedTags?: number[]; dynamicAssetTags?: number[];
  modifiers?: number[]; stackCount: number; grantedAbilitySpecs?: number[]; actorToSpawnClass?: Guid; context: EffectContext | null;
  level: number;
}
export function writeEffectSpec(w: BitWriter, s: EffectSpec) {
  w.packed64(big(s.def));
  w.uint16(s.modifiedAttributes.length); for (const m of s.modifiedAttributes) writeModAttr(w, m);
  const sup = s.suppressedModifiers ?? []; w.uint16(sup.length); for (const v of sup) w.int32(v);
  w.bit(!!s.bModifiersIgnoreStacks);
  w.float(s.duration); w.float(s.period); w.float(s.chance);
  writeTagContainer(w, s.dynamicGrantedTags ?? []); writeTagContainer(w, s.dynamicAssetTags ?? []);
  const mods = s.modifiers ?? []; w.uint16(mods.length); for (const v of mods) w.float(v);
  w.int32(s.stackCount);
  const gas = s.grantedAbilitySpecs ?? []; w.uint16(gas.length); for (const v of gas) w.int32(v);
  w.packed64(big(s.actorToSpawnClass ?? 0));
  writeEffectContext(w, s.context);
  w.float(s.level);
}
export function readEffectSpec(r: BitReader): EffectSpec {
  const def = guidOut(r);
  const nm = readU16(r); const modifiedAttributes: ModifiedAttribute[] = []; for (let i = 0; i < nm; i++) modifiedAttributes.push(readModAttr(r));
  const ns = readU16(r); const suppressedModifiers: number[] = []; for (let i = 0; i < ns; i++) suppressedModifiers.push(r.int32());
  const bModifiersIgnoreStacks = r.bit();
  const duration = r.float(), period = r.float(), chance = r.float();
  const dynamicGrantedTags = readTagContainer(r), dynamicAssetTags = readTagContainer(r);
  const nmod = readU16(r); const modifiers: number[] = []; for (let i = 0; i < nmod; i++) modifiers.push(r.float());
  const stackCount = r.int32();
  const ng = readU16(r); const grantedAbilitySpecs: number[] = []; for (let i = 0; i < ng; i++) grantedAbilitySpecs.push(r.int32());
  const actorToSpawnClass = guidOut(r);
  const context = readEffectContext(r);
  const level = r.float();
  return { def, modifiedAttributes, suppressedModifiers, bModifiersIgnoreStacks, duration, period, chance, dynamicGrantedTags,
    dynamicAssetTags, modifiers, stackCount, grantedAbilitySpecs, actorToSpawnClass, context, level };
}

// ------------------------------------------------------------------ damage notify RPCs (LokiPlayerController 116 / 117)
/** FLokiDamageStatistic (leaf order as retail sends it). Locations are LWC FVectors (3 doubles). */
export interface DamageStatistic {
  gameTime: number; bStartedKnocked?: boolean; bDownedTarget?: boolean; bKilledTarget?: boolean; bSkipDamageVFX?: boolean;
  totalDamage: number; shieldDamage: number; healthDamage: number; damageMitigatedByArmor: number;
  sourceClass: Guid; targetClass: Guid; sourceActor: Guid; targetActor: Guid; targetActorLocation: [number, number, number];
  sourceCharacter: Guid; sourceCharacterClass: Guid; sourceCharacterLocation: [number, number, number];
  sourcePlayer: Guid; targetPlayer: Guid; sourceEffectClass: Guid; sourceAbilityClass: Guid;
  /** Source equipment snapshot: 12 item classes + packed stars + packed tiers (all null/0 in every reference). */
  equipClasses?: Guid[]; packedStars?: number; packedTiers?: number;
}
function writeDamageStatistic(w: BitWriter, s: DamageStatistic) {
  w.float(s.gameTime);
  w.bit(!!s.bStartedKnocked); w.bit(!!s.bDownedTarget); w.bit(!!s.bKilledTarget); w.bit(!!s.bSkipDamageVFX);
  w.float(s.totalDamage); w.float(s.shieldDamage); w.float(s.healthDamage); w.float(s.damageMitigatedByArmor);
  for (const g of [s.sourceClass, s.targetClass, s.sourceActor, s.targetActor]) w.packed64(big(g));
  for (const v of s.targetActorLocation) w.double(v);
  w.packed64(big(s.sourceCharacter)); w.packed64(big(s.sourceCharacterClass));
  for (const v of s.sourceCharacterLocation) w.double(v);
  for (const g of [s.sourcePlayer, s.targetPlayer, s.sourceEffectClass, s.sourceAbilityClass]) w.packed64(big(g));
  const eq = s.equipClasses ?? []; for (let i = 0; i < 12; i++) w.packed64(big(eq[i] ?? 0));
  w.uint32(s.packedStars ?? 0); w.uint32(s.packedTiers ?? 0);
}
function readDamageStatistic(r: BitReader): DamageStatistic {
  const gameTime = r.float();
  const bStartedKnocked = r.bit(), bDownedTarget = r.bit(), bKilledTarget = r.bit(), bSkipDamageVFX = r.bit();
  const totalDamage = r.float(), shieldDamage = r.float(), healthDamage = r.float(), damageMitigatedByArmor = r.float();
  const sourceClass = guidOut(r), targetClass = guidOut(r), sourceActor = guidOut(r), targetActor = guidOut(r);
  const targetActorLocation: [number, number, number] = [r.double(), r.double(), r.double()];
  const sourceCharacter = guidOut(r), sourceCharacterClass = guidOut(r);
  const sourceCharacterLocation: [number, number, number] = [r.double(), r.double(), r.double()];
  const sourcePlayer = guidOut(r), targetPlayer = guidOut(r), sourceEffectClass = guidOut(r), sourceAbilityClass = guidOut(r);
  const equipClasses: Guid[] = []; for (let i = 0; i < 12; i++) equipClasses.push(guidOut(r));
  const packedStars = r.uint32(), packedTiers = r.uint32();
  return { gameTime, bStartedKnocked, bDownedTarget, bKilledTarget, bSkipDamageVFX, totalDamage, shieldDamage, healthDamage,
    damageMitigatedByArmor, sourceClass, targetClass, sourceActor, targetActor, targetActorLocation, sourceCharacter,
    sourceCharacterClass, sourceCharacterLocation, sourcePlayer, targetPlayer, sourceEffectClass, sourceAbilityClass, equipClasses,
    packedStars, packedTiers };
}
/** ClientNotifyDamageDealt(AActor* Victim, …) / ClientNotifyDamageTaken(ALokiCharacter* SourceCharacter, …). */
export interface DamageNotify { other: Guid; stat: DamageStatistic; spec: EffectSpec; executionTags: number[] }
export function encodeDamageNotify(d: DamageNotify) {
  const w = new BitWriter(2600);
  sendScalar(w, big(d.other) === 0n, () => w.packed64(big(d.other)));
  sendStruct(w, () => writeDamageStatistic(w, d.stat));
  sendStruct(w, () => writeEffectSpec(w, d.spec));
  sendStruct(w, () => writeTagContainer(w, d.executionTags));
  return w;
}
export const encodeClientNotifyDamageDealt = encodeDamageNotify;
export const encodeClientNotifyDamageTaken = encodeDamageNotify;
export function decodeDamageNotify(buf: Uint8Array, bits: number): DamageNotify & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  const other = readOpt(r, () => guidOut(r)) ?? 0;
  const stat = readOpt(r, () => readDamageStatistic(r));
  const spec = readOpt(r, () => readEffectSpec(r));
  const executionTags = readOpt(r, () => readTagContainer(r)) ?? [];
  if (!stat || !spec) throw new Error("damage notify: struct param not sent");
  return { other, stat, spec, executionTags, bitsRead: r.pos };
}

// ------------------------------------------------------------------ kill feed (GameState 61 MulticastPlayerKilled)
export const LivingState = { Dead: 0, Alive: 1, Knocked: 2 } as const;
/** FPlayerKillEventData. KillerName is FText: int32 Flags, int8 HistoryType, then for history -1 (None) a 4-byte bool
 *  bHasCultureInvariantString + FString (retail: 541/546), for history 0 (Base) FString Namespace, Key, SourceString (retail: the
 *  rest, e.g. a bot hero name). Other histories are not encoded. */
export interface KillerNameBase { namespace: string; key: string; source: string; /** UE writes an allocated empty FString as
 *  [int32 1]["\0"]; retail's Base-history namespace is that form, so it is the default for an empty namespace. */ emptyNamespaceAllocated?: boolean }
function writeFStringAlloc(w: BitWriter, s: string, allocatedIfEmpty: boolean) {
  if (!s && allocatedIfEmpty) { w.int32(1); w.uint8(0); } else w.fstring(s);
}
export interface PlayerKillEvent {
  killer: Guid; killerPlayerState: Guid; killerName: string; killerNameFlags?: number; killerNameBase?: KillerNameBase;
  assists: Guid[]; victimPlayerState: Guid;
  location: [number, number, number]; eventResult: number; bIsTeamWipe?: boolean; bIsAce?: boolean; bIsSpike?: boolean; bDiedToAbyss?: boolean;
}
export function encodeMulticastPlayerKilled(e: PlayerKillEvent) {
  const w = new BitWriter(512);
  sendStruct(w, () => {
    w.packed64(big(e.killer)); w.packed64(big(e.killerPlayerState));
    if (e.killerNameBase) {
      w.int32(e.killerNameFlags ?? 0); w.uint8(0); writeFStringAlloc(w, e.killerNameBase.namespace, e.killerNameBase.emptyNamespaceAllocated ?? true); w.fstring(e.killerNameBase.key); w.fstring(e.killerNameBase.source);
    } else { w.int32(e.killerNameFlags ?? 2); w.uint8(0xff); w.uint32(1); w.fstring(e.killerName); }
    w.uint16(e.assists.length); for (const a of e.assists) w.packed64(big(a));
    w.packed64(big(e.victimPlayerState));
    for (const v of e.location) w.double(v);
    writeBitsN(w, e.eventResult, 3);
    w.bit(!!e.bIsTeamWipe); w.bit(!!e.bIsAce); w.bit(!!e.bIsSpike); w.bit(!!e.bDiedToAbyss);
  });
  return w;
}
export function decodeMulticastPlayerKilled(buf: Uint8Array, bits: number): PlayerKillEvent & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  if (!r.bit()) throw new Error("kill event not sent");
  const killer = guidOut(r), killerPlayerState = guidOut(r);
  const killerNameFlags = r.int32(); const hist = r.uint8();
  let killerName = ""; let killerNameBase: KillerNameBase | undefined;
  if (hist === 0xff) {
    if (!r.uint32()) throw new Error("FText without culture-invariant string not supported");
    killerName = r.fstring();
  } else if (hist === 0) {
    const p0 = r.pos; const namespace = r.fstring(); const alloc = namespace === "" && r.pos - p0 > 32;
    killerNameBase = { namespace, key: r.fstring(), source: r.fstring(), emptyNamespaceAllocated: alloc }; killerName = killerNameBase.source;
  } else throw new Error(`FText history ${hist} not supported`);
  const n = readU16(r); const assists: Guid[] = []; for (let i = 0; i < n; i++) assists.push(guidOut(r));
  const victimPlayerState = guidOut(r);
  const location: [number, number, number] = [r.double(), r.double(), r.double()];
  const eventResult = readBitsN(r, 3);
  const bIsTeamWipe = r.bit(), bIsAce = r.bit(), bIsSpike = r.bit(), bDiedToAbyss = r.bit();
  return { killer, killerPlayerState, killerName, killerNameFlags, ...(killerNameBase ? { killerNameBase } : {}), assists, victimPlayerState, location, eventResult, bIsTeamWipe,
    bIsAce, bIsSpike, bDiedToAbyss, bitsRead: r.pos };
}

// ------------------------------------------------------------------ hero grant tables
export interface GrantRow { cls: string; pkg: string; inputId: number; level: number; selector?: boolean; swapper?: boolean; subSpells?: { cls: string; requiredTag: string | null }[] }
/**
 * Ronin, exactly flight-proven LokiSpellMirror GSpellDefs rows, in GrantLmb order (LightAttack1..4,
 * then the selector, all InputID 3,
 * Level 1; the selector's server-replicated instance carries SubSpellHandles h1 = [LA4, LA3, LA2, LA1] in cooked SubSpells order).
 * Retail never captured a Ronin grant (every capture flow is FireFox), so this table is flown in our tests, not retail-wire.
 */
export const RONIN_GRANTS: GrantRow[] = [
  { cls: "GS_Ronin_LightAttack1_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/LMB/ChargeBlade/GS_Ronin_LightAttack1", inputId: 3, level: 1 },
  { cls: "GS_Ronin_LightAttack2_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/LMB/ChargeBlade/GS_Ronin_LightAttack2", inputId: 3, level: 1 },
  { cls: "GS_Ronin_LightAttack3_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/LMB/ChargeBlade/GS_Ronin_LightAttack3", inputId: 3, level: 1 },
  { cls: "GS_Ronin_LightAttack4_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/LMB/ChargeBlade/GS_Ronin_LightAttack4", inputId: 3, level: 1 },
  { cls: "GS_Ronin_LMB_Selector_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/LMB/ChargeBlade/GS_Ronin_LMB_Selector", inputId: 3, level: 1, selector: true,
    subSpells: [{ cls: "GS_Ronin_LightAttack4_C", requiredTag: "Ability.Ronin.BasicAttack.Selector.4" }, { cls: "GS_Ronin_LightAttack3_C", requiredTag: "Ability.Ronin.BasicAttack.Selector.3" },
      { cls: "GS_Ronin_LightAttack2_C", requiredTag: "Ability.Ronin.BasicAttack.Selector.2" }, { cls: "GS_Ronin_LightAttack1_C", requiredTag: null }] },
  { cls: "GS_Ronin_Special_Selector_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/SpecialAttack/GS_Ronin_Special_Selector", inputId: 4, level: 1, selector: true },
  { cls: "GS_Ronin_Special_SpinAttack_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/SpecialAttack/SpinSlash/GS_Ronin_Special_SpinAttack", inputId: 4, level: 1 },
  { cls: "GS_Ronin_Special_AirSlam_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/SpecialAttack/AirSlam/GS_Ronin_Special_AirSlam", inputId: 4, level: 1 },
  { cls: "GS_Ronin_Special_HeavySlam_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/SpecialAttack/GS_Ronin_Special_HeavySlam", inputId: 4, level: 1 },
  { cls: "GS_Ronin_MiniDash_Charges_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/MiniDash/GS_Ronin_MiniDash_Charges", inputId: 5, level: 1 },
  { cls: "GS_Ronin_Retaliation_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/Retaliation/GS_Ronin_Retaliation", inputId: 6, level: 1 },
  { cls: "GS_TetherHook_Swapper_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/TetherHook/GS_TetherHook_Swapper", inputId: 15, level: 1, swapper: true },
  { cls: "GS_TetherHook_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/TetherHook/GS_TetherHook", inputId: 15, level: 1 },
  { cls: "GS_TetherHook_Recall_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/TetherHook/GS_TetherHook_Recall", inputId: 15, level: 1 },
  { cls: "GS_Ronin_TetherRelease_Jump_C", pkg: "/Game/Loki/Characters/Heroes/Ronin/Abilities/TetherHook/GS_Ronin_TetherRelease_Jump", inputId: 15, level: 1 },
];
export const RONIN_LMB = RONIN_GRANTS.slice(0, 5);

type GrantsJson = { heroes: Record<string, (GrantRow & { slot?: string })[]>; retail: Record<string, { specs: { handle: number; ability: string; level: number; inputId: number }[] }> };
let grantsCache: GrantsJson | null = null;
function grantsJson(): GrantsJson {
  if (!grantsCache) grantsCache = KITS as unknown as GrantsJson;
  return grantsCache!;
}
/** LMB (InputID 3) rows for a hero, from tools/gen-gas-grants.py . Other heroes: selector row first, then its sub-spells (each sub a separate spec on the same InputID). */
export function lmbGrants(hero: string): GrantRow[] {
  if (/^ronin$/i.test(hero)) return RONIN_LMB;
  const rows = grantsJson().heroes[Object.keys(grantsJson().heroes).find((h) => h.toLowerCase() === hero.toLowerCase()) ?? ""] ?? [];
  const top = rows.filter((r) => r.slot === "Ability1");
  const out: GrantRow[] = [];
  for (const t of top) {
    out.push(t);
    for (const s of t.subSpells ?? []) { const sub = rows.find((r) => r.cls === s.cls); if (sub && !out.includes(sub)) out.push(sub); }
  }
  return out;
}
/** Full kit for a hero . */
export function heroGrants(hero: string): GrantRow[] {
  if (/^ronin$/i.test(hero)) return RONIN_GRANTS;
  const j = grantsJson().heroes; const k = Object.keys(j).find((h) => h.toLowerCase() === hero.toLowerCase());
  return k ? j[k]! : [];
}
/** The retail-measured FireFox grant (flow 7038's initial ActivatableAbilities, shared passives included), paths resolved. */
export function retailFireFoxGrants() { return grantsJson().retail["7038"]!.specs; }
