/**
 * The Breach drop (plane phase), wire-exact against the retail capture (recorded retail match traffic,
 * decoded by the capture decoder (not shipped)) and the flown VS-AI V14 design
 *, unreal-stub/Source/Loki/LokiDropPlane.h).
 *
 * Retail timeline (capture seconds, flow 7038; world time = capture + 9.8):
 *   1.92  join: ClientSetHUD, GameState CurrentPhase 3, ClientGotoState(Spectating=322) every ~2 s
 *  12.14  plane open (BP_DropPlane_Straight_C, Z 20000) + its stable LokiRideableComponent;
 *         GameState: PreventWeaponFire/Movement 1, SpawnSelectEndTime, CurrentPhase 4;
 *         every PlayerState drop component: CurrentRideableObject = plane rideable, DropPlane = plane;
 *         ClientGotoState(Spectating) then ClientGotoState(Playing=320)
 *  13.07  CurrentPhase 5 (SpawnReveal)
 *  14.14  CurrentPhase 7 (Combat), Prevent* 0, RoundStartTime / GameStartWorldTime; rideable PlayersInside
 *         (+ multicast idx 5 per rider); ClientGotoState(Playing) -> ClientRestart(hero) -> ClientSetRotation
 *  15.06  rideable bCanExit 1
 *  26.03  plane StartTimeSecs (world time); the server flies the plane at 3500 uu/s, ~30 Hz movement updates
 *  36.19  leader's component bDropLocationSelected 1 (ServerSetDropPodDestination)
 *  37.16  pod launch (ServerLaunchDropPod): BattleRoyalePlayerPhase Dropping(2), component DropPod/rideable
 *  50.20  landing: BattleRoyalePlayerPhase Combat(3), component bDropComplete 1, references null
 */
import { BitWriter } from "./bits.ts";
import { writeQuantizedVector, writeRotation } from "./protocol.ts";

export const PLANE_PKG = "/Game/Loki/Environment/DropPlane/DropPlaneVariants/BP_DropPlane_Straight";
export const PLANE_CLS = "BP_DropPlane_Straight_C";
export const DROP_COMP_PKG = "/Game/Loki/Core/GameModes/Components/Comp_PlayerState_DropPlane";
export const DROP_COMP_CLS = "Comp_PlayerState_DropPlane_C";
export const RIDEABLE_NAME = "LokiRideableComponent";

export const PLANE_Z = 20000;
export const PLANE_SPEED = 3500;
export const MAX_DROP_DISTANCE = 27500;
/** Retail's Breach path (flow 7039, V18c): 137,194 uu, 39.2 s at Speed. */
export const RETAIL_PATH = { start: [-37618.74, 58557.58, PLANE_Z], end: [15942.11, -67749.60, PLANE_Z] } as const;

/** Frames after the plane open (flow 7039: open 12.366, SpawnReveal 13.304, Combat 14.373, bCanExit 15.285). */
export const T_SPAWN_REVEAL = 0.938;
export const T_COMBAT = 2.007;
export const T_CAN_EXIT = 2.919;
/** BP_DropPlane_Base_C.PostCombatJumpDelay. */
export const T_START = 2.007 + 12.0;

export const PHASE = { FinishInit: 3, SpawnSelect: 4, SpawnReveal: 5, Lineup: 6, Combat: 7 } as const;
export const BR_PHASE = { Pregame: 1, Dropping: 2, Combat: 3 } as const;
export const NAME_PLAYING = 320;
export const NAME_SPECTATING = 322;

/** Comp_PlayerState_DropPlane_C ClassNetCache (14 fields: UActorComponent 2, ULokiPlayerDropPlaneComponent 5
 *  props + 4 functions sorted by name, Angelscript 2 functions, Blueprint DropPodLaunched). Max = fields + 1. */
export const COMP_FIELDS = {
  MulticastOnDropPodLaunched: 7, ServerLaunchDropPod: 8, ServerPassDropLeader: 9, ServerSetDropPodDestination: 10,
  ServerDetachPodFromLeader: 11, ServerUpdatePodMovement: 12, max: 15,
} as const;
/** Component replicated handles (retail-decoded: h3..h8). */
export const COMP_H = { bDropComplete: 3, bDropLocationSelected: 4, CurrentRideableObject: 5, DropPlane: 6, DropPod: 7, DropPodLaunched: 8 } as const;
/** LokiRideableComponent: 2 + 3 props + 3 multicasts; idx 5 is sent once per rider at the board. */
export const RIDE_H = { bCanExit: 3, PlayersInsideCount: 4, PlayersInside: 5 } as const;
export const RIDE_FIELDS = { BoardMulticast: 5, max: 9 } as const;
/** ALokiDropPlane handles after the ServerState splice (retail-decoded). AllowedJumpTime is BP_DropPlane_Base_C's double. */
export const PLANE_H = { RemoteRole: 5, ReplicatedMovement: 12, Role: 14, StartLocation: 17, EndLocation: 18, StartTimeSecs: 19, AllowedJumpTime: 20 } as const;

type V3 = readonly [number, number, number] | number[];

/** FRepMovement with the plane's RoundWholeNumber location (retail raw ints equal the world units). */
export function writePlaneMovement(w: BitWriter, loc: V3) {
  w.bitsFrom(Uint8Array.of(0), 4);
  writeQuantizedVector(w, loc[0]!, loc[1]!, loc[2]!, 1);
  writeRotation(w, 0, 0, 0, false);
  writeQuantizedVector(w, 0, 0, 0, 1);
}

function vec(w: BitWriter, v: V3) { w.double(v[0]!); w.double(v[1]!); w.double(v[2]!); }

/** The plane's actor block at its open (retail 589 bits). */
export function planeOpenPayload(start: V3, end: V3, allowedJumpTime: number): BitWriter {
  const p = new BitWriter(1024);
  p.bit(false); // bDoChecksum
  p.packed32(PLANE_H.RemoteRole); p.bitsFrom(Uint8Array.of(1), 3); // ROLE_SimulatedProxy
  p.packed32(PLANE_H.ReplicatedMovement); writePlaneMovement(p, start);
  p.packed32(PLANE_H.Role); p.bitsFrom(Uint8Array.of(3), 3); // ROLE_Authority
  p.packed32(PLANE_H.StartLocation); vec(p, start);
  p.packed32(PLANE_H.EndLocation); vec(p, end);
  p.packed32(PLANE_H.AllowedJumpTime); p.double(allowedJumpTime);
  p.packed32(0);
  return p;
}

export function planeMovePayload(loc: V3): BitWriter {
  const p = new BitWriter(160);
  p.bit(false);
  p.packed32(PLANE_H.ReplicatedMovement); writePlaneMovement(p, loc);
  p.packed32(0);
  return p;
}

export function planeStartPayload(startTimeSecs: number): BitWriter {
  const p = new BitWriter(64);
  p.bit(false);
  p.packed32(PLANE_H.StartTimeSecs); p.float(startTimeSecs);
  p.packed32(0);
  return p;
}

export function ridersPayload(riders: bigint[]): BitWriter {
  const p = new BitWriter(64 + riders.length * 24);
  p.bit(false);
  p.packed32(RIDE_H.PlayersInsideCount); p.int32(riders.length);
  p.packed32(RIDE_H.PlayersInside); p.uint16(riders.length);
  riders.forEach((g, i) => { p.packed32(i + 1); p.packed64(g); });
  p.packed32(0);
  p.packed32(0);
  return p;
}

export function canExitPayload(): BitWriter {
  const p = new BitWriter(32);
  p.bit(false); p.packed32(RIDE_H.bCanExit); p.bit(true); p.packed32(0);
  return p;
}

/** One RPC field (SerializeInt(idx, max) + packed bit count + params), as the content-block payload. */
export function rpcField(idx: number, max: number, params: (p: BitWriter) => void): BitWriter {
  const p = new BitWriter(256); params(p);
  const f = new BitWriter(p.bits + 64);
  f.serializeIntVar(idx, max); f.packed32(p.bits); f.bitsFrom(p.buffer(), p.bits);
  return f;
}

export function compPayload(entries: Array<[number, (w: BitWriter) => void]>): BitWriter {
  const p = new BitWriter(256);
  p.bit(false);
  for (const [h, write] of [...entries].sort((a, b) => a[0] - b[0])) { p.packed32(h); write(p); }
  p.packed32(0);
  return p;
}

/** The client's plane location Seconds after StartTimeSecs (its UpdatePlaneMovement: along the line at Speed). */
export function planeLocationAt(start: V3, end: V3, seconds: number): [number, number, number] {
  const dx = end[0]! - start[0]!, dy = end[1]! - start[1]!, dz = end[2]! - start[2]!;
  const len = Math.hypot(dx, dy, dz) || 1;
  const t = Math.max(0, Math.min(1, (seconds * PLANE_SPEED) / len));
  return [start[0]! + dx * t, start[1]! + dy * t, start[2]! + dz * t];
}

export function planeDuration(start: V3, end: V3) {
  return Math.hypot(end[0]! - start[0]!, end[1]! - start[1]!) / PLANE_SPEED;
}

/** A straight path at Z 20000 through `through`, starting `back` uu before it along `dir` (unit 2D). */
export function pathThrough(through: V3, back = 25000, ahead = 45000, dir: [number, number] = [1, 0]): { start: number[]; end: number[] } {
  return {
    start: [through[0]! - dir[0] * back, through[1]! - dir[1] * back, PLANE_Z],
    end: [through[0]! + dir[0] * ahead, through[1]! + dir[1] * ahead, PLANE_Z],
  };
}

// ---------------------------------------------------------------- the leader's drop pod (BP_DropPod_C)
export const POD_PKG = "/Game/Loki/Environment/DropPlane/DropPod/BP_DropPod";
export const POD_CLS = "BP_DropPod_C";
export const POD_TEAM_NAME = "LokiTeam";
export const POD_RIDE_NAME = "LokiRideable";
/** Retail pod timeline (LokiDropPod.h, flow 7039): Intro 6.5 s, control 5.5 s, outro 1 s, close 1.5 s after Destroying. */
export const POD_T = { descending: 6.5, outro: 12.0, destroying: 13.0, close: 14.5 } as const;
export const POD_SPAWN_Z = 21015;
export const POD_HALF_HEIGHT = 468.38;
export const POD_STATE = { IntroSequence: 1, Attached: 2, Descending: 3, OutroSequence: 4, Destroying: 5 } as const;
/** ALokiDropPod handles (retail-decoded 2026-11-25; structs flatten member by member). h16 (76 opaque bits in
 *  retail's open, the poolable ServerState) is never sent. */
export const POD_H = {
  bHidden: 2, RemoteRole: 5, ReplicatedMovement: 12, Owner: 13, Role: 14,
  PilotPlayerState: 17, bIsTeamLeaderPod: 18, PodTeamIndex: 19, ImpactIndicator: 20, CurrPodDestination: 21,
  AttachedCrewPods: 22, LeaderPod: 23, DetachingCrewPods: 24,
  PSE_DropPod: 30, PSE_DropPodState: 31, PSE_PodPilot: 32, PSE_bIsLeaderPod: 33, CurrentInputDirection: 45,
} as const;

/** FRepMovement for the pod (RoundWholeNumber location, whole-unit velocity), as retail. */
export function writePodMovement(w: BitWriter, loc: V3, vel: V3 = [0, 0, 0]) {
  w.bitsFrom(Uint8Array.of(0), 4);
  writeQuantizedVector(w, loc[0]!, loc[1]!, loc[2]!, 1);
  writeRotation(w, 0, 0, 0, false);
  writeQuantizedVector(w, vel[0]!, vel[1]!, vel[2]!, 1);
}

function objArray(p: BitWriter, guids: bigint[]) {
  p.uint16(guids.length);
  guids.forEach((g, i) => { p.packed32(i + 1); p.packed64(g); });
  p.packed32(0);
}

export function podOpenPayload(o: { pod: bigint; pilot: bigint; team: number; dest: V3; impact?: bigint; crew?: bigint[] }): BitWriter {
  const p = new BitWriter(1024);
  p.bit(false);
  p.packed32(POD_H.RemoteRole); p.bitsFrom(Uint8Array.of(1), 3);
  p.packed32(POD_H.ReplicatedMovement); writePodMovement(p, [Math.round(o.dest[0]!), Math.round(o.dest[1]!), POD_SPAWN_Z]);
  p.packed32(POD_H.Owner); p.packed64(o.pilot);
  p.packed32(POD_H.Role); p.bitsFrom(Uint8Array.of(3), 3);
  p.packed32(POD_H.PilotPlayerState); p.packed64(o.pilot);
  p.packed32(POD_H.bIsTeamLeaderPod); p.bit(true);
  p.packed32(POD_H.PodTeamIndex); p.int32(o.team);
  if (o.impact) { p.packed32(POD_H.ImpactIndicator); p.packed64(o.impact); }
  p.packed32(POD_H.CurrPodDestination); vec(p, [o.dest[0]!, o.dest[1]!, 0]);
  if (o.crew?.length) { p.packed32(POD_H.AttachedCrewPods); objArray(p, o.crew); }
  p.packed32(POD_H.PSE_DropPod); p.packed64(o.pod);
  p.packed32(POD_H.PSE_DropPodState); p.bitsFrom(Uint8Array.of(POD_STATE.IntroSequence), 3);
  p.packed32(POD_H.PSE_PodPilot); p.packed64(o.pilot);
  p.packed32(POD_H.PSE_bIsLeaderPod); p.bit(true);
  p.packed32(0);
  return p;
}

export function podMovePayload(loc: V3, vel: V3, state?: number, hidden?: boolean): BitWriter {
  const p = new BitWriter(256);
  p.bit(false);
  if (hidden !== undefined) { p.packed32(POD_H.bHidden); p.bit(hidden); }
  p.packed32(POD_H.ReplicatedMovement); writePodMovement(p, loc, vel);
  if (state !== undefined) { p.packed32(POD_H.PSE_DropPodState); p.bitsFrom(Uint8Array.of(state), 3); }
  p.packed32(0);
  return p;
}

export function teamPayload(team: number): BitWriter {
  const p = new BitWriter(32);
  p.bit(false); p.packed32(3); p.uint8(team & 0xff); p.packed32(0);
  return p;
}
