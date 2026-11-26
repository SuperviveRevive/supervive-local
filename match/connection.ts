import {
  BitReader, BitWriter, EChannelName, NetPacketNotify, SequenceNumber,
  addHandler, finalizePacket, newBunch, readBunch, stripHandler, writeBunch,
  MAX_BUNCH_DATA_BITS,
} from "./protocol.ts";

export interface UEConnectionOptions {
  clientId: number;
  travelCount: number;
  networkVersion: number;
  inSeq: number;
  outSeq: number;
}

export class UEConnection {
  clientId: number;
  travelCount: number;
  networkVersion: number;
  notify = new NetPacketNotify();
  outReliable = new Array<number>(16384).fill(0);
  inReliable = new Array<number>(16384).fill(0);
  channels = new Set<number>();
  pending: { hello?: { version: number; token: string }; login?: { url: string } } = {};
  state: "challenge" | "connected" | "joined" = "challenge";
  sentPackets = new Map<number, { data: Uint8Array; at: number; createdAt: number }[]>();
  lastSeenMs = Date.now();
  players = new Map<string, { id: string; name: string; guid: bigint; channel: number; x: number; y: number; z: number; yaw: number }>();

  onSend?: (data: Uint8Array) => void;
  onControl?: (type: number, reader: BitReader) => void;
  onJoin?: () => void;

  constructor(opts: UEConnectionOptions) {
    this.clientId = opts.clientId;
    this.travelCount = opts.travelCount;
    this.networkVersion = opts.networkVersion;
    this.notify.init(opts.inSeq, opts.outSeq);
  }

  nextChannel() {
    for (let i = 1; i < 1024; i++) if (!this.channels.has(i)) return i;
    return 1;
  }

  nextReliable(ch: number) {
    this.outReliable[ch] = ((this.outReliable[ch] || 0) + 1) & 1023;
    return this.outReliable[ch]!;
  }

  private buildPacket(build: (w: BitWriter) => void) {
    const w = new BitWriter(1400, true);
    this.notify.writeHeader(w);
    w.bit(true);
    w.serializeInt(80, 1024);
    w.bit(false);
    const packetId = this.notify.outSeq.value;
    build(w);
    const inner = finalizePacket(w);
    const data = addHandler(inner, this.travelCount, this.clientId, w.bits);
    this.notify.commitAndIncrement();
    return { packetId, data };
  }

  sendEmpty() {
    const packet = this.buildPacket(() => {});
    this.onSend?.(packet.data);
  }

  sendBunch(
    payload: Uint8Array,
    opts: { ch: number; reliable?: boolean; open?: boolean; close?: boolean; nameIndex?: number; exports?: Uint8Array },
  ) {
    const reliable = opts.reliable !== false;
    const bunch = newBunch();
    bunch.bOpen = !!opts.open;
    bunch.bClose = !!opts.close;
    bunch.chIndex = opts.ch;
    bunch.bReliable = reliable;
    bunch.chNameIndex = opts.nameIndex ?? (opts.ch === 0 ? EChannelName.Control : EChannelName.Actor);
    if (reliable) bunch.chSequence = this.nextReliable(opts.ch);
    const data = new BitWriter(Math.max(64, payload.length * 8 + 64), true);
    if (opts.exports?.length) {
      bunch.bHasPackageMapExports = true;
      data.bitsFrom(opts.exports);
    }
    if (payload.length) data.bitsFrom(payload);
    bunch.data = data.buffer();
    bunch.bits = data.bits;
    const packet = this.buildPacket((w) => writeBunch(bunch, w));
    if (reliable) {
      const list = this.sentPackets.get(packet.packetId) || [];
      const now = Date.now();
      list.push({ data: packet.data, at: now, createdAt: now });
      this.sentPackets.set(packet.packetId, list);
    }
    if (opts.close) this.channels.delete(opts.ch);
    else this.channels.add(opts.ch);
    this.onSend?.(packet.data);
    return packet.packetId;
  }

  resendUnacked() {
    const now = Date.now();
    for (const [seq, packets] of this.sentPackets) {
      if (now - packets[0]!.createdAt > 15_000) { this.sentPackets.delete(seq); continue; }
      for (const p of packets) if (now - p.at > 250) { p.at = now; this.onSend?.(p.data); }
    }
  }

  receive(data: Uint8Array) {
    this.lastSeenMs = Date.now();
    const stripped = stripHandler(data);
    if (!stripped) return;
    this.clientId = stripped.clientId;
    this.travelCount = stripped.travelCount;
    const innerBits = stripTrailingBits(stripped.reader);
    if (innerBits.bits <= 0) return;
    const r = new BitReader(innerBits.bytes, innerBits.bits);
    const header = this.notify.readHeader(r);
    if (r.bit()) {
      r.serializeInt(1024);
      if (r.bit()) r.uint8();
    }
    const delta = this.notify.update(header, (seq, delivered) => {
      const packets = this.sentPackets.get(seq.value);
      if (!packets) return;
      if (delivered) this.sentPackets.delete(seq.value);
      else for (const p of packets) this.onSend?.(p.data);
    });
    if (delta <= 0) return;
    let skipAck = false;
    while (r.bitsLeft >= 10) {
      try {
        const bunch = readBunch(r, header.seq.value);
        if (bunch.bClose) this.channels.delete(bunch.chIndex);
        if (bunch.chIndex === 0 && bunch.bits >= 8) {
          const payload = new BitReader(bunch.data, bunch.bits);
          this.onControl?.(payload.uint8(), payload);
        } else if (bunch.bOpen && !this.channels.has(bunch.chIndex)) {
          this.channels.add(bunch.chIndex);
          this.onJoin?.();
        }
      } catch {
        skipAck = true;
        break;
      }
    }
    if (!skipAck) this.notify.ackSeq(header.seq);
    this.sendEmpty();
  }
}

function stripTrailingBits(reader: BitReader) {
  const bytes = reader.bitsFrom(reader.bitsLeft);
  let count = bytes.length * 8;
  while (count > 0) {
    const byte = bytes[(count - 1) >> 3]!;
    if (byte & (1 << ((count - 1) & 7))) break;
    count -= 1;
  }
  const bits = Math.max(0, count - 1);
  return { bytes, bits };
}
