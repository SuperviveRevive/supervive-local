// ACharacter packed-movement RPCs, as the real 2.0.4 client sends them (decoded from our own test-match logs
// 2026-11-24). Field indices come from the hero ClassNetCache: Actor 11 + Pawn 3 + Character 12
// replicated parents = 26, then Character's net functions sorted by name:
//   26 ClientAdjustPosition, 27-29 ClientCheat*, 30 ClientMoveResponsePacked,
//   31 RootMotionDebugClientPrintOnScreen, 32 ServerMovePacked.
// Both carry one struct param serialized as [present bit][packed NumBits][NumBits of data].
import { BitReader, BitWriter } from "./bits.ts";
import { writeQuantizedVector } from "./protocol.ts";

export const HERO_FIELD = {
  ClientMoveResponsePacked: Number(process.env.LOKI_HERO_MOVERESP_IDX || 30),
  ServerMovePacked: Number(process.env.LOKI_HERO_SERVERMOVE_IDX || 32),
};
// Total fields + 1 for the BP_HERO_* class. Captures pin it to 97..160; every index we use
// serializes to the same width anywhere in that range.
export const HERO_FIELD_MAX = Number(process.env.LOKI_HERO_FIELD_MAX || 128);

export const MOVE_MODE = { None: 0, Walking: 1, NavWalking: 2, Falling: 3, Swimming: 4, Flying: 5, Custom: 6 } as const;

export interface ClientMove {
  timeStamp: number;
  accel: [number, number, number];
  loc: [number, number, number];
  pitch: number; yaw: number; roll: number;
  flags: number;
  mode: number;
  hasPending: boolean;
  hasOld: boolean;
  /** MovementBase when the client stands on a dynamic base (then `loc` is RELATIVE to that base). Retail flows 7038/7039:
   *  looting is always done standing on the box's `Box_TerrainBlockHazard` slab, so every move there is based. */
  base?: MoveBaseRef;
}
/** A client object reference: a NetGUID, or NetGUID 1 (default) + inline export (flags, outer ref, path[, checksum]). */
export interface MoveBaseRef { guid: bigint; outerGuid?: bigint; path?: string }
/** LOKI_MOVE_BASE=0: old reader (bare packed NetGUID; moves on an inline-exported base then fail to decode and are dropped). */
export const MOVE_BASE_DECODE = process.env.LOKI_MOVE_BASE !== "0";
function readBaseRef(r: BitReader, depth = 0): MoveBaseRef {
  const guid = r.packed64();
  if (guid !== 1n || depth > 8) return { guid };
  const flags = r.uint8();
  const out: MoveBaseRef = { guid };
  if (flags & 1) {
    const outer = readBaseRef(r, depth + 1);
    out.outerGuid = outer.guid;
    out.path = r.fstring();
    if (flags & 4) r.uint32();
  }
  return out;
}

function readPackedVector(r: BitReader, scale: number): [number, number, number] {
  const header = r.serializeInt(128);
  const n = header & 0x3f;
  const scaled = !!(header & 0x40);
  if (n === 0) return scaled ? [r.double(), r.double(), r.double()] : [r.float(), r.float(), r.float()];
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    let v = 0n;
    for (let j = 0; j < n; j++) if (r.bit()) v |= 1n << BigInt(j);
    if (v & (1n << BigInt(n - 1))) v -= 1n << BigInt(n);
    out.push(Number(v) / (scaled ? scale : 1));
  }
  return out as [number, number, number];
}

const readShortAngle = (r: BitReader) => (r.bit() ? (r.uint16() * 360) / 65536 : 0);

/** FCharacterNetworkMoveData::Serialize (NewMove) — only the leading move matters to us. */
export function decodeMoveData(data: Uint8Array, bits: number): ClientMove | null {
  try {
    const r = new BitReader(data, bits);
    const timeStamp = r.float();
    const accel = readPackedVector(r, 10);
    const loc = readPackedVector(r, 100);
    const pitch = readShortAngle(r), yaw = readShortAngle(r), roll = readShortAngle(r);
    const flags = r.bit() ? r.uint8() : 0;
    // MovementBase: a full object reference. The client exports a base the server never named inline (NetGUID 1 + path), which
    // the old bare-packed64 read turned into a "bone name" bit -> every move on a box slab / platform / train was dropped.
    let base: MoveBaseRef | undefined;
    if (r.bit()) { if (MOVE_BASE_DECODE) base = readBaseRef(r); else r.packed64(); }
    if (r.bit()) throw new Error("bone name");   // MovementBaseBoneName — never seen, bail
    const mode = r.bit() ? r.uint8() : MOVE_MODE.Walking;
    const hasPending = r.bitsLeft > 0 ? r.bit() : false;
    const hasOld = false;
    if (!Number.isFinite(timeStamp) || loc.some((v) => !Number.isFinite(v))) return null;
    return { timeStamp, accel, loc, pitch, yaw, roll, flags, mode, hasPending, hasOld, ...(base ? { base } : {}) };
  } catch {
    return null;
  }
}

export interface RpcField { idx: number; bits: number; data: Uint8Array }

/** Splits an actor-channel bunch into RPC fields: [bHasRepLayout][bIsActor][packed payload bits]
 *  then repeated [SerializeInt(idx, max)][packed nb][nb bits]. Sub-object blocks are skipped. */
export function readRpcFields(data: Uint8Array, bits: number, fieldMax: number): RpcField[] {
  const out: RpcField[] = [];
  const r = new BitReader(data, bits);
  try {
    while (r.bitsLeft > 3) {
      const hasRepLayout = r.bit();
      const isActor = r.bit();
      if (!isActor) { r.packed64(); if (r.bit()) break; }
      const payloadBits = r.packed32();
      if (payloadBits > r.bitsLeft) break;
      const p = new BitReader(r.bitsFrom(payloadBits), payloadBits);
      if (hasRepLayout) break; // client never sends properties; stop rather than guess
      if (!isActor) continue;
      while (p.bitsLeft > 0) {
        const idx = p.serializeIntVar(fieldMax);
        const nb = p.packed32();
        if (nb > p.bitsLeft) break;
        out.push({ idx, bits: nb, data: p.bitsFrom(nb) });
      }
    }
  } catch {}
  return out;
}

/** ServerMovePacked(FCharacterServerMovePackedBits) param → move. */
export function decodeServerMovePacked(field: RpcField): ClientMove | null {
  try {
    const r = new BitReader(field.data, field.bits);
    if (!r.bit()) return null; // param not sent
    const n = r.packed32();
    if (n > r.bitsLeft) return null;
    return decodeMoveData(r.bitsFrom(n), n);
  } catch {
    return null;
  }
}

export interface MoveCorrection { loc: [number, number, number]; vel: [number, number, number]; mode: number }

/** ClientMoveResponsePacked param: FCharacterMoveResponseDataContainer::Serialize. */
export function writeMoveResponse(params: BitWriter, timeStamp: number, correction?: MoveCorrection) {
  const d = new BitWriter(256);
  d.bit(!correction);  // bAckGoodMove
  d.float(timeStamp);
  if (correction) {
    d.bit(false); // bHasBase
    d.bit(false); // bHasRotation
    d.bit(false); // bRootMotionMontageCorrection
    d.bit(false); // bRootMotionSourceCorrection
    writeQuantizedVector(d, ...correction.loc, 100); // NewLoc FVector_NetQuantize100
    writeQuantizedVector(d, ...correction.vel, 10);  // NewVel FVector_NetQuantize10
    d.bit(false); // NewBase
    d.bit(false); // NewBaseBoneName
    d.bit(correction.mode !== MOVE_MODE.Walking); if (correction.mode !== MOVE_MODE.Walking) d.uint8(correction.mode);
    d.bit(false); // bBaseRelativePosition
    // Shipping wrapper's mandatory 44-bit correction tail after the stock body (reference
    // LokiMovementResponseAdapter.cpp:47-62): HasCustomData 0, byte 0, float 100.0, 2 bits 0, 1 bit 0.
    // Without it the client rejects every correction (our "rescues" were ignored).
    if (process.env.LOKI_MOVE_TAIL !== "0") { d.bit(false); d.uint8(0); d.float(100); d.bit(false); d.bit(false); d.bit(false); }
  }
  params.bit(true); // param present
  params.packed32(d.bits);
  params.bitsFrom(d.buffer(), d.bits);
}
