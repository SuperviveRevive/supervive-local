import { strict as assert } from "node:assert";
import { BitReader, BitWriter, NetPacketNotify, SequenceNumber, addHandler, finalizePacket, stripHandler } from "../../../match/protocol.ts";

for (let length = 0; length < 32; length++) {
  const w = new BitWriter();
  for (let i = 0; i < length; i++) w.bit(i % 3 === 0 && i < length - 1);
  const wire = addHandler(finalizePacket(w), 2, 5, w.bits);
  const decoded = stripHandler(wire);
  assert.ok(decoded);
  assert.equal(decoded.travelCount, 2);
  assert.equal(decoded.clientId, 5);
  for (let i = 0; i < length; i++) assert.equal(decoded.reader.bit(), i % 3 === 0 && i < length - 1);
  assert.equal(decoded.reader.bit(), true); // handler terminator
  assert.equal(decoded.reader.bitsLeft, 0);
}

const n = new NetPacketNotify();
n.init(1, 1);
const writer = new BitWriter();
n.writeHeader(writer);
n.commitAndIncrement();
let acknowledged = -1;
const peer = new NetPacketNotify();
peer.init(1, 1);
peer.ackSeq(new SequenceNumber(1));
const headerWriter = new BitWriter();
peer.writeHeader(headerWriter);
const header = n.readHeader(new BitReader(headerWriter.buffer(), headerWriter.bits));
assert.equal(n.update(header, (seq, delivered) => { if (delivered) acknowledged = seq.value; }), 1);
assert.equal(acknowledged, 1);
assert.equal(n.update(header, () => {}), 0);
console.log("UE protocol: framing across 32 bit offsets and independent peer acknowledgements pass" +
  " (real-client wire compatibility: see tools/ue-wire-test.py)");
