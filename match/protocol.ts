import crypto from "node:crypto";
import { BitReader, BitWriter, stripTrailingOnes } from "./bits.ts";
export { BitReader, BitWriter } from "./bits.ts";

export const ENGINE_NET_VER_LATEST = 43;
export const MAX_CHSEQUENCE = 1024;
export const CLOSE_REASON_MAX = 15; // UE5 EChannelCloseReason::MAX (serialized with SerializeInt(.., 15) = 4 bits)
// UE: ReadInt(UNetConnection::MaxPacket*8) with MaxPacket=1024 → 13 bits, matching
// the real client (login was reached on the wire at this width).
export const MAX_BUNCH_DATA_BITS = 8192;
export const HISTORY_WORDS = 8;
export const SEQ_MASK = 0x3fff;
export const DESTROYED = 0;

export const NMT = {
  Hello: 0, Welcome: 1, Upgrade: 2, Challenge: 3, Netspeed: 4, Login: 5,
  Failure: 6, Join: 9, JoinSplit: 10, Skip: 12, Abort: 13,
  GameSpecific: 20, EncryptionAck: 21, CloseReason: 23, NetPing: 24,
} as const;

export const EChannelName = { None: 0, Control: 255, Voice: 259, Actor: 102 } as const;

export class SequenceNumber {
  constructor(public value: number) { this.value &= SEQ_MASK; }
  inc() { return new SequenceNumber(this.value + 1); }
  static diff(a: SequenceNumber, b: SequenceNumber) { return (a.value - b.value) & SEQ_MASK; }
  static gt(a: SequenceNumber, b: SequenceNumber) {
    const delta = SequenceNumber.diff(a, b);
    return delta !== 0 && delta < (SEQ_MASK + 1) / 2;
  }
  static ge(a: SequenceNumber, b: SequenceNumber) { return a.value === b.value || SequenceNumber.gt(a, b); }
}

export class SequenceHistory {
  words = new Array<number>(HISTORY_WORDS).fill(0);
  reset() { this.words.fill(0); }
  isDelivered(index: number) {
    if (index < 0 || index >= 256) return false;
    return ((this.words[index >>> 5]! >>> (index & 31)) & 1) !== 0;
  }
  add(delivered: boolean) {
    let carry = delivered ? 1 : 0;
    for (let i = 0; i < HISTORY_WORDS; i++) {
      const oldCarry = carry;
      carry = (this.words[i]! >>> 31) & 1;
      this.words[i] = ((this.words[i]! << 1) | oldCarry) >>> 0;
    }
  }
  write(w: BitWriter, count: number) { for (let i = 0; i < Math.min(count, HISTORY_WORDS); i++) w.uint32(this.words[i]!); }
  read(r: BitReader, count: number) { for (let i = 0; i < Math.min(count, HISTORY_WORDS); i++) this.words[i] = r.uint32(); }
}

export class NetPacketNotify {
  inSeq = new SequenceNumber(0);
  inAckSeq = new SequenceNumber(0);
  inAckSeqAck = new SequenceNumber(0);
  outSeq = new SequenceNumber(0);
  outAckSeq = new SequenceNumber(0);
  writtenHistoryWordCount = 0;
  writtenInAckSeq = new SequenceNumber(0);
  waitForFlushSeqAck = new SequenceNumber(0);
  inSeqHistory = new SequenceHistory();
  ackRecord: { outSeq: SequenceNumber; inAckSeq: SequenceNumber }[] = [];

  init(inSeq: number, outSeq: number) {
    this.inSeqHistory.reset();
    this.inSeq = new SequenceNumber(inSeq - 1);
    this.inAckSeq = new SequenceNumber(inSeq - 1);
    this.inAckSeqAck = new SequenceNumber(inSeq - 1);
    this.outSeq = new SequenceNumber(outSeq);
    this.outAckSeq = new SequenceNumber(outSeq - 1);
    this.waitForFlushSeqAck = this.outAckSeq;
    this.ackRecord = [];
  }

  ackSeq(seq: SequenceNumber) {
    while (SequenceNumber.gt(seq, this.inAckSeq)) {
      this.inAckSeq = this.inAckSeq.inc();
      this.inSeqHistory.add(seq.value === this.inAckSeq.value);
    }
  }

  currentHistoryLength() {
    return Math.min(SequenceNumber.diff(this.inAckSeq, this.inAckSeqAck), 256);
  }

  writeHeader(w: BitWriter) {
    const count = Math.max(1, Math.min(Math.ceil(this.currentHistoryLength() / 32), HISTORY_WORDS));
    this.writtenHistoryWordCount = count;
    this.writtenInAckSeq = this.inAckSeq;
    const packed = (BigInt(this.outSeq.value) << 18n) |
      (BigInt(this.inAckSeq.value) << 4n) |
      BigInt(Math.max(0, count - 1));
    w.uint32(Number(packed));
    this.inSeqHistory.write(w, count);
  }

  readHeader(r: BitReader) {
    const packed = BigInt(r.uint32());
    const historyWordCount = Number(packed & 0xfn) + 1;
    if (historyWordCount > HISTORY_WORDS) throw new Error("invalid packet history length");
    const history = new SequenceHistory();
    history.read(r, historyWordCount);
    return {
      seq: new SequenceNumber(Number((packed >> 18n) & 0x3fffn)),
      ackedSeq: new SequenceNumber(Number((packed >> 4n) & 0x3fffn)),
      historyWordCount, history,
    };
  }

  commitAndIncrement() {
    this.ackRecord.push({ outSeq: this.outSeq, inAckSeq: this.writtenInAckSeq });
    this.writtenHistoryWordCount = 0;
    this.outSeq = this.outSeq.inc();
  }

  update(header: ReturnType<NetPacketNotify["readHeader"]>, onAck: (seq: SequenceNumber, delivered: boolean) => void) {
    if (!(SequenceNumber.gt(header.seq, this.inSeq) &&
      SequenceNumber.ge(header.ackedSeq, this.outAckSeq) &&
      SequenceNumber.gt(this.outSeq, header.ackedSeq))) return 0;

    if (SequenceNumber.gt(header.ackedSeq, this.outAckSeq)) {
      let count = SequenceNumber.diff(header.ackedSeq, this.outAckSeq);
      for (let i = 0; i < count - 1; i++) this.ackRecord.shift();
      const record = this.ackRecord.shift();
      if (record && record.outSeq.value === header.ackedSeq.value) this.inAckSeqAck = record.inAckSeq;
      let current = this.outAckSeq.inc();
      const historyBits = header.historyWordCount * 32;
      while (count > historyBits) { onAck(current, false); current = current.inc(); count--; }
      while (count > 0) { onAck(current, header.history.isDelivered(count - 1)); current = current.inc(); count--; }
      this.outAckSeq = header.ackedSeq;
      if (SequenceNumber.gt(this.outAckSeq, this.waitForFlushSeqAck)) this.waitForFlushSeqAck = this.outAckSeq;
    }
    const delta = SequenceNumber.diff(header.seq, this.inSeq);
    this.inSeq = header.seq;
    return delta;
  }
}

export interface Bunch {
  bOpen: boolean; bClose: boolean; closeReason: number; bReliable: boolean;
  bHasPackageMapExports: boolean; bHasMustBeMappedGUIDs: boolean; bPartial: boolean;
  bPartialInitial: boolean; bPartialFinal: boolean; chIndex: number; chSequence: number;
  chNameIndex: number; data: Uint8Array; bits: number; packetId: number;
}

export function newBunch(): Bunch {
  return {
    bOpen: false, bClose: false, closeReason: DESTROYED, bReliable: false,
    bHasPackageMapExports: false, bHasMustBeMappedGUIDs: false, bPartial: false,
    bPartialInitial: false, bPartialFinal: false, chIndex: 0, chSequence: 0,
    chNameIndex: EChannelName.Control, data: new Uint8Array(0), bits: 0, packetId: 0,
  };
}

const CHANNEL_NAMES: Record<number, string> = {
  [EChannelName.Control]: "Control",
  [EChannelName.Actor]: "Actor",
};

export function writeBunch(bunch: Bunch, w: BitWriter, realNames = false) {
  const h = new BitWriter(256);
  h.bit(bunch.bOpen || bunch.bClose);
  if (bunch.bOpen || bunch.bClose) {
    h.bit(bunch.bOpen); h.bit(bunch.bClose);
    if (bunch.bClose) h.serializeInt(bunch.closeReason, CLOSE_REASON_MAX);
  }
  h.bit(false);
  h.bit(bunch.bReliable);
  h.packed32(bunch.chIndex);
  h.bit(bunch.bHasPackageMapExports);
  h.bit(bunch.bHasMustBeMappedGUIDs);
  h.bit(bunch.bPartial);
  if (bunch.bReliable) h.wrapped(bunch.chSequence, MAX_CHSEQUENCE);
  if (bunch.bPartial) { h.bit(bunch.bPartialInitial); h.bit(bunch.bPartialFinal); }
  if (bunch.bOpen || bunch.bReliable) {
    // Hardcoded-name form (UE NAME_* index, e.g. Actor=102): the reference UE5
    // client maps string-form names through its local FName pool, which does
    // not know engine names — string form never resolves to EName.Actor.
    h.bit(true);
    h.packed32(bunch.chNameIndex);
  }
  h.wrapped(bunch.bits, MAX_BUNCH_DATA_BITS);
  w.bitsFrom(h.buffer(), h.bits);
  if (bunch.bits) w.bitsFrom(bunch.data, bunch.bits);
}

export function readBunch(r: BitReader, packetId: number, inReliableSeq = 0): Bunch {
  const b = newBunch();
  b.packetId = packetId;
  const isControl = r.bit();
  b.bOpen = isControl && r.bit();
  b.bClose = isControl && r.bit();
  if (b.bClose) b.closeReason = r.serializeInt(CLOSE_REASON_MAX);
  r.bit();
  b.bReliable = r.bit();
  b.chIndex = r.packed32();
  b.bHasPackageMapExports = r.bit();
  b.bHasMustBeMappedGUIDs = r.bit();
  b.bPartial = r.bit();
  if (b.bReliable) {
    const value = r.wrapped(MAX_CHSEQUENCE);
    const delta = ((value - inReliableSeq + 512) & 1023) - 512;
    b.chSequence = (inReliableSeq + delta) & 1023;
  }
  if (b.bPartial) { b.bPartialInitial = r.bit(); b.bPartialFinal = r.bit(); }
  if (b.bOpen || b.bReliable) {
    const hardcoded = r.bit();
    if (hardcoded) {
      b.chNameIndex = r.packed32();
    } else {
      const name = r.fstring();
      r.uint32();                          // FName number suffix
      b.chNameIndex = name === "Actor" ? EChannelName.Actor : EChannelName.Control;
    }
  }
  b.bits = r.wrapped(MAX_BUNCH_DATA_BITS);
  b.data = r.bitsFrom(b.bits);
  return b;
}

// ---- StatelessConnectHandlerComponent ----
export interface HandshakePacket {
  origCookie?: Uint8Array;
  travelCount: number; clientId: number; minVersion: number; version: number;
  packetType: number; sentCount: number; networkVersion: number;
  runtimeFeatures: number; secretId: number; timestamp: number; cookie: Uint8Array;
  restarted: boolean;
  realPrefix?: Uint8Array | null;
}

// Loki client wraps every UDP packet in a 64-bit prefix:
// [8-bit marker 0xbb][8-bit rand][32-bit marker LE 0xa3a621dc][8-bit rand][8-bit marker 0xfb]
// then the standard UE v3+ handshake / connected-packet layout.
export const REAL_PREFIX_LEN_BITS = 64;
export const REAL_PREFIX_CONST = [0xbb, 0xdc, 0x21, 0xa6, 0xa3, 0xfb];

export function detectRealPrefix(data: Uint8Array): boolean {
  if (data.length < 9) return false;
  return data[0] === 0xbb && data[2] === 0xdc && data[3] === 0x21 && data[4] === 0xa6 && data[5] === 0xa3 && data[7] === 0xfb;
}

export const HANDSHAKE_COOKIE_SIZE = 20;

function countSignificantBits(data: Uint8Array): number {
  let bits = data.length * 8;
  let lastByte = data[data.length - 1]!;
  if (lastByte === 0) return -1;
  while ((lastByte & 0x80) === 0) { lastByte *= 2; bits--; }
  return bits;
}

// Real UE5 stateless-connect handshake (client-captured wire format):
// [loki prefix 8B?][travel 2b][clientId 3b][bHandshakePacket=1][restarted 1b]
// [minVer u8][version u8][pktType u8][sentCount u8][netver u32 LE][features u16 LE]
// [secretId 1b][timestamp f64][cookie 20B][+ origCookie 20B when restarted]
// [random 8-16B padding][terminating 1b]
export function parseHandshake(data: Uint8Array): HandshakePacket {
  let prefix = null as Uint8Array | null;
  let body = data;
  if (detectRealPrefix(data)) { prefix = data.slice(0, 8); body = data.subarray(8); }
  const bits = stripTrailingOnes(body);
  const hs = parseHandshakeBody(body.subarray(0, Math.ceil(bits / 8)), true);
  if (!hs) throw new Error("not a handshake packet");
  let origCookie = new Uint8Array(HANDSHAKE_COOKIE_SIZE);
  if (hs.restarted) {
    const r = new BitReader(body, bits);
    r.serializeInt(4); r.serializeInt(8); r.bit(); r.bit();
    r.uint8(); r.uint8(); r.uint8(); r.uint8();
    if (hs.version >= 2) { r.uint32(); r.uint16(); }
    r.bit(); r.double();
    r.bitsFrom(20 * 8);
    origCookie = r.bitsFrom(20 * 8);
  }
  return { ...hs, origCookie, realPrefix: prefix } as HandshakePacket;
}

export function makeRestartResponse(h: HandshakePacket, secret: Uint8Array, address: string, timestamp: number, activeSecret: number) {
  const cookie = generateCookie(secret, address, timestamp);
  return writeHandshakeRaw({ ...h, secretId: activeSecret, restarted: true }, 5, timestamp, cookie, true);
}

function parseHandshakeBody(data: Uint8Array, clientBits: boolean): HandshakePacket | null {
  const r = new BitReader(data);
  const travelCount = clientBits ? r.serializeInt(4) : 0;
  const clientId = clientBits ? r.serializeInt(8) : 0;
  if (r.pos >= r.numBits) return null;
  if (!r.bit()) return null;
  const restarted = r.bit();
  const minVersion = r.uint8();
  const version = r.uint8();
  if (clientBits !== version >= 3) return null;
  const packetType = r.uint8();
  const sentCount = r.uint8();
  if (packetType > 6) return null;
  let networkVersion = 0, runtimeFeatures = 0;
  if (version >= 2) { networkVersion = r.uint32(); runtimeFeatures = r.uint16(); }
  const secretId = r.bit() ? 1 : 0;
  const timestamp = r.double();
  const cookie = r.bitsFrom(20 * 8);
  return { travelCount, clientId, minVersion, version, packetType, sentCount, networkVersion, runtimeFeatures, secretId, timestamp, cookie, restarted };
}

export type PrefixVariant = "echo" | "random" | "none" | "mirror";export type PrefixVariant = "echo" | "random" | "none";

function buildPrefix(variant: PrefixVariant, realPrefix: Uint8Array | null | undefined): Uint8Array | null {
  if (variant === "none") return null;
  if (variant === "echo" && realPrefix) return realPrefix;
  if (variant === "mirror" && realPrefix) return realPrefix;
  if (variant === "mirror") return null;
  return Uint8Array.of(0xbb, crypto.randomInt(256), 0xdc, 0x21, 0xa6, 0xa3, crypto.randomInt(256), 0xfb);
}

function writeHandshakeRaw(h: HandshakePacket, packetType: number, timestamp: number, cookie: Uint8Array, includeOrig = false, prefixVariant: PrefixVariant = "echo", mirrorPrefix?: Uint8Array | null) {
  const w = new BitWriter(256);
  w.serializeInt(h.travelCount, 4);   // 2 bits
  w.serializeInt(h.clientId, 8);      // 3 bits
  w.bit(true);                        // bHandshakePacket
  w.bit(h.restarted ? 1 : 0);
  w.uint8(h.minVersion || 3);
  w.uint8(h.version || 4);
  w.uint8(packetType);
  w.uint8(h.sentCount || 0);
  w.uint32(h.networkVersion);
  w.uint16(h.runtimeFeatures);
  w.bit(h.secretId === 1);
  w.double(timestamp);
  w.bytes(cookie);
  if (includeOrig) w.bytes(h.origCookie);
  // Client size-window check: payload+random+terminator must keep
  // (bitsLeft - 306) inside [64, 128] => 8..15 random bytes.
  w.bytes(crypto.randomBytes(8 + crypto.randomInt(8)));
  w.bit(true);                        // terminating bit
  const buf = w.buffer();
  const prefix = buildPrefix(prefixVariant, prefixVariant === "mirror" ? mirrorPrefix : h.realPrefix);
  return prefix ? Buffer.concat([Buffer.from(prefix), buf]) : buf;
}

// HMAC-SHA1 cookie over timestamp + client address, keyed by the server secret (UE GenerateCookie).
export function generateCookie(secret: Uint8Array, address: string, timestamp: number): Buffer {
  const inner = new BitWriter(64 * 8);
  inner.double(timestamp);
  const addrBytes = Buffer.from(address, "utf8");
  inner.bytes(addrBytes);
  const payload = inner.buffer();
  const cookie = crypto.createHmac("sha1", secret).update(payload).digest();
  // Cookie bytes [0..1] = server initial packet sequence, [2..3] = client initial
  // packet sequence: both sides extract these on ack (UNetConnection::InitSequence).
  cookie[0] = 1; cookie[1] = 0;
  cookie[2] = 0; cookie[3] = 0;
  return cookie;
}

export function makeChallenge(h: HandshakePacket, secret: Uint8Array, address: string, timestamp: number, activeSecret: number, prefixVariant: PrefixVariant = "none", mirrorPrefix?: Uint8Array | null) {
  const cookie = generateCookie(secret, address, timestamp);
  // Challenge echoes the client's version fields + netver (the client hard-rejects a
  // netver mismatch) and carries OUR timestamp, which the client echoes back in its
  // Response so we can regenerate + verify the HMAC cookie.
  const out = writeHandshakeRaw({ ...h, secretId: activeSecret, restarted: false, sentCount: 1 }, 1, timestamp, cookie, false, prefixVariant, mirrorPrefix);
  return { packet: out, cookie, timestamp };
}

export function makeAck(h: HandshakePacket, authorisedCookie: Uint8Array, prefixVariant: PrefixVariant = "none", mirrorPrefix?: Uint8Array | null, opts?: { packetType?: number; timestamp?: number; secretId?: number }) {
  // Ack echoes the authorised cookie back; timestamp/secretId/packetType overridable
  // while we pin down the exact SendChallengeAck the client accepts.
  return writeHandshakeRaw({ ...h, restarted: false, secretId: opts?.secretId ?? 1 }, opts?.packetType ?? 3, opts?.timestamp ?? -1, authorisedCookie, false, prefixVariant, mirrorPrefix);
}

export function stripHandler(data: Uint8Array, validSeq?: (seq: number) => boolean) {
  const bits = stripTrailingOnes(data);
  // UE StatelessConnect game-packet prefix: [SessionID][ClientID][bHandshake 0].
  // Reference UE5 clients send [2b][3b]; Loki's shipping build uses the widened
  // [4b][8b]. Prefer the variant whose packet header passes the sequence check.
  // Without the Loki magic prefix this is a stock-UE client: narrow first.
  // Both variants are attempted defensively: a short packet under one layout
  // overflows its header reads, which must fall through to the other layout
  // rather than throw (the wide header alone is 12 bits).
  const narrow = tryStripWithPrefix(data, bits, 2, 3);
  const wide = tryStripWithPrefix(data, bits, 4, 8);
  if (validSeq) {
    if (narrow && validSeq(packetSeq(narrow.inner))) return narrow;
    if (wide && validSeq(packetSeq(wide.inner))) return wide;
  }
  return narrow ?? wide;
}

function stripWithPrefix(data: Uint8Array, bits: number, travelBits: number, clientBits: number) {
  const r = new BitReader(data, bits);
  const travelCount = r.serializeInt(1 << travelBits);
  const clientId = r.serializeInt(1 << clientBits);
  if (r.bit()) return null;
  const remaining = r.bitsLeft;
  const inner = r.bitsFrom(remaining);
  return { reader: new BitReader(inner, remaining), travelCount, clientId, inner };
}
function tryStripWithPrefix(data: Uint8Array, bits: number, travelBits: number, clientBits: number) {
  try {
    return stripWithPrefix(data, bits, travelBits, clientBits);
  } catch {
    return null;
  }
}

/** First uint32 of the inner packet = packed FNetPacketNotify header; seq is bits [18:32). */
function packetSeq(inner: Uint8Array): number {
  if (inner.length < 4) return -1;
  const packed = (inner[0]! | (inner[1]! << 8) | (inner[2]! << 16) | (inner[3]! << 24)) >>> 0;
  return (packed >> 18) & 0x3fff;
}

export function addHandler(data: Uint8Array, travelCount: number, clientId: number, bitCount = data.length * 8, realPrefix?: Uint8Array | null) {
  // Real wire: 8-byte Loki prefix + 7-bit outer header (travel 2b, clientId 3b,
  // bHandshakePacket=0) mirroring the client's own outgoing bit layout.
  if (realPrefix) {
    const w = new BitWriter(bitCount + 16);
    w.serializeInt(travelCount, 4);
    w.serializeInt(clientId, 8);
    w.bit(false);
    w.bitsFrom(data, bitCount);
    return Buffer.concat([Buffer.from(realPrefix), w.buffer()]);
  }
  const w = new BitWriter(bitCount + 16);
  w.serializeInt(travelCount, 4);
  w.serializeInt(clientId, 8);
  w.bit(false);
  w.bitsFrom(data, bitCount);
  return w.buffer();
}

export function finalizePacket(w: BitWriter) {
  w.bit(true);
  w.bit(true);
  return w.buffer();
}

export function controlMessage(type: number, write?: (w: BitWriter) => void) {
  const w = new BitWriter(512);
  w.uint8(type);
  write?.(w);
  return w.buffer();
}

// ---- Package map / GUID exports ----
export interface GuidExport { guid: bigint; path: string; outer: bigint; checksum?: number; noLoad?: boolean }

export function writeNetGuid(w: BitWriter, guid: bigint | number) { w.packed64(guid); }
export function readNetGuid(r: BitReader) { return r.packed64(); }

export function writeGuidExport(w: BitWriter, exp: GuidExport) {
  writeNetGuid(w, exp.guid);
  w.uint8((exp.path ? 1 : 0) | (exp.noLoad ? 2 : 0) | (exp.checksum !== undefined ? 4 : 0));
  if (exp.path) {
    // InternalLoadObject returns immediately for outer GUID 0; GUID >= 1 triggers a
    // recursive read that also consumes an export-flags byte.
    writeNetGuid(w, exp.outer);
    if (exp.outer >= 1n) w.uint8(0);
    w.fstring(exp.path);
    if (exp.checksum !== undefined) w.uint32(exp.checksum);
  }
}

export function readGuidExport(r: BitReader): GuidExport | null {
  const guid = readNetGuid(r);
  if (guid === 0n) return null;
  const flags = r.uint8();
  const out: GuidExport = { guid, path: "", outer: 0n };
  if (flags & 1) {
    out.outer = readNetGuid(r);
    if (out.outer >= 1n) r.uint8(); // outer export flags
    out.path = r.fstring();
    if (flags & 4) out.checksum = r.uint32();
  }
  out.noLoad = !!(flags & 2);
  return out;
}

export function writeNetGuidExportSection(w: BitWriter, exports: GuidExport[]) {
  w.bit(false); // bHasRepLayoutExport — we serialize raw NetGUID exports
  w.int32(exports.length);
  for (const exp of exports) writeGuidExport(w, exp);
}

// ---- Actor spawn serialization ----
export const GUID = {
  None: 0n, Default: 1n,
  EnginePackage: 11n, GamePackage: 13n, LevelPackage: 15n,
  GameStateClass: 21n, PlayerStateClass: 23n, PlayerControllerClass: 25n,
  CharacterClass: 27n, GameModeClass: 29n, Level: 31n, GameStateBPPackage: 33n,
  World: 35n, PlayerStateBPPackage: 37n, PlayerControllerBPPackage: 39n,
  /** Per-hero pawn blueprint: package = HeroBase + 4*i, CDO = HeroBase + 4*i + 2 (both odd = static). */
  HeroBase: 201n,
  GameStateActor: 10n, PlayerStateActor: 12n, PlayerControllerActor: 14n,
  CharacterActor: 16n, CharacterMovement: 18n, AbilitySystem: 20n,
} as const;

export function writeQuantizedVector(w: BitWriter, x: number, y: number, z: number, scale = 10) {
  const round = (v: number) => Math.round(v * scale);
  const sx = round(x), sy = round(y), sz = round(z);
  const maxAbs = Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz));
  // UE SerializePackedVector: CeilLogTwo(1 + max) + 1 bits per component (a zero vector is 1 bit, retail-verified).
  const n = maxAbs === 0 ? 1 : Math.max(1, Math.min(63, maxAbs.toString(2).length + 1));
  w.serializeInt(n | 0x40, 128);
  for (const value of [sx, sy, sz]) {
    const raw = BigInt.asUintN(n, BigInt(value));
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(raw, 0);
    w.bitsFrom(b, n);
  }
}

export function writeRotation(w: BitWriter, pitch: number, yaw: number, roll: number, includeSerializeFlag = true) {
  if (includeSerializeFlag) w.bit(true);
  for (const angle of [pitch, yaw, roll]) {
    const compressed = Math.round(angle * (65536 / 360)) & 0xffff;
    w.bit(compressed !== 0);
    if (compressed !== 0) w.uint16(compressed);
  }
}

export function writeConditionallySerializeQuantizedVector(
  w: BitWriter, vector: [number, number, number] | null,
) {
  if (!vector) { w.bit(false); return; }
  w.bit(true);  // bShouldSerialize
  w.bit(true);  // bShouldQuantize (v13+)
  writeQuantizedVector(w, ...vector, 10);
}

export function writeNewActor(w: BitWriter, actorGuid: bigint, archetypeGuid: bigint,
  location: [number, number, number] | null, rotation: [number, number, number] | null,
  levelGuid: bigint | number = GUID.None) {
  writeNetGuid(w, actorGuid);
  // Dynamic actors (even NetGUID) always carry archetype/level/transform.
  writeNetGuid(w, archetypeGuid);
  writeNetGuid(w, levelGuid);
  writeConditionallySerializeQuantizedVector(w, location);
  // Rotation: 1-bit bSerializeRotation + SerializeCompressedShort.
  w.bit(rotation !== null);
  if (rotation) writeRotation(w, ...rotation, false);
  writeConditionallySerializeQuantizedVector(w, null); // scale
  writeConditionallySerializeQuantizedVector(w, null); // velocity
}

/** FRepMovement::NetSerialize for engine net version 25+ (4 flag bits). */
export function writeRepMovement(w: BitWriter, opts: {
  location: [number, number, number];
  rotation: [number, number, number];
  velocity: [number, number, number];
  shortRotation?: boolean;
  serverFrame?: number;
}) {
  const hasFrame = opts.serverFrame !== undefined;
  let flags = 0;
  if (hasFrame) flags |= 4;
  w.bitsFrom(Uint8Array.of(flags), 4);
  writeQuantizedVector(w, ...opts.location, 100);
  if (opts.shortRotation === false) {
    for (const angle of opts.rotation) {
      const compressed = Math.round(angle * (256 / 360)) & 0xff;
      w.bit(compressed !== 0);
      if (compressed) w.uint8(compressed);
    }
  } else {
    writeRotation(w, ...opts.rotation, false);
  }
  writeQuantizedVector(w, ...opts.velocity, 1);
  if (hasFrame) w.packed32(opts.serverFrame!);
  // No trailing acceleration bit in this engine: the extra bit shifted every handle after
  // ReplicatedMovement by one (owned hero read its PC NetGUID 0x3240 as handle 12864) and left
  // one stray bit in every movement update ("Error reading RepIndex").
}

export function writeContentBlock(w: BitWriter, hasRepLayout: boolean, isActor: boolean, payload: Uint8Array, bits?: number) {
  w.bit(hasRepLayout); w.bit(isActor);
  const payloadBits = bits ?? payload.length * 8;
  w.packed32(payloadBits);
  if (payloadBits) w.bitsFrom(payload, payloadBits);
}

export function tryParseRealPacket(data: Uint8Array, validSeq?: (seq: number) => boolean) {
  // Reference UE5 client sends 2+3; accept the widened 4+8 form defensively.
  // Captured Loki traffic always parses as narrow (client id 5, seq 1,2,3...),
  // so prefer narrow and fall back to wide only when narrow does not parse.
  return tryParseRealPacketPrefix(data, 2, 3, validSeq)
    ?? tryParseRealPacketPrefix(data, 4, 8, validSeq);
}

function tryParseRealPacketPrefix(data: Uint8Array, travelBits: number, clientBits: number, validSeq?: (seq: number) => boolean) {
  const bits = stripTrailingOnes(data);
  if (bits < 2 + 3 + 1 + 32) return null;
  const base = new BitReader(data, bits);
  const sess = base.serializeInt(1 << travelBits);
  const clientId = base.serializeInt(1 << clientBits);
  if (base.bit()) return null;             // game packet: bHandshakePacket = 0
  const packed = BigInt(base.uint32());
  const headerSeq = Number((packed >> 18n) & 0x3fffn);
  const ackedSeq = Number((packed >> 4n) & 0x3fffn);
  const historyCount = Number(packed & 0xfn) + 1;
  if (historyCount > HISTORY_WORDS) return null;
  if (validSeq && !validSeq(headerSeq)) return null;
  const parse = (jitter: boolean) => {
    try {
      const r = new BitReader(data, bits);
      r.serializeInt(1 << travelBits);
      r.serializeInt(1 << clientBits);
      r.bit();
      r.uint32();
      const history: number[] = [];
      for (let i = 0; i < historyCount; i++) history.push(r.uint32());
      // Ack-only packet (18 B on the wire): header + history + bHasPacketInfo + nothing else.
      if (r.bitsLeft <= 3) return { headerSeq, ackedSeq, history, jitter: false, sess, clientId, bunches: [] as Bunch[] };
      // bHasPacketInfoPayload: UE sends the jitter clock only on the first packet of a frame; every
      // further packet in the same frame carries a 0 here and goes straight to its bunches. The old
      // parser skipped this bit on the no-info path, so all multi-packet frames (ability presses,
      // big reliable bunches, resends) were dropped as "real packet parse failed".
      const hasInfo = r.bit();
      if (hasInfo !== jitter) return null;
      if (hasInfo) {
        r.serializeInt(1024);
        r.bit();
      }
      const bunches: Bunch[] = [];
      while (r.bitsLeft >= 10) {
        try { bunches.push(readBunch(r, headerSeq)); } catch { return null; }
      }
      return { headerSeq, ackedSeq, history, jitter, sess, clientId, bunches };
    } catch {
      return null;
    }
  };
  return parse(true) ?? parse(false);
}

export function isHandshake(data: Uint8Array): boolean {
  if (detectRealPrefix(data)) return true;
  if (data.length < 2) return false;
  // UE5 layout: [travel 2b][clientId 3b][bHandshakePacket] — bHS is bit 5 (LSB-first).
  return (data[0]! & 0x20) === 0x20;
}

export function writeRealPrefix(w: BitWriter, template?: Uint8Array) {
  if (template && template.length >= 8) {
    for (let i = 0; i < 8; i++) w.uint8(template[i]);
    return;
  }
  w.uint8(0xbb);
  w.uint8(crypto.randomInt(0, 256));
  w.uint8(0xdc); w.uint8(0x21); w.uint8(0xa6); w.uint8(0xa3);
  w.uint8(crypto.randomInt(0, 256));
  w.uint8(0xfb);
}

export function readHello(r: BitReader) {
  const littleEndian = r.uint8() !== 0;
  const version = r.uint32();
  const token = r.fstring();
  const runtimeFeatures = r.uint16();
  return { littleEndian, version, token, runtimeFeatures };
}

export function writeChallenge(w: BitWriter, challenge: string) {
  w.fstring(challenge);
}

const SUBSYSTEM_HASH: Record<string, number> = {
  NULL: 1, MCP: 2, STEAM: 3, PS4: 4, GOOGLE: 5, GOOGLEPLAY: 6, FACEBOOK: 7,
  IOS: 8, APPLE: 9, TENCENT: 10, NINTENDO: 11, AMAZON: 12, GAMECIRCLE: 13,
  THUNDERHEAD: 14, ONESTORE: 15, PS4SERVER: 16,
};
const HASH_SUBSYSTEM = Object.fromEntries(
  Object.entries(SUBSYSTEM_HASH).map(([name, hash]) => [hash, name]),
);

export interface UniqueNetId { type: string; contents: string }

export function readUniqueNetIdRepl(r: BitReader): UniqueNetId | null {
  const flags = r.uint8();
  const encoded = (flags & 1) !== 0;
  const empty = (flags & 2) !== 0;
  const padded = (flags & 4) !== 0;
  const typeHash = (flags >> 3) & 31;
  const typeName = typeHash === 31 ? r.fstring() : (HASH_SUBSYSTEM[typeHash] || "");
  if (encoded) {
    if (empty) return null;
    if (typeHash === 30) {
      r.uint8();
      const size = r.int32();
      if (size <= 0) return null;
      return { type: typeName, contents: Buffer.from(r.bitsFrom(size * 8)).toString("hex") };
    }
    const size = r.uint8();
    if (size === 0) return null;
    let hex = Buffer.from(r.bitsFrom(size * 8)).toString("hex");
    if (padded) hex = hex.slice(2);
    return { type: typeName, contents: hex };
  }
  const contents = r.fstring();
  if (!contents) return null;
  return { type: typeName, contents };
}

export function writeUniqueNetIdRepl(w: BitWriter, id: UniqueNetId | null) {
  if (!id || !id.contents) { w.uint8(2); return; }
  const hash = SUBSYSTEM_HASH[id.type.toUpperCase()] ?? 31;
  const bytes = /^[0-9a-fA-F]+$/.test(id.contents) && id.contents.length % 2 === 0
    ? Buffer.from(id.contents, "hex") : Buffer.from(id.contents, "utf8");
  w.uint8(1 | (hash << 3));
  if (hash === 31) w.fstring(id.type);
  w.uint8(Math.min(255, bytes.length));
  w.bytes(bytes);
}

export function readUniqueIdString(r: BitReader): string {
  const id = readUniqueNetIdRepl(r);
  return id ? (id.contents || id.type) : "";
}

export function writeWelcome(w: BitWriter, mapName: string, gameName: string, redirect = "") {
  w.fstring(mapName);
  w.fstring(gameName);
  w.fstring(redirect);
}
