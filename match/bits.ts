export class BitError extends Error {}

const bytesOf = (v: number | Uint8Array) => typeof v === "number" ? new Uint8Array([v & 0xff]) : v;

export class BitWriter {
  private data: Uint8Array;
  bits = 0;
  private maxBits: number;
  private resizable: boolean;
  failed = false;

  constructor(maxBits = 256, resizable = true) {
    this.maxBits = Math.max(0, maxBits);
    this.resizable = resizable;
    this.data = new Uint8Array(Math.ceil(this.maxBits / 8));
  }

  private ensure(n: number) {
    if (this.bits + n <= this.maxBits) return true;
    if (!this.resizable) { this.failed = true; return false; }
    this.maxBits = Math.max(this.maxBits * 2, this.bits + n);
    const next = new Uint8Array(Math.ceil(this.maxBits / 8));
    next.set(this.data);
    this.data = next;
    return true;
  }

  bit(value: boolean | number) {
    if (!this.ensure(1)) throw new BitError("writer overflow");
    if (value) this.data[this.bits >> 3] |= 1 << (this.bits & 7);
    else this.data[this.bits >> 3] &= ~(1 << (this.bits & 7));
    this.bits += 1;
  }

  bitsFrom(src: Uint8Array, count = src.length * 8) {
    if (count <= 0) return;
    if (!this.ensure(count)) throw new BitError("writer overflow");
    for (let i = 0; i < count; i++) {
      const value = (src[i >> 3] >> (i & 7)) & 1;
      if (value) this.data[(this.bits + i) >> 3] |= 1 << ((this.bits + i) & 7);
      else this.data[(this.bits + i) >> 3] &= ~(1 << ((this.bits + i) & 7));
    }
    this.bits += count;
  }

  bytes(src: Uint8Array) { this.bitsFrom(src, src.length * 8); }

  uint8(value: number) { this.bitsFrom(Uint8Array.of(value & 0xff), 8); }
  uint16(value: number) {
    const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value & 0xffff, true); this.bitsFrom(b);
  }
  uint32(value: number) {
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value >>> 0, true); this.bitsFrom(b);
  }  int8(value: number) { this.bitsFrom(Uint8Array.of(value & 0xff), 8); }
  int16(value: number) {
    const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, value | 0, true); this.bitsFrom(b);
  }
  int32(value: number) {
    const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value | 0, true); this.bitsFrom(b);
  }
  uint64(value: bigint | number) {
    const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value) & 0xffffffffffffffffn, true); this.bitsFrom(b);
  }
  float(value: number) {
    const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); this.bitsFrom(b);
  }
  double(value: number) {
    const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value, true); this.bitsFrom(b);
  }

  wrapped(value: number, max: number) {
    const n = Math.ceil(Math.log2(max));
    const src = new Uint8Array(n <= 32 ? 4 : 8);
    const view = new DataView(src.buffer);
    if (n <= 32) view.setUint32(0, value >>> 0, true);
    else view.setBigUint64(0, BigInt(value) & ((1n << BigInt(n)) - 1n), true);
    this.bitsFrom(src, n);
  }

  serializeInt(value: number, max: number) {
    // UE FBitWriter::SerializeInt is FIXED width: ceil(log2(max)) bits, LSB first.
    this.wrapped(value, Math.max(2, max));
  }

  /** UE FBitWriter::SerializeInt as actually implemented: LSB-first, stops once NewValue + Mask >= max,
   *  so the width depends on the value as well as the max (RPC field headers use this). */
  serializeIntVar(value: number, max: number) {
    let newValue = 0;
    for (let mask = 1; newValue + mask < max && mask; mask *= 2) {
      const b = (value & mask) !== 0;
      this.bit(b);
      if (b) newValue += mask;
    }
  }

  packed32(value: number, minBytes = 1) {
    // UE SerializeIntPacked: 7 data bits shifted left one, continuation as bit 0.
    const words: number[] = [];
    let v = value >>> 0;
    do {
      const chunk = v & 0x7f;
      v >>>= 7;
      words.push((chunk << 1) | (v !== 0 ? 1 : 0));
    } while (v !== 0);
    while (words.length < minBytes) words.push(0);
    this.bytes(Uint8Array.from(words));
  }

  packed64(value: bigint | number) {
    // Same UE convention as packed32: data<<1, continuation bit 0.
    const words: number[] = [];
    let v = BigInt(value) & 0xffffffffffffffffn;
    do {
      const chunk = Number(v & 0x7fn);
      v >>= 7n;
      words.push((chunk << 1) | (v !== 0n ? 1 : 0));
    } while (v !== 0n);
    this.bytes(Uint8Array.from(words));
  }

  fstring(value: string) {
    if (!value) { this.int32(0); return; }
    if (/^[\x01-\x7f]*$/.test(value)) {
      const data = new TextEncoder().encode(value + "\0");
      this.int32(data.length);
      this.bytes(data);
    } else {
      this.int32(-(value.length + 1));
      for (let i = 0; i < value.length; i++) this.uint16(value.charCodeAt(i));
      this.uint16(0);
    }
  }

  buffer(): Uint8Array {
    if (this.failed) throw new BitError("writer in error state");
    return this.data.subarray(0, Math.ceil(this.bits / 8));
  }  /** FName on the wire (StaticSerializeName): bHardcoded bit 0 + string + number suffix. */
  fname(value: string, number = 0) {
    this.bit(false);
    this.fstring(value);
    this.int32(number);
  }
}

export class BitReader {
  pos = 0;
  private numBits: number;

  constructor(private buffer: Uint8Array, numBits = buffer.length * 8) {
    this.numBits = Math.min(numBits, buffer.length * 8);
  }

  get bitsLeft() { return this.numBits - this.pos; }
  get atEnd() { return this.pos >= this.numBits; }

  bit(): boolean {
    if (this.pos >= this.numBits) throw new BitError("reader overflow");
    const value = ((this.buffer[this.pos >> 3] >> (this.pos & 7)) & 1) !== 0;
    this.pos += 1;
    return value;
  }

  bitsFrom(n: number): Uint8Array {
    if (n < 0 || n > this.bitsLeft) throw new BitError(`reader overflow (${n} left ${this.bitsLeft})`);
    const out = new Uint8Array(Math.ceil(n / 8));
    for (let i = 0; i < n; i++) {
      if ((this.buffer[(this.pos + i) >> 3] >> ((this.pos + i) & 7)) & 1) out[i >> 3] |= 1 << (i & 7);
    }
    this.pos += n;
    return out;
  }

  uint8() { return this.bitsFrom(8)[0]!; }
  uint16() { return new DataView(this.bitsFrom(16).buffer).getUint16(0, true); }
  uint32() { return new DataView(this.bitsFrom(32).buffer).getUint32(0, true); }
  int32() { return new DataView(this.bitsFrom(32).buffer).getInt32(0, true); }
  uint64() { return new DataView(this.bitsFrom(64).buffer).getBigUint64(0, true); }
  float() { return new DataView(this.bitsFrom(32).buffer).getFloat32(0, true); }
  double() { return new DataView(this.bitsFrom(64).buffer).getFloat64(0, true); }

  wrapped(max: number) {
    const n = Math.ceil(Math.log2(max));
    const raw = this.bitsFrom(n);
    const padded = new Uint8Array(n <= 32 ? 4 : 8);
    padded.set(raw);
    if (n <= 32) return new DataView(padded.buffer).getUint32(0, true);
    return Number(new DataView(padded.buffer).getBigUint64(0, true));
  }

  serializeInt(max: number) {
    // UE FBitReader::SerializeInt is FIXED width: ceil(log2(max)) bits, LSB first.
    return this.wrapped(Math.max(2, max));
  }

  /** Reader side of BitWriter.serializeIntVar (RPC field headers). */
  serializeIntVar(max: number) {
    let value = 0;
    for (let mask = 1; value + mask < max && mask; mask *= 2) if (this.bit()) value += mask;
    return value;
  }

  packed32() {
    let result = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.uint8();
      result += (b >>> 1) * 2 ** shift;
      if (!(b & 1)) break;
      shift += 7;
    }
    return result >>> 0;
  }

  packed64() {
    let result = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.uint8();
      result |= BigInt(b >>> 1) << shift;
      if (!(b & 1)) break;
      shift += 7n;
    }
    return result;
  }

  fstring(): string {
    const len = this.int32();
    if (len === 0) return "";
    if (len === -2147483648) throw new BitError("invalid FString length");
    const wide = len < 0;
    const count = Math.abs(len);
    const data = this.bitsFrom(count * (wide ? 16 : 8));
    if (data[data.length - 1] !== 0 || (wide && data[data.length - 2] !== 0)) {
      throw new BitError("FString is not null terminated");
    }
    return new TextDecoder(wide ? "utf-16le" : "utf-8").decode(data.subarray(0, data.length - (wide ? 2 : 1)));
  }

  skip(n: number) { if (n > this.bitsLeft) throw new BitError("skip overflow"); this.pos += n; }
  remaining(): Uint8Array { return this.bitsFrom(this.bitsLeft); }
}

export function stripTrailingOnes(data: Uint8Array): number {
  let count = data.length * 8;
  while (count > 0) {
    const byte = data[(count - 1) >> 3]!;
    if (byte & (1 << ((count - 1) & 7))) break;
    count -= 1;
  }
  return Math.max(0, count - 1);
}
