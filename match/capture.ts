// Basecamps (bonfires) on LVL_SkylandsBreach: BP_CapturePoint_C level actors (native LokiCapturePoint), captured by standing on them.
//
// Evidence (retail Breach flows 7038 + 7039; fixtures the capture decoder (not shipped) -> capture fixtures (not shipped); gate
// tools/check-capture.ts; layout docs/BREACH-MAP-FEATURES.md §3.3):
//   * Capturing is NOT an RPC. In 7038/7039 no client ever sent ServerExecuteUsableInteraction on a capture point; the only C->S
//     traffic naming one is a ServerStopUsableInteraction (result 3) right after shop buys at the bonfire (7038 t=557.1) - E at a
//     bonfire opens the basecamp shop client-side. Our live logs match: only "stop ignored" on BP_CapturePoint_C. Progress is the
//     server's own overlap count, replicated on the capture point actor.
//   * Wire (all retail payloads re-encode bit-identically, check-capture): a level-placed actor (odd NetGUID exported by path under
//     PersistentLevel, flags 7, checksum 4292259300), opened when relevant with SerializeNewActor = the GUID only. Actor block:
//     h5 RemoteRole 1 (3 bits), h12 ReplicatedMovement (box form: whole-unit loc, byte rotation), h14 Role 3, h17 ProgressingTeam
//     int32 (-1 = none), h18 BonfireCaptureEndTime float (server world time), h19 NumPlayersProgressing int32 (h20/h21 Incoming
//     Recalls/Respawns arrays are not sent here). Stable subobject LokiTeamComponent: [0][h3 uint8 team][0], 255 = no owner; the
//     open carries it as an empty block.
//   * Timing (7038, server time = capture t + 9.797): one player -> end = now + 9.96 (10 s); n players progress at 1 + (n-1)/3 per
//     second (n=2: 1.33, n=3: 1.67; every h18 re-send on an h19 change matches to < 0.02 s); when n drops to 0 the progress decays at
//     ~1/s and h18 is sent NEGATIVE = -(time it reaches 0); at 0 -> h17 -1, h18 0. Completion -> h17 -1, h18 0 + LokiTeamComponent
//     team = the capturing team. A team holds one basecamp: when team 0 captured 743 (t=506.8) its old one (815) went to team 255 in
//     the same instant (loki-layout bGameAllowMultipleCapturePoints defaults off).
//   * Positions: 11 from the retail opens (exact); the other 13 from the retail-world BP_UAVOracle_CapturePoint actor that sits at
//     local (259, -148, +35) of its capture point with yaw = capture yaw - 1 rad (fit on the 11 known: error <= 2 uu).
//
// NOT evidence (ours, marked): the capture radius (LOKI_CAPTURE_RADIUS, the client counts the bonfire's overlap volume - unknown),
// contesting (an enemy on the point does not stop progress here), owner loss on a team wipe, opening every point on join instead of
// by relevancy, the capture reward (none: no wallet/XP change was seen at a capture), respawn-at-basecamp (not wired into the sim).
// The module is class-agnostic (CaptureClass): other LokiCapturePoint maps / modes can pass their own point list.
// UNVERIFIED IN-CLIENT.
import { BitReader, BitWriter } from "./bits.ts";
import type { GuidExport } from "./protocol.ts";
import * as Gas from "./gas.ts";
import * as Loot from "./loot.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
export const CAPTURE_ENABLED = env("LOKI_CAPTURE", "1") !== "0";
export const CAPTURE_RADIUS = Number(env("LOKI_CAPTURE_RADIUS", "650"));
export const CAPTURE_SECONDS = Number(env("LOKI_CAPTURE_SECONDS", "10"));
export const CAPTURE_ONE_PER_TEAM = env("LOKI_CAPTURE_ONE_PER_TEAM", "1") !== "0";
export const CAPTURE_WIPE_RESET = env("LOKI_CAPTURE_WIPE_RESET", "0") === "1";   // guess, off: sim respawns empty a team briefly
export const CAPTURE_BOTS = env("LOKI_CAPTURE_BOTS", "1") !== "0";
export const CH_CAPTURE = Number(env("LOKI_CAPTURE_CH", "870"));   // 870-893 (24 points)
export const NO_TEAM = 255;

// ------------------------------------------------------------------ GUIDs (0xA8800-0xA8fff; disjoint from AGENTS.md's map)
/** Own capture-point GUIDs when the retail world replay did not name the path (static/odd, exported by path). */
export const ownPointGuid = (i: number) => 0xa8c01n + BigInt(i) * 4n;
/** LokiTeamComponent of point i (static/odd, stably named, outer = the point). */
export const teamCompGuid = (i: number) => 0xa8801n + BigInt(i) * 4n;
export const POINT_CHECKSUM = 4292259300;   // retail export checksum of every BP_CapturePoint_C_* (flags 7)

// ------------------------------------------------------------------ wire
export const CP_H = { RemoteRole: 5, ReplicatedMovement: 12, Role: 14, ProgressingTeam: 17, BonfireCaptureEndTime: 18,
  NumPlayersProgressing: 19 } as const;
export interface PointProps { remoteRole?: number; movement?: Loot.BoxMovement; role?: number; progressingTeam?: number; endTime?: number;
  numProgressing?: number }
export function encodePoint(p: PointProps): BitWriter {
  const w = new BitWriter(256);
  w.bit(false);
  if (p.remoteRole !== undefined) { w.packed32(CP_H.RemoteRole); Gas.writeBitsN(w, p.remoteRole, 3); }
  if (p.movement) { w.packed32(CP_H.ReplicatedMovement); Loot.writeBoxMovement(w, p.movement); }
  if (p.role !== undefined) { w.packed32(CP_H.Role); Gas.writeBitsN(w, p.role, 3); }
  if (p.progressingTeam !== undefined) { w.packed32(CP_H.ProgressingTeam); w.int32(p.progressingTeam); }
  if (p.endTime !== undefined) { w.packed32(CP_H.BonfireCaptureEndTime); w.float(p.endTime); }
  if (p.numProgressing !== undefined) { w.packed32(CP_H.NumPlayersProgressing); w.int32(p.numProgressing); }
  w.packed32(0);
  return w;
}
export function decodePoint(buf: Uint8Array, bits: number): PointProps & { bitsRead: number } {
  const r = new BitReader(buf, bits);
  if (r.bit()) throw new Error("checksum bit set");
  const p: PointProps = {};
  for (let h = r.packed32(); h; h = r.packed32()) {
    switch (h) {
      case CP_H.RemoteRole: p.remoteRole = Gas.readBitsN(r, 3); break;
      case CP_H.ReplicatedMovement: p.movement = Loot.readBoxMovement(r); break;
      case CP_H.Role: p.role = Gas.readBitsN(r, 3); break;
      case CP_H.ProgressingTeam: p.progressingTeam = r.int32(); break;
      case CP_H.BonfireCaptureEndTime: p.endTime = r.float(); break;
      case CP_H.NumPlayersProgressing: p.numProgressing = r.int32(); break;
      default: throw new Error(`unsupported capture point handle ${h}`);
    }
  }
  return { ...p, bitsRead: r.pos };
}
/** LokiTeamComponent: [0][h3 uint8][0] (same as interact.ts's death-box LokiTeam). */
export function encodeTeam(team: number): BitWriter { const w = new BitWriter(32); w.bit(false); w.packed32(3); w.uint8(team & 0xff); w.packed32(0); return w; }

/** Open-bunch body of a capture point (retail 7038 opens): SerializeNewActor of a static actor = the GUID only, the actor block, then
 *  the LokiTeamComponent stable block (empty without an owner, as retail's open). */
export function writePointOpen(w: BitWriter, h: Pick<CapHost<CapConn>, "writeActorBlock" | "writeStableBlock">, guid: bigint, actor: BitWriter,
  teamGuid: bigint, team: number | null) {
  w.packed64(guid);
  h.writeActorBlock(w, actor, true);
  h.writeStableBlock(w, teamGuid, team !== null, team !== null ? encodeTeam(team) : null);
}

// ------------------------------------------------------------------ timing model (retail 7038, see header)
export const progressRate = (n: number) => (n <= 0 ? 0 : 1 + (n - 1) / 3);
/** h18 for a state: n > 0 -> when the capture completes; n = 0 -> -(when the decaying progress reaches 0). */
export const endTimeFor = (now: number, progress: number, n: number, total = CAPTURE_SECONDS) =>
  n > 0 ? now + Math.max(0, total - progress) / progressRate(n) : -(now + Math.max(0, progress));

// ------------------------------------------------------------------ points
export interface PointDef { name: string; retailGuid: number; loc: Loot.V3; yaw: number; source: "retail" | "oracle" }
export interface CaptureClass { pkg: string; prefix: string; points: PointDef[] }
const P = (name: string, retailGuid: number, loc: Loot.V3, yaw: number, source: "retail" | "oracle"): PointDef => ({ name, retailGuid, loc, yaw, source });
/** The 24 BP_CapturePoint_C of LVL_SkylandsBreach's persistent level (retail GUIDs of flows 7038/7039 = retail-world-breach). */
export const BREACH_POINTS: CaptureClass = { pkg: "/Game/Loki/Core/CapturePoint/BP_CapturePoint", prefix: "BP_CapturePoint_C_", points: [
  P("UAID_047C16730311108C02_1883285647_d5cc55840c598c89", 723, [32145, 8944, 0], 10.0, "oracle"),
  P("UAID_047C16730311118C02_1426810191_bcc378f2219e6355", 727, [7293, 45251, 300], 344.5, "retail"),
  P("UAID_047C16730311359002_1536846143", 731, [-57131, -4091, 300], 0.0, "oracle"),
  P("UAID_047C16730311369002_1313807322", 735, [-35650, -6040, 160], 0.0, "retail"),
  P("UAID_2CF05DDD12A8335802_1810729020_067333f7bfe65090", 739, [-22010, -18597, 300], 29.5, "retail"),
  P("UAID_2CF05DDD12A8745A02_1599168374_45cf52ce66c02260", 743, [-13075, 33761, 450], 351.6, "retail"),
  P("UAID_2CF05DDD12A8B54F02_1713215800_59e29c237cbc31fa", 747, [25506, -11214, 150], 14.1, "retail"),
  P("UAID_7C50792FB9E3BAA102_2056804271", 751, [-6974, 50818, 40], 0.0, "retail"),
  P("UAID_7C50792FB9E3D9A002_1128209742", 755, [12052, 33482, 13], 0.0, "oracle"),
  P("UAID_7C507962E1791C6B02_1808288654_5632bafc420af2f3", 759, [-30426, 15523, 0], 331.9, "retail"),
  P("UAID_7C507962E1794B4C02_1799527028_a2046cfbf5cabf5b", 763, [-32557, -32454, 0], 0.0, "oracle"),
  P("UAID_7C507962E1794C4C02_1124152218_5c14c06bd1427a55", 767, [-13675, -46693, 150], 2.5, "oracle"),
  P("UAID_7C507962E1794C4C02_1360478230_ff1588e6915931d4", 771, [20560, -46282, 450], 9.8, "retail"),
  P("UAID_7C507962E1794D4C02_1370543424_9e21835db6a75f67", 775, [45283, -29270, 150], 12.5, "oracle"),
  P("UAID_7C507962E1794D4C02_2072010451_898caad395be4393", 779, [60539, -14814, 600], 0.5, "oracle"),
  P("UAID_7C507962E1794E4C02_1395330651_0d41b100fa02b26d", 783, [39758, -13053, 149], 0.0, "oracle"),
  P("UAID_7C507962E179504C02_1478538041_515688752b85d83a", 787, [1800, -17133, 300], 15.5, "retail"),
  P("UAID_7C507962E1797A4D02_1672605296_8d7574b201ec1b8c", 791, [-10744, -7786, 0], 23.9, "retail"),
  P("UAID_7C507962E1797A4D02_1935004324_2d21b8bc4db0bcd2", 795, [55499, 13422, 0], 28.0, "oracle"),
  P("UAID_7C507962E1797B4D02_2111276582_068c5e42fd4a1dc9", 799, [39230, 26081, 300], 24.2, "oracle"),
  P("UAID_7C507962E1797C4D02_1275372763_f470fd3681c72a81", 803, [30804, 48368, 150], 9.6, "oracle"),
  P("UAID_7C507962E1797C4D02_1982827822_ee68a858f465410a", 807, [-37118, 52583, 300], 354.8, "oracle"),
  P("UAID_7C507962E1797D4D02_1684681030_690b5b3c224c1401", 811, [19782, 25151, 154], 12.3, "oracle"),
  P("UAID_7C507962E1797E4D02_1158513233_478fe5bfe93da1b3", 815, [-1602, 13443, 300], 357.2, "retail"),
] };
export const pointMovement = (d: PointDef): Loot.BoxMovement => ({ flags: 0, loc: d.loc, rot: [0, Loot.yawByte(d.yaw), 0], vel: [0, 0, 0] });

// ------------------------------------------------------------------ the manager
export interface CapConn extends Loot.LootConn {}
export interface CapUnit { id: string; team: number; x: number; y: number; z: number; alive: boolean; isBot?: boolean }
export interface CapHost<C extends CapConn> {
  log(msg: string): void;
  sendBunch(conn: C, body: (w: BitWriter) => void, opts: Loot.SendOpts): void;
  writeActorBlock(w: BitWriter, payload: BitWriter, hasRep: boolean): void;
  writeStableBlock(w: BitWriter, guid: bigint, hasRep: boolean, payload: BitWriter | null): void;
  conns(): C[];
  /** PersistentLevel's NetGUID on the wire (retail-pinned when the retail world replay runs). */
  levelGuid(): bigint;
  /** The NetGUID the retail world replay uses for a level path (`<map>.<World>.PersistentLevel.<name>`), if any. */
  retailGuid(name: string): bigint | undefined;
  worldTime(): number;
  units(): CapUnit[];
}
interface Point { i: number; def: PointDef; guid: bigint; ch: number; owner: number; team: number; progress: number; n: number;
  sent: { team: number; n: number; end: number } }

export class CaptureManager<C extends CapConn> {
  points: Point[] = [];
  private onBase = new Map<string, { i: number; at: number }>();
  stats = { started: 0, captured: 0, decayed: 0, released: 0 };
  constructor(private host: CapHost<C>, private cls: CaptureClass = BREACH_POINTS) {}

  reset() { this.points = []; this.onBase.clear(); this.stats = { started: 0, captured: 0, decayed: 0, released: 0 }; }
  status() { return { points: this.points.length, owned: this.points.filter((p) => p.owner !== NO_TEAM).length, ...this.stats }; }

  private setup() {
    if (this.points.length) return;
    this.points = this.cls.points.map((def, i) => {
      const rg = this.host.retailGuid(this.cls.prefix + def.name);
      return { i, def, guid: rg ?? ownPointGuid(i), ch: CH_CAPTURE + i, owner: NO_TEAM, team: -1, progress: 0, n: 0, sent: { team: -1, n: 0, end: 0 } };
    });
  }

  /** Open every point on a connection (Breach maps only; server.ts decides). Retail opens them by relevancy. */
  spawnFor(conn: C) {
    if (!CAPTURE_ENABLED) return;
    this.setup();
    for (const p of this.points) this.openPoint(conn, p);
    this.host.log(`[capture] ${this.points.length} basecamps on a connection (ch ${CH_CAPTURE}-${CH_CAPTURE + this.points.length - 1})`);
  }
  private openPoint(conn: C, p: Point) {
    if (conn.channels.has(p.ch)) return;
    conn.channels.add(p.ch);
    const ex: GuidExport[] = [];
    if (!conn.exportedGuids.has(p.guid)) {
      conn.exportedGuids.add(p.guid);
      ex.push({ guid: p.guid, path: this.cls.prefix + p.def.name, outer: this.host.levelGuid(), noLoad: true, checksum: POINT_CHECKSUM });
    }
    const tg = teamCompGuid(p.i);
    if (!conn.exportedGuids.has(tg)) { conn.exportedGuids.add(tg); ex.push({ guid: tg, path: "LokiTeamComponent", outer: p.guid, noLoad: true }); }
    const now = this.host.worldTime();
    const actor = encodePoint({ remoteRole: 1, movement: pointMovement(p.def), role: 3, progressingTeam: p.team,
      endTime: p.team >= 0 ? endTimeFor(now, p.progress, p.n) : 0, numProgressing: p.n });
    this.host.sendBunch(conn, (w) => writePointOpen(w, this.host, p.guid, actor, tg, p.owner !== NO_TEAM ? p.owner : null),
      { ch: p.ch, open: true, reliable: true, exports: ex });
  }
  private broadcast(p: Point, actor: PointProps | null, team?: number) {
    const a = actor ? encodePoint(actor) : null;
    for (const conn of this.host.conns()) {
      if (!conn.channels.has(p.ch)) continue;
      this.host.sendBunch(conn, (w) => {
        if (a) this.host.writeActorBlock(w, a, true);
        if (team !== undefined) this.host.writeStableBlock(w, teamCompGuid(p.i), true, encodeTeam(team));
      }, { ch: p.ch, reliable: true });
    }
  }

  /** A client's MovementBase names a capture point (or one of its components): the player stands on it. */
  resolveBase(id: string, ref: Loot.BaseRef | undefined): Point | null {
    if (!ref || !this.points.length) return null;
    const g = ref.guid === 1n ? ref.outerGuid : ref.guid;
    const p = this.points.find((x) => x.guid === g || teamCompGuid(x.i) === g || (ref.path ?? "").includes(x.def.name));
    if (p) this.onBase.set(id, { i: p.i, at: Date.now() });
    return p ?? null;
  }
  /** World position of a base-relative move on point p (box-style frame: root + yaw). */
  baseToWorld(p: Point, rel: Loot.V3): Loot.V3 { return Loot.boxRelToWorld(p.def.loc, Loot.yawByte(p.def.yaw), rel); }

  private inside(u: CapUnit, p: Point, nowMs: number) {
    const b = this.onBase.get(u.id);
    if (b && b.i === p.i && nowMs - b.at < 1000) return true;
    return Math.hypot(u.x - p.def.loc[0], u.y - p.def.loc[1]) <= CAPTURE_RADIUS && Math.abs(u.z - p.def.loc[2]) < 600;
  }

  private lastTick = 0;
  tick() {
    if (!CAPTURE_ENABLED || !this.points.length) return;
    const nowMs = Date.now();
    const dt = this.lastTick ? Math.min(0.5, (nowMs - this.lastTick) / 1000) : 0;
    this.lastTick = nowMs;
    if (dt <= 0) return;
    const now = this.host.worldTime();
    const units = this.host.units().filter((u) => u.alive && u.team >= 0 && (CAPTURE_BOTS || !u.isBot));
    if (CAPTURE_WIPE_RESET) {
      const liveTeams = new Set(this.host.units().filter((u) => u.alive).map((u) => u.team));
      for (const p of this.points) if (p.owner !== NO_TEAM && !liveTeams.has(p.owner)) this.release(p, "team gone");
    }
    for (const p of this.points) {
      const present = new Map<number, number>();
      for (const u of units) if (u.team !== p.owner && this.inside(u, p, nowMs)) present.set(u.team, (present.get(u.team) ?? 0) + 1);
      if (p.team < 0) {
        if (!present.size) continue;
        // ours: the team with the most players on the point starts it (retail contest rules unknown)
        const [team, n] = [...present.entries()].sort((a, b) => b[1] - a[1])[0]!;
        p.team = team; p.progress = 0; p.n = n;
        this.stats.started++;
        this.sendState(p, now, true);
        this.host.log(`[capture] team ${team} started basecamp ${p.i} (${p.def.name.slice(0, 24)}) n=${n}`);
        continue;
      }
      const n = present.get(p.team) ?? 0;
      if (n > 0) p.progress += dt * progressRate(n); else p.progress -= dt;
      if (n !== p.n) { p.n = n; this.sendState(p, now, false); }
      if (p.progress >= CAPTURE_SECONDS) this.complete(p, now);
      else if (p.progress <= 0 && n === 0) {
        p.team = -1; p.progress = 0;
        this.stats.decayed++;
        this.broadcast(p, { progressingTeam: -1, endTime: 0 });
        p.sent = { team: -1, n: 0, end: 0 };
      }
    }
  }
  private sendState(p: Point, now: number, start: boolean) {
    const end = endTimeFor(now, p.progress, p.n);
    this.broadcast(p, start ? { progressingTeam: p.team, endTime: end, numProgressing: p.n } : { endTime: end, numProgressing: p.n });
    p.sent = { team: p.team, n: p.n, end };
  }
  private complete(p: Point, now: number) {
    const team = p.team;
    if (CAPTURE_ONE_PER_TEAM) for (const o of this.points) if (o !== p && o.owner === team) this.release(o, `team ${team} took basecamp ${p.i}`);
    p.owner = team; p.team = -1; p.progress = 0;
    this.stats.captured++;
    this.broadcast(p, { progressingTeam: -1, endTime: 0 }, team);
    p.sent = { team: -1, n: p.n, end: 0 };
    this.host.log(`[capture] team ${team} captured basecamp ${p.i} (${p.def.name.slice(0, 24)}) at t=${now.toFixed(1)}`);
  }
  private release(p: Point, why: string) {
    p.owner = NO_TEAM;
    this.stats.released++;
    this.broadcast(p, null, NO_TEAM);
    this.host.log(`[capture] basecamp ${p.i} released (${why})`);
  }
  ownerOf(i: number) { return this.points[i]?.owner ?? NO_TEAM; }
  /** Basecamp owned by a team (for respawn / shop decisions by the caller), or null. */
  basecampOf(team: number) { const p = this.points.find((x) => x.owner === team); return p ? { i: p.i, loc: p.def.loc } : null; }
  forgetPlayer(id: string) { this.onBase.delete(id); }
}
