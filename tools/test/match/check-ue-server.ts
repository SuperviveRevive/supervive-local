import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import dgram from "node:dgram";
import {
  BitReader, BitWriter, NMT, EChannelName,
  parseHandshake, makeChallenge, isHandshake, stripHandler, addHandler,
  finalizePacket, readBunch, writeBunch, controlMessage,
  readHello, writeChallenge, writeWelcome, readUniqueNetIdRepl,
  newBunch, SequenceNumber, NetPacketNotify,
} from "../../../match/protocol.ts";
import { UEGameServer } from "../../../match/server.ts";
import { NetClassLayout } from "../../../match/netlayout.ts";

const PORT = Number(process.env.UE_TEST_PORT || 29777);
const HTTP_PORT = PORT + 1;
const HOST = "127.0.0.1";

let mockTimestamp = 100.0;
function buildHandshake(opts: {
  travelCount?: number; clientId?: number; minVersion?: number; version?: number;
  packetType?: number; networkVersion?: number; runtimeFeatures?: number;
  realPrefix?: Uint8Array; cookie?: Uint8Array;
} = {}) {
  // UE5 stateless handshake layout (matches the live 2.0.4 client capture):
  // [travel 2b][clientId 3b][bHandshakePacket][restarted][minVer u8][ver u8][pktType u8]
  // [sentCount u8][netver u32 LE][features u16 LE][secretId 1b][ts f64][cookie 20B][pad 8-16B][term 1]
  const w = new BitWriter(512);
  if (opts.realPrefix) w.bytes(opts.realPrefix);
  w.serializeInt(opts.travelCount ?? 0, 4);
  w.serializeInt(opts.clientId ?? 0, 8);
  w.bit(true); // handshake packet
  w.bit(false); // not restarted
  w.uint8(opts.minVersion ?? 3);
  w.uint8(opts.version ?? 4);
  w.uint8(opts.packetType ?? 0);
  w.uint8(1); // sent handshake packet count
  w.uint32(opts.networkVersion ?? 1679804720);
  w.uint16(opts.runtimeFeatures ?? 0);
  w.bit(0); // secretId
  w.double(opts.packetType === 2 ? mockTimestamp : 0.0);
  w.bytes(opts.cookie ?? Buffer.alloc(20, 0xab));
  w.bytes(Buffer.alloc(12)); // random padding in real packets
  w.bit(true); // termination bit
  return w.buffer();
}

class MockClient {
  socket = dgram.createSocket("udp4");
  packets: Uint8Array[] = [];
  notify = new NetPacketNotify();
  sentSeq = 1;
  private onMessage?: (data: Uint8Array) => void;

  constructor(private serverPort: number) {}

  async start() {
    this.socket.on("message", (msg) => {
      const data = new Uint8Array(msg);
      this.packets.push(data);
      this.onMessage?.(data);
    });
    await new Promise<void>((res) => this.socket.bind(0, HOST, res));
    this.notify.init(1, 1);
  }

  stop() { this.socket.close(); }

  send(data: Uint8Array) {
    this.socket.send(Buffer.from(data), this.serverPort, HOST);
  }

  waitFor(predicate: (data: Uint8Array) => boolean, timeoutMs = 3000): Promise<Uint8Array> {
    const existing = this.packets.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onMessage = undefined;
        reject(new Error("timeout waiting for packet"));
      }, timeoutMs);
      this.onMessage = (data) => {
        if (predicate(data)) {
          clearTimeout(timer);
          this.onMessage = undefined;
          resolve(data);
        }
      };
    });
  }

  isControl(data: Uint8Array, type: number): boolean {
    const stripped = stripHandler(data);
    if (!stripped) return false;
    const bits = stripped.reader.bitsLeft;
    const raw = stripped.reader.bitsFrom(bits);
    const r = new BitReader(raw, bits);
    try {
      const h = new NetPacketNotify().readHeader(r);
      if (r.bit()) {
        r.serializeInt(1024);
        if (r.bit()) r.uint8();
      }
      while (r.bitsLeft >= 10) {
        const bunch = readBunch(r, h.seq.value);
        if (bunch.chIndex === 0 && bunch.bits >= 8) {
          const p = new BitReader(bunch.data, bunch.bits);
          if (p.uint8() === type) return true;
        }
      }
    } catch {}
    return false;
  }

  sendControl(type: number, write?: (w: BitWriter) => void) {
    const w = new BitWriter(512);
    this.notify.writeHeader(w);
    w.bit(true);
    w.serializeInt(80, 1024);
    w.bit(false);
    const bunch = newBunch();
    bunch.chIndex = 0;
    bunch.bReliable = true;
    bunch.chNameIndex = EChannelName.Control;
    const payload = new BitWriter(512);
    payload.uint8(type);
    write?.(payload);
    bunch.data = payload.buffer();
    bunch.bits = payload.bits;
    writeBunch(bunch, w);
    const inner = finalizePacket(w);
    const outer = addHandler(inner, 2, 7, w.bits);
    this.notify.commitAndIncrement();
    this.send(outer);
  }
}

async function main() {
  const server = new UEGameServer({
    udpPort: PORT,
    httpPort: HTTP_PORT,
    bindHost: HOST,
    networkVersion: 1679804720,
    mapName: "/Game/Loki/Maps/Battlefield/LVL_Battlefield",
    gameName: "LokiGameMode",
    backendUrl: "http://127.0.0.1:1",
    register: false,
    log: () => {},
  });
  await server.start();

  const client = new MockClient(PORT);
  await client.start();

  try {
    // 1. stateless handshake
    const initial = buildHandshake({ packetType: 0 });
    assert.equal(isHandshake(initial), true);
    client.send(initial);
    const challenge = await client.waitFor((d) => isHandshake(d) && parseHandshake(d).timestamp > 0);
    const hc = parseHandshake(challenge);
    assert.equal(hc.cookie.length, 20);
    assert.ok(hc.cookie.some((b) => b !== 0), "server challenge cookie present");
    mockTimestamp = hc.timestamp; // echo the server's challenge timestamp like the real client
    const response = buildHandshake({ packetType: 2, clientId: hc.clientId, travelCount: hc.travelCount, cookie: hc.cookie });
    client.send(response);
    const ack = await client.waitFor((d) => isHandshake(d) && parseHandshake(d).timestamp === -1);
    assert.equal(isHandshake(ack), true);

    // 2. NMT Hello -> Challenge
    const helloPacket = controlMessage(NMT.Hello, (w) => {
      w.uint8(1);
      w.uint32(1679804720);
      w.fstring("test-token");
      w.uint16(0);
    });
    client.sendControl(NMT.Hello, (w) => {
      w.uint8(1); w.uint32(1679804720); w.fstring("test-token"); w.uint16(0);
    });
    const challengeMsg = await client.waitFor((d) => client.isControl(d, NMT.Challenge));
    const cs = stripHandler(challengeMsg)!;
    const cbBits = cs.reader.bitsLeft;
    const cb = cs.reader.bitsFrom(cbBits);
    const cr = new BitReader(cb, cbBits);
    const h = new NetPacketNotify().readHeader(cr);
    if (cr.bit()) { cr.serializeInt(1024); if (cr.bit()) cr.uint8(); }
    let found = false;
    while (cr.bitsLeft >= 10) {
      const bunch = readBunch(cr, h.seq.value);
      if (bunch.chIndex === 0 && bunch.bits >= 8) {
        const p = new BitReader(bunch.data, bunch.bits);
        if (p.uint8() === NMT.Challenge) {
          assert.ok(p.fstring().length > 0, "NMT.Challenge carries one challenge FString");
          found = true;
          break;
        }
      }
    }
    assert.ok(found, "NMT.Challenge echo missing");

    // 3. NMT Login -> Welcome
    client.sendControl(NMT.Login, (w) => {
      w.fstring("0");
      w.fstring("127.0.0.1:7777?userId=player1&MatchId=test-match");
      w.uint8(2 | (3 << 3)); // encoded, STEAM
      w.uint8(9);
      w.bytes(Buffer.from("76561198", "utf8"));
      w.fstring("NULL");
    });
    const welcomeMsg = await client.waitFor((d) => client.isControl(d, NMT.Welcome));
    assert.ok(welcomeMsg.length > 0);

    // 4. NMT Join -> spawn bunches
    client.sendControl(NMT.Join);
    await client.waitFor((d) => {
      const s = stripHandler(d);
      if (!s) return false;
      const bits = s.reader.bitsLeft;
      const raw = s.reader.bitsFrom(bits);
      const r = new BitReader(raw, bits);
      try {
        const hh = new NetPacketNotify().readHeader(r);
        if (r.bit()) { r.serializeInt(1024); if (r.bit()) r.uint8(); }
        while (r.bitsLeft >= 10) {
          const bunch = readBunch(r, hh.seq.value);
          if (bunch.bOpen && bunch.chIndex > 0) return true;
        }
      } catch {}
      return false;
    });

    // 5. HTTP status
    const statusRes = await fetch(`http://${HOST}:${HTTP_PORT}/status`);
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.listening, true);
    assert.ok(status.connections >= 1);
    assert.ok(status.players.length >= 1);

    // 6. netlayout handles from the 2.0.4 rep layout (AActor carries two extra handles, so GameState/PlayerState shift by one;
    //    fast-array structs take no handle)
    const layout = new NetClassLayout();
    assert.equal(layout.handle("Character", "ReplicatedMovement"), 12);
    assert.equal(layout.handle("Character", "RemoteViewPitch"), 17);
    assert.equal(layout.handle("Character", "ServerMovePacked"), -1); // RPC lives on CharacterMovementComponent, not in the property dump
    assert.equal(layout.handle("GameStateBase", "ReplicatedWorldTimeSecondsDouble"), 20);
    assert.equal(layout.handle("GameState", "MatchState"), 21);
    assert.equal(layout.handle("GameState", "ElapsedTime"), 22);
    assert.equal(layout.handle("PlayerState", "PlayerNamePrivate"), 27);
    assert.equal(layout.handle("AbilitySystemComponent", "ReplicatedPredictionKeyMap.PredictionKeys"), -1);
    assert.equal(layout.handle("LokiGameStateBase", "GameModeType"), -1); // derived layout refuses unverified handles

    console.log("UE server: handshake, control login, spawn, status and net layout pass");
  } finally {
    client.stop();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
