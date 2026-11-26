import dgram from "node:dgram";
import http from "node:http";
import crypto from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
/** Optional local packet log for debugging your own matches (off unless REVIVE_MATCH_PACKET_LOG is set to a directory). */
const CAPTURE_DIR = process.env.REVIVE_MATCH_PACKET_LOG || "";
import { fileURLToPath } from "node:url";
import INSTANCE_POLICY from "./tables/instance-policy.ts";
import {
  BitReader, BitWriter, ENGINE_NET_VER_LATEST, NMT, EChannelName, DESTROYED,
  newBunch, writeBunch, readBunch, parseHandshake, isHandshake, makeChallenge,
  makeAck, stripHandler, addHandler, finalizePacket, GUID, writeNewActor, writeQuantizedVector,
  detectRealPrefix,
  type PrefixVariant,
  writeContentBlock, writeRepMovement, writeNetGuid, writeRotation,
  readHello, writeChallenge, writeWelcome, readUniqueNetIdRepl,
  tryParseRealPacket, writeNetGuidExportSection, generateCookie, type GuidExport, type Bunch,
} from "./protocol.ts";
import { NetClassLayout, writePropValue, type NetField } from "./netlayout.ts";
import { heroBlueprint, PLAYER_STATE_BP, PLAYER_CONTROLLER_BP } from "./heroes.ts";
const heroPackageGuid = (i: number) => GUID.HeroBase + BigInt(i) * 4n;
const heroCdoGuid = (i: number) => GUID.HeroBase + BigInt(i) * 4n + 2n;
import { MatchWorld, type Combatant, type MatchEvent, type MatchRules } from "./match.ts";
import { loadServerConfig, type ServerConfig } from "./config.ts";
import { rpcHandles, detectRpcCalls, abilityIdForSpec } from "./abilities.ts";
import * as CastVis from "./castvis.ts";
import { HERO_FIELD, HERO_FIELD_MAX, MOVE_MODE, readRpcFields, decodeServerMovePacked, writeMoveResponse, type ClientMove, type MoveCorrection } from "./movement.ts";
import { spawnPointFor, hasSpawnPoints, nearestFloor, landingFloor, floorSpawnList, floorAt, learnFloor, setModeSpawns, FFA_SPAWNS } from "./spawnpoints.ts";
import * as Zone from "./zone.ts"; // [zone] the storm (LOKI_ZONE_REP=0 disables)
import * as Drop from "./drop.ts";
import * as Gas from "./gas.ts";
import * as Loot from "./loot.ts"; // [loot] world loot (LOKI_LOOT=0 disables)
import * as Ix from "./interact.ts"; // [interact] shop, wallet, death boxes (LOKI_INTERACT=0 disables)
import * as Armory from "./armory.ts"; // [armory] in-match armory buys + FFA/Breach purse (LOKI_ARMORY=0 / LOKI_PURSE=0)
import * as Capture from "./capture.ts"; // [capture] Breach basecamps (LOKI_CAPTURE=0 disables)
import { resolveMode, modeProfileFor, type ModeProfile } from "./modeconfig.ts";
import { pickRetailWorld, exportSections, bunchData, sliceBits, type RetailWorld, type RetailBunch } from "./retailworld.ts";

/** Retail world replay reuses the retail NetGUIDs (all < ~1600), so our own static/dynamic GUIDs move up by
 *  GUID_SHIFT (even, keeps the static-odd / dynamic-even split) and the paths retail also exports are pinned
 *  to retail's GUIDs in ensureRetailWorld(). */
/** Replaying recorded world bunches is not part of this edition (no recordings ship); kept as a hook. */
const RETAIL_WORLD = false;
const GUID_SHIFT = RETAIL_WORLD ? 0x10000n : 0n;
if (GUID_SHIFT) for (const k of Object.keys(GUID)) { const v = (GUID as any)[k] as bigint; if (v > 1n) (GUID as any)[k] = v + GUID_SHIFT; }
const SHIFTED_GUID: Record<string, bigint> = { ...GUID };
const RETAIL_PIECE_BITS = Number(process.env.LOKI_RETAIL_PIECE_BITS || 7000);

const SEQ_START = 1;
const RELIABLE_BASE = process.env.LOKI_RELIABLE_BASE !== undefined ? Number(process.env.LOKI_RELIABLE_BASE) : undefined;
const MAX_CHANNELS = 16384;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TICK_MS = 50;
const COALESCE = process.env.LOKI_COALESCE !== "0";
const PACKET_BITS = Number(process.env.LOKI_PACKET_BITS || 7800);
const SEND_WINDOW = Number(process.env.LOKI_SEND_WINDOW || 160);
const RESEND_MS = Number(process.env.LOKI_RESEND_MS || 1000);
/** Outbound pacing (token bucket, bytes): a join opens ~90 channels at once; unpaced that left as ~90
 *  datagrams in 45 ms, and every run on 2026-11-25 lost the client ~0.7 s after that burst. */
const PACE_BPS = Number(process.env.LOKI_PACE_BPS || 160_000);
const PACE_BURST = Number(process.env.LOKI_PACE_BURST || 9_000);
const CONN_TIMEOUT_MS = Number(process.env.LOKI_CONN_TIMEOUT_MS || 60_000);
// Client BaseEngine.ini ChannelDefinitions: 0 = Control, 1 = Voice, 2 = DataStream (static). Actors start at 3.
const GAMESTATE_CH = 3;
/** Loki-native fields (handles past the engine classes) are only exact when the spawned
 *  BP's native parent is the Loki class; several mode GameStates (e.g. Battlefield) sit on
 *  AngelScript parents over LokiGameStateBase whose layouts are not in the exe. Off by default. */
const GUID_HUD_PKG = 0x7001n, GUID_HUD_CLASS = 0x7003n;
/** The drop plane (drop.ts): static package/CDO odd, the dynamic plane + its stable rideable even. */
const GUID_PLANE_PKG = 0x7201n, GUID_PLANE_CDO = 0x7203n, GUID_PLANE = 0x7210n, GUID_PLANE_RIDE = 0x7212n;
const GUID_DROPCOMP_PKG = 0x7205n, GUID_DROPCOMP_CLS = 0x7207n;
const DROP_COMP_GUID_BASE = 0x7300n;
const GUID_POD_PKG = 0x7221n, GUID_POD_CDO = 0x7223n, GUID_POD_BASE = 0x7400n;
const POD_CH_BASE = Number(process.env.LOKI_POD_CH || 330);
const PLANE_CH = Number(process.env.LOKI_PLANE_CH || 390);
/** Team states (TryUIReady needs GameState.TeamStates[team] with its TeamStateTeamOnly set).
 *  Static archetypes are odd; dynamic actors even. Channels sit above the player block (5 + 3n). */
const GUID_TEAM_PKG = 0x6001n, GUID_TEAM_CDO = 0x6003n, GUID_TEAMONLY_CDO = 0x6005n;
const TEAM_BP = { pkg: process.env.LOKI_TEAM_BP_PKG || "/Game/Loki/Core/GameModes/BP_LokiTeamState", cls: process.env.LOKI_TEAM_BP_CLS || "BP_LokiTeamState_C" };
const teamGuid = (t: number) => 0x5000n + BigInt(t) * 0x10n;
const teamOnlyGuid = (t: number) => 0x5800n + BigInt(t) * 0x10n;
const TEAM_CH_BASE = Number(process.env.LOKI_TEAM_CH_BASE || 400);
const teamChannel = (t: number) => TEAM_CH_BASE + t * 2;
const teamOnlyChannel = (t: number) => TEAM_CH_BASE + t * 2 + 1;
const REP_TEAMS = process.env.LOKI_REP_TEAMS !== "0";
/** ALokiPlayerState_Stats: one per player (retail flow 7039: 24 at login). Its OnRep_Owner sets the owner
 *  PlayerState's StatsObject; the HUD team rows / cards read name + bIsAlive through it (without it: "LokiPlayerName", DEAD). */
const REP_STATS = process.env.LOKI_REP_STATS !== "0";
const GUID_STATS_CDO = 0x6007n;
const statsGuid = (ord: number) => 0x8000n + BigInt(ord) * 0x10n;
const STATS_CH_BASE = Number(process.env.LOKI_STATS_CH_BASE || 500);
const STATS_HANDLE = Number(process.env.LOKI_STATS_HANDLE || 17);
/** ALokiPlayerState_HeroAffiliated ("carrier", LokiPlayerState_HeroAffiliated.h): Owner = the PlayerState; the client's
 *  OnRep_Owner wires the hero's ASC + attribute sets (hero+0xF00/F08/F10). The retail mover reads MoveSpeed / MaxAcceleration /
 *  YawRotationRate from the carrier's stable "AttributeSet" — all zero until replicated, i.e. accel 0 and a hero that never turns. */
const REP_CARRIER = process.env.LOKI_REP_CARRIER !== "0";
const GUID_CARRIER_CDO = 0x6009n;
const carrierGuid = (ord: number) => 0x8800n + BigInt(ord) * 0x10n;
const CARRIER_CH_BASE = Number(process.env.LOKI_CARRIER_CH_BASE || 600);
/** Breach trains (docs/BREACH-MAP-FEATURES.md §1): 2 trains × 3 cars, spawned dynamically like retail, each with its
 *  BP_TrainMovableBaseComponentV2 track distance; the client moves the cars itself along the level's spline at ~1000 uu/s. */
const REP_TRAIN = process.env.LOKI_TRAIN !== "0";
const TRAIN_CH_BASE = Number(process.env.LOKI_TRAIN_CH || 700);
const TRAIN_LOOP = 165_600, TRAIN_SPEED = 1000;
const TRAIN_CLASSES = [
  { pkg: "/Game/Loki/Environment/Train/BP_Train_FrontCar_Breach", cdo: "Default__BP_Train_FrontCar_Breach_C", guid: 0x7d01n },
  { pkg: "/Game/Loki/Environment/Train/BP_Train_LockedChest_Breach", cdo: "Default__BP_Train_LockedChest_Breach_C", guid: 0x7d05n },
  { pkg: "/Game/Loki/Environment/Train/BP_Train_BeaconBackCar_Breach", cdo: "Default__BP_Train_BeaconBackCar_Breach_C", guid: 0x7d09n },
];
/** [class index, train index, spawn location, retail track distance at combat start] (retail flow 7038, t=1.93). */
const TRAIN_CARS: Array<[number, number, [number, number, number], number]> = [
  [0, 1, [-14031.4, -29528.0, 0], 30101.464], [1, 1, [-15322.3, -29521.1, 0], 28601.464], [2, 1, [-16613.9, -29514.0, 0], 27311.464],
  [0, 2, [2247.2, 23952.8, -1.4], 112885.284], [1, 2, [3492.5, 23682.8, -3.4], 111385.284], [2, 2, [4600.1, 23071.1, -2.8], 110095.284],
];
const trainCarGuid = (i: number) => 0x7e00n + BigInt(i) * 0x10n;
/** Breach Airdoos (rideable LokiAirship_AS vehicles), as retail runs them (flows 7038 + 7039, decoded from the
 *  LokiMapIconManager_1 IconData items): 16 fixed spots with a pair of Airdoos each, all 32 spawned in the first ~13.6 s of
 *  the match (later IconData traffic is only icons following flown Airdoos). Points are the icon locations; the actor parks
 *  256 below its icon (retail open: icon z 406 -> actor z 150). Boarding/flying is not implemented yet. */
/** Airdoos need attribute/icon blocks that were copied from recorded traffic; those are not shipped, so this stays off. */
const REP_AIRDOO = false;
const AIRDOO_CH_BASE = Number(process.env.LOKI_AIRDOO_CH || 1300);
const AIRDOO_CLASS = { pkg: "/Game/Loki/Airship/BP_Airdoo", cdo: "Default__BP_Airdoo_C", guid: 0xa001n };
const AIRDOO_POINTS: Array<[number, number, number]> = [
  [-12222, -22330, 406], [-12614, -23526, 406], [-7409, 26524, 406], [-8327, 25581, 406],
  [20323, -18804, 406], [19090, -17490, 406], [20745, 33025, 406], [18856, 33081, 406],
  [33477, -21013, 256], [33241, -21483, 256], [-24844, -31222, 257], [-25176, -29487, 257],
  [21579, -36117, 406], [19952, -37133, 406], [47842, -1694, 406], [47216, -1051, 406],
  [33843, 34945, 406], [34800, 33064, 406], [-47976, -9396, 406], [-47196, -9352, 406],
  [46571, 23015, 406], [44630, 21594, 406], [-50902, 16060, 406], [-53110, 17353, 406],
  [-1693, 59273, 406], [-1100, 59291, 406], [58556, -25672, 406], [59570, -26030, 406],
  [38769, 51050, 406], [38584, 50486, 406], [-25878, 58680, 406], [-25794, 59268, 406],
];
/** BP_Airdoo_C h24 (retail open on flow 7038 ch 6): the hull material, MI_AirDoo_Default_01_ORA. */
const AIRDOO_MAT = { pkg: "/Game/Loki/Characters/Shared/Mounts/Airdoo/Chromas/ORA/MI_AirDoo_Default_01_ORA", obj: "MI_AirDoo_Default_01_ORA", guid: 0xa005n };
/** Stable subobjects of every Airdoo (retail export names + checksums; GUID = actor + off). */
const AIRDOO_SUBS = { HealthSet: [2, 2793961273], AirshipSet: [4, 2388585108], AbilitySystemComponent: [6, 3215491828],
  Seats: [8, 3094778671], BP_AirshipSeat_Pilot: [10, 4232331603], BP_AirshipSeat_Passenger: [12, 4232331603] } as const;
/** HealthSet (1950 ×4) and AirshipSet (boost fuel 100 ×4) payloads, verbatim from the retail open. */
const AIRDOO_HEALTHSET = Buffer.alloc(0);
const AIRDOO_AIRSHIPSET = Buffer.alloc(0);
/** Breach's level-placed LokiMapIconManager_1 (retail flow 7038 ch 160: static GUID exported by path, flags 7, checksum below).
 *  Its IconData fast array (custom-delta field 12) is what draws minimap icons; retail adds one item per Airdoo ~12.7 s in. */
const MAPICON_MGR = { guid: 0xa0f01n, path: "LokiMapIconManager_1", checksum: 3363654038, ch: Number(process.env.LOKI_MAPICON_CH || 1290) };
const MAPICON_FIELD = 12, MAPICON_BOUND = 24;
/** FLokiMapIconItem NetSerialize after OwnerName + WorldLocation (3 doubles), identical for every Airdoo in retail: flags, Size 24,
 *  IconDataAssetId = (MapIcon, DA_MapIcon_Airdoo). 378 bits, LSB-first. */
const AIRDOO_ICON_TAIL = Buffer.alloc(0);
const AIRDOO_ICON_TAIL_BITS = 378;
const airdooGuid = (i: number) => 0xa100n + BigInt(i) * 0x10n;
/** [zone] storm actor (zone.ts): channel, GUIDs, shrink frame interval, retail first centre (flow 7038 open h19). */
const REP_ZONE = process.env.LOKI_ZONE_REP !== "0";
const ZONE_CH = Number(process.env.LOKI_ZONE_CH || 398);
const ZONE_RATE_MS = Number(process.env.LOKI_ZONE_RATE_MS || 100);
const ZONE_SPEED = Number(process.env.LOKI_ZONE_SPEED || 1); // test only: storm clock multiplier
const GUID_ZONE_PKG = 0x7f01n, GUID_ZONE_CDO = 0x7f03n, GUID_ZONE = 0x7f10n;
const FFA_RETAIL_ZONE_GUID = 116n; // retail-world-ffa.json: BP_DeathCircle_FFA_C actor on retail ch 178
const ZONE_CENTER0: [number, number] = [Number(process.env.LOKI_ZONE_X || -1509.524166584015), Number(process.env.LOKI_ZONE_Y || 4996.574306488037)];
/** Comp_GameState_GamePhase (BP stable subobject of the Breach GameState): retail sends h5 = world time of every phase
 *  edge (SpawnSelect, Combat, each storm phase), and the GameState's BP double h92 the same value (flow 7038). */
const GUID_GAMEPHASE_COMP = 0x7f21n;
/** Comp_GameState_Announcements RPC blocks replayed raw from flow 7038: the storm warning 13 s before the first shrink
 *  (121.05, 21 bits, unreliable) and the "storm is closing" multicast at every shrink start (134.05/329.07/…, 11 bits). */
const GUID_ANNOUNCE_COMP = 0x7f25n;
const ANNOUNCE_WARN = { hex: "231108", bits: 21 }, ANNOUNCE_SHRINK = { hex: "0600", bits: 11 };
const zoneKey = (n: { center: [number, number]; radius: number }) => `${n.radius}:${Math.round(n.center[0])}:${Math.round(n.center[1])}`;
const GUID_TRAINCOMP = 0x7e80n;
const TRAIN_REWARDS = [
  "/Game/Loki/Items/Equipment/SetWeapons/Armory_Season2/Grips/ClothGloves_01/BP_ITEM_Equipment_Grips_ClothGloves_01",
  "/Game/Loki/Items/Equipment/SetWeapons/Armory_Season2/Kicks/Sandals_01/BP_ITEM_Kicks_Sandals_01",
];
const trainRewardGuid = (i: number) => 0x7e91n + BigInt(i) * 0x10n;
/** Server-driven GAS on the owning carrier (LOKI_GAS=0 off): the hero kit is granted into the carrier's
 *  AbilitySystemComponent (field 8) with one replicated instance per active spell, and every
 *  ServerTryActivateAbility (50) is confirmed (18), ended (21) and its key acked (15). */
const REP_GAS = process.env.LOKI_GAS !== "0";
/** Dynamic ability-instance subobjects. Sending one for EVERY ability hard-crashed the 2.0.4 client (07:13, 07:29 UTC);
 *  "policy" (default) sends one only where the client expects a replicated instance (retail 0x552CAE0 rule, reference's
 *  bServerReplicatesInstance: selectors, swappers, charge/yaw-lock spells) with that class's initial properties.
 *  LOKI_GAS_INSTANCES=0 none, =all every ability (old behaviour). */
const GAS_INSTANCES = process.env.LOKI_GAS_INSTANCES ?? "policy";
/** Send the ASC's OwnerActor/AvatarActor (h7/h8, retail COND_None): without them the client ASC has no avatar and refuses every press. */
const GAS_ACTOR_INFO = process.env.LOKI_GAS_ACTOR_INFO !== "0";
type InstPolicy = { rep: boolean; family: string; maxCharges?: number };
/** Which ability classes replicate an instance, and per-hunter attribute maxima (tables/instance-policy.ts). */
const GAS_POLICY = INSTANCE_POLICY as unknown as { classes: Record<string, InstPolicy>; heroes: Record<string, { maxHealth: number; maxMana: number; maxStamina: number }> };
const ascGuidOf = (ord: number) => carrierGuid(ord) + 6n;
const abilIndex = new Map<string, number>();
/** Static GUIDs per ability class (odd, above hero archetypes at 0x10000+): pkg, +2 class, +4 CDO. */
const abilGuid = (cls: string) => { let i = abilIndex.get(cls); if (i === undefined) { i = abilIndex.size; abilIndex.set(cls, i); } return 0x40001n + BigInt(i) * 0x10n; };
const abilInstGuid = (ord: number, i: number) => 0x30000n + BigInt(ord) * 0x200n + BigInt(i) * 2n;
const ABILITY_SIM: Record<number, string> = { 3: "primary", 4: "bolt", 6: "barrage", 15: "nova" };
const SIM_INPUT: Record<string, number> = Object.fromEntries(Object.entries(ABILITY_SIM).map(([k, v]) => [v, Number(k)]));
/** Level-1 hunter movement rows: MoveSpeed, MaxAcceleration. MaxMoveSpeed 700, GroundFriction 1,
 *  BrakingDecelerationWalking 2220, AirControlMultiplier 1, YawRotationRate -1 (instant), Mass 100 for all. */
const HERO_MOVE: Record<string, [number, number]> = {
  Alchemist: [455, 5400], Assault: [455, 5400], BacklineHealer: [465, 5400], Beebo: [430, 5400], BountyHunter: [465, 5400],
  BurstCaster: [455, 5400], Earthtank: [465, 5000], FarShot: [445, 5400], FireFox: [465, 5400], Flex: [475, 5400],
  Freeze: [445, 5400], Gunner: [430, 5400], HookGuy: [465, 4700], Huntress: [455, 5400], Reaper: [485, 5000],
  ResHealer: [455, 5400], RocketJumper: [430, 5000], Ronin: [455, 5400], ShieldBot: [485, 4700], Sniper: [490, 5400],
  Stalker: [465, 5400], Storm: [465, 5400], Succubus: [480, 5400], Void: [465, 5400], Wukong: [455, 5400],
};
/** HeroCosmeticsBundle default per hero folder: the "<Folder>Default" naming the game's own bundles use. */
const heroBundle = (folder: string) => folder === "BacklineHealer" ? "BacklineHealer" : `${folder}Default`;
const REP_COSMETICS = process.env.LOKI_REP_COSMETICS !== "0";
/** The player's chosen skin when it is one of their hero's bundles, else the hero's default bundle. */
const skinBundle = (p: { heroId: string; skin?: string }) => {
  const folder = heroBlueprint(p.heroId).id;
  const name = String(p.skin || "").replace(/^HeroCosmeticsBundle:/i, "");
  if (name && process.env.LOKI_REP_SKIN !== "0" && name.toLowerCase().startsWith(folder.toLowerCase())) return name;
  return heroBundle(folder);
};
/** ALokiPlayerState::ClientVisibleSetDelta: PS field 33, header bound 44 (BP_LokiPlayerState_C MaxIndex 43). */
const REP_VISIBLE = process.env.LOKI_REP_VISIBLE !== "0";
const VIS_FIELD = Number(process.env.LOKI_VIS_FIELD || 33), VIS_FIELD_MAX = Number(process.env.LOKI_VIS_FIELD_MAX || 44);
const rawField = (h: number, name: string, write: (w: BitWriter) => void): [NetField, (w: BitWriter) => void] =>
  [{ h, class: "raw", name, type: "raw" }, write];
const REP_LOKI_FIELDS = process.env.LOKI_REP_LOKI_FIELDS === "1";
/** castvis (2026-11-25): simulated-proxy movement fields + remote cast montages. Each has its own off switch. */
const REP_SIM_TS = process.env.LOKI_REP_SIM_TS !== "0";
const REP_SIM_MOVEMODE = process.env.LOKI_REP_SIM_MOVEMODE !== "0";
const CAST_MONTAGE = process.env.LOKI_CAST_MONTAGE !== "0";
const CAST_RANGE = Number(process.env.LOKI_CAST_RANGE || 9000);
const CAST_DUMP = process.env.LOKI_CAST_DUMP || "";
const LIVING_STATE_HANDLE = Number(process.env.LOKI_LIVING_HANDLE || 64);
function livingStateEntry(state: number): [NetField, (w: BitWriter) => void] {
  const f: NetField = { h: LIVING_STATE_HANDLE, class: "LokiCharacter", name: "LivingState", type: "enum", bits: 3 };
  return [f, (w) => { for (let i = 0; i < 3; i++) w.bit((state >> i) & 1); }];
}
// GameState/PlayerState Loki fields (phase, match details, team) are on by default; hero Loki fields stay
// behind LOKI_REP_LOKI_FIELDS until the Character handle table past Controller is confirmed.
const REP_GS_LOKI = REP_LOKI_FIELDS || process.env.LOKI_REP_GS_LOKI !== "0";
const REP_PS_LOKI = REP_LOKI_FIELDS || process.env.LOKI_REP_PS_LOKI !== "0";
/** 2026-11-24: real client died on the GameState stream ("LokiDebugTarget ... ReadHandle=64",
 *  BunchIsError) with handles 20 (bool) + 21 (double). Until the double's wire form is confirmed
 *  only bReplicatedHasBegunPlay is sent; LOKI_REP_GS_TIME=1 re-enables the double + periodic push. */
// 2026-11-25: on by default. The ServerState splice made h20 the double, retail sends exactly h20 every
// 100 ms (flow 7038, 81-bit blocks), and the drop's StartTimeSecs/SpawnSelectEndTime are on this clock.
const REP_GS_TIME = process.env.LOKI_REP_GS_TIME !== "0";
/** LOKI_REP_MODE=props (default): spawn bunches carry property content blocks (each stream
 *  starts with the bDoChecksum bit — see docs/MATCH-SERVER-WIRE.md). "none" sends no
 *  properties, which leaves bReplicatedHasBegunPlay unset and the client on its loading screen. */
const REP_NONE = (process.env.LOKI_REP_MODE ?? "props") === "none";
/** Spawn archetype (CDO) GUID -> its package GUID, for must-be-mapped bunch headers. */
const ARCHETYPE_PACKAGE = new Map<bigint, bigint>();
/** Actor kinds whose initial bunch carries no properties (only the terminator). The GameState
 *  defaults to empty: its BP sits on AngelScript classes (GameState.LokiGameState module) and the
 *  real client maps handle 20 to an AngelScript LokiUAVConfig field, so even GameStateBase handles
 *  are not where the native-only layout puts them. LOKI_REP_EMPTY=gs,ps,pc,hero overrides. */
const REP_EMPTY = new Set((process.env.LOKI_REP_EMPTY ?? "").split(",").map((x) => x.trim()).filter(Boolean));
/** LOKI_REP_PROBE="gs=1:bool:0,21:double:5;ps=..." — raw per-kind probe payloads. */
type ProbeList = Array<[number, string, number]> & { noTerm?: boolean };
const REP_PROBE: Record<string, ProbeList> = {};
for (const part of (process.env.LOKI_REP_PROBE || "").split(";").filter(Boolean)) {
  const [kind, spec = ""] = part.split("=");
  const list = spec.split(",").filter(Boolean).filter((x) => x !== "noterm").map((x) => {
    const [h, t, v] = x.split(":");
    return [Number(h), t || "bool", Number(v || 0)] as [number, string, number];
  }) as ProbeList;
  if (spec.includes("noterm")) list.noTerm = true;
  REP_PROBE[kind!.trim()] = list;
}
/** Native SUPERVIVE classes whose exact rep layouts the spawn archetypes inherit. */
const SV_CLASS = {
  gameState: "LokiGameState",
  playerState: "LokiPlayerState",
  playerController: "LokiPlayerController",
  hero: "LokiHeroCharacter",
} as const;

export interface UEServerOptions {
  udpPort?: number;
  bindHost?: string;
  networkVersion?: number;
  engineNetVersion?: number;
  mapName?: string;
  gameName?: string;
  publicHost?: string;
  publicPort?: number;
  maxPlayers?: number;
  backendUrl?: string;
  serverId?: string;
  region?: string;
  matchId?: string;
  httpPort?: number;
  register?: boolean;
  log?: (...args: unknown[]) => void;
}

interface Player {
  abyssGraceUntil?: number;
  possessCheckAt?: number;
  id: string;
  name: string;
  matchId: string;
  heroId: string;
  /** chosen HeroCosmeticsBundle (roster Cosmetics, "HeroCosmeticsBundle:<Name>") */
  skin?: string;
  actorGuid: bigint;
  psGuid: bigint;
  pcGuid: bigint;
  channel: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  alive: boolean;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  team: number;
  isBot: boolean;
  /** objective entity (objectives.ts): tower / core / minion — kept out of team rosters */
  kind?: "hero" | "structure" | "minion";
  spawned: boolean;
  lastMoveMs: number;
  connKey: string;
  /** [loot] box index the client's last move was based on (standing on its slab), see loot.ts LootPlayer. */
  lootBaseBox?: number;
  /** ACharacter::ReplicatedMovementMode for simulated proxies (1 Walking, 3 Falling). */
  moveMode?: number;
  /** RepAnimMontageInfo PlayInstanceId: its low bit is the ForcePlayBit that makes observers replay. */
  castPlays?: number;
}

type ConnState = "hello" | "challenge" | "login" | "welcome" | "joined";

class UEConn {
  addr: { address: string; port: number };
  clientId: number;
  travelCount: number;
  state: ConnState = "hello";
  hello: { littleEndian: boolean; version: number; token: string; runtimeFeatures: number } | null = null;
  login: { url: string; playerId: string; platform: string; matchId: string } | null = null;
  players = new Set<string>();
  channels = new Set<number>();
  restartSent = false;
  /** Which heroes this connection may see: retail spawns none at join, the own team at Combat, the rest later. */
  heroGate: "all" | "team" | "none" = "all";
  visSetId = 0;
  trainsSent?: boolean;
  airdoosSent?: boolean;
  /** [zone] storm state already on this connection */
  zone?: { phase: number; revealKey: string; shrinking: boolean; lastShrinkMs: number; gsSent: boolean; warned?: boolean };
  drop: { opened?: number; combat?: boolean; started?: boolean; dest?: [number, number, number]; launched?: boolean; landed?: boolean; compGuid?: bigint; deferRestart?: boolean } = {};
  authCfgSent = false;
  /** castvis: movement mode last sent per remote hero, and remote ASCs whose OwnerActor/AvatarActor this conn already has. */
  sentMoveMode = new Map<string, number>();
  castAscReady = new Set<string>();
  outReliable: number[];
  inReliable: number[];
  sentPackets = new Map<number, { bunches: Bunch[]; at: number; createdAt: number }>();
  lastSeenMs = Date.now();
  exportedGuids = new Set<bigint>();
  spawnedActors = new Set<string>();
  seqIn = 0;
  seqOut = SEQ_START;
  seqAcked = 0;
  resent = 0;
  txLogged = 0;
  dupLogged = 0;
  wire: "mock" | "real" = "mock";
  realPrefix: Uint8Array | null = null;
  jitterInfo = true;
  wonPrefixVariant: PrefixVariant = "echo";
  retailQueue: RetailBunch[] | null = null;
  retailQueued = false;
  /** Open coalescing packet: bunches queued by sendBunch/sendRetailBunch during a tick share one datagram. */
  batch: { w: BitWriter; bunches: Bunch[]; count: number } | null = null;
  outQ: Uint8Array[] = [];
  paceTokens = PACE_BURST;
  paceAt = Date.now();

  constructor(addr: { address: string; port: number }, clientId: number, travelCount: number) {
    this.addr = addr;
    this.clientId = clientId;
    this.travelCount = travelCount;
    // UNetConnection::InitSequence(Incoming=ClientSeq, Outgoing=ServerSeq) seeds
    // OutReliable[*] = ServerSeq & 1023 and InReliable[*] = ClientSeq & 1023 (not 0).
    // Real 2.0.4 client: its Hello is packet seq 0 / ChSequence 1 (ClientSeq 0) and it
    // acks our packets from seq 1 (ServerSeq 1), so its InReliable[0] is 1 and our first
    // control bunch must be ChSequence 2 — ChSequence 1 is "outdated" and dropped
    // silently (acked at packet level, never dispatched: capture shows no Netspeed/Login).
    this.outReliable = new Array<number>(MAX_CHANNELS).fill((RELIABLE_BASE ?? SEQ_START) & 1023);
    this.inReliable = new Array<number>(MAX_CHANNELS).fill(0);
  }

  nextReliable(ch: number) {
    this.outReliable[ch] = ((this.outReliable[ch] || 0) + 1) & 1023;
    return this.outReliable[ch]!;
  }
}

export class UEGameServer {
  readonly options: Required<UEServerOptions>;
  readonly layout = new NetClassLayout();
  private socket: dgram.Socket;
  private httpServer?: http.Server;
  private conns = new Map<string, UEConn>();
  private players = new Map<string, Player>();
  private nextActorOrdinal = 0;
  private tickTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private started = false;
  private log: (...args: unknown[]) => void;
  private serverId: string;
  private currentMap: string;
  private currentGameMode: string;
  /** Non-Breach mode profile (modeconfig.ts MODE_PROFILES); null = Breach battle royale, untouched. */
  private modeProfile: ModeProfile | null = null;
  private currentQueueId = "";
  /** Per-match Armory switch from the backend (undefined = retail default, on). */
  private matchArmory: boolean | undefined = undefined;
  private currentMatchId: string;
  private readyMatches = new Set<string>();
  private startTime = Date.now();
  private config: ServerConfig;
  private match: MatchWorld;
  private gasRpc = rpcHandles(this.layout);
  private hpDirty = new Set<string>();
  private remainingTimer: ReturnType<typeof setTimeout> | null = null;
  private gasEnabled = process.env.LOKI_ENABLE_GAS_RPC === "1";
  private lastTickMs = Date.now();
  private postedResults = new Set<string>();
  private warnedHandles = new Set<string>();
  private lastGameStateSentS = -1;
  // UE StatelessConnect server secrets (rotated every 15±5 s) + cookie timestamps.
  private hsSecrets = [crypto.randomBytes(64), crypto.randomBytes(64)];
  private hsActiveSecret = 0;
  private hsLastSecretUpdate = 0;
  private hsTickCount = 0;
  private challengeVariants = new Map<string, { addr: { address: string; port: number }; variant: PrefixVariant; ts: number }>();

  constructor(opts: UEServerOptions = {}) {
    this.options = {
      udpPort: opts.udpPort ?? Number(process.env.LOKI_UE_PORT || 7777),
      bindHost: opts.bindHost ?? (process.env.LOKI_UE_BIND || "0.0.0.0"),
      networkVersion: opts.networkVersion ?? Number(process.env.LOKI_NET_VERSION || 0),
      engineNetVersion: opts.engineNetVersion ?? Number(process.env.LOKI_ENGINE_NET_VER || ENGINE_NET_VER_LATEST),
      mapName: opts.mapName ?? (process.env.LOKI_DS_MAP || "/Game/Loki/Maps/Battlefield/LVL_Battlefield"),
      gameName: opts.gameName ?? (process.env.LOKI_DS_GAMEMODE || "LokiGameMode"),
      publicHost: opts.publicHost ?? (process.env.LOKI_DS_PUBLIC_HOST || ""),
      publicPort: opts.publicPort ?? Number(process.env.LOKI_DS_PUBLIC_PORT || 0),
      maxPlayers: opts.maxPlayers ?? Number(process.env.LOKI_DS_MAX_PLAYERS || 36),
      backendUrl: opts.backendUrl ?? (process.env.LOKI_BACKEND_URL || "http://127.0.0.1:24970"),
      serverId: opts.serverId ?? (process.env.LOKI_DS_SERVER_ID || `loki-ue-${crypto.randomBytes(4).toString("hex")}`),
      region: opts.region ?? (process.env.LOKI_DS_REGION || "ap-southeast-1"),
      matchId: opts.matchId ?? (process.env.LOKI_DS_MATCH_ID || ""),
      httpPort: opts.httpPort ?? Number(process.env.LOKI_DS_HTTP_PORT || 24977),
      register: opts.register ?? (process.env.LOKI_DS_REGISTER !== "0"),
      log: opts.log ?? console.log,
    };
    this.serverId = this.options.serverId;
    this.currentMap = this.options.mapName;
    this.currentGameMode = this.options.gameName;
    this.currentMatchId = this.options.matchId;
    this.log = this.options.log;
    this.socket = dgram.createSocket("udp4");
    this.config = loadServerConfig();
    this.gasEnabled = process.env.LOKI_ENABLE_GAS_RPC === "1";
    this.gasRpc = rpcHandles(this.layout);
    const mode = resolveMode(this.currentGameMode, this.currentMap);
    this.match = new MatchWorld({
      ...this.config.rules,
      maxPlayers: this.options.maxPlayers,
      matchId: this.currentMatchId || this.serverId,
    }, { onEvent: (event) => this.onMatchEvent(event), gameModeType: mode.gameModeType, spawnPoints: () => floorSpawnList(this.currentMap), floorAt: (x, y) => floorAt(this.currentMap, x, y) });
    this.applyModeProfile();
    this.setupZone();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.socket.on("message", (msg, rinfo) => this.onDatagram(Buffer.from(msg), rinfo));
    this.socket.on("error", (err) => this.log("[ue] udp error", err));
    await new Promise<void>((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(this.options.udpPort, this.options.bindHost, () => resolve());
    });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    if (this.options.httpPort > 0) {
      this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
      this.httpServer.listen(this.options.httpPort, process.env.LOKI_DS_HTTP_BIND || "127.0.0.1", () => {
        this.log(`[ue] http status http://0.0.0.0:${this.options.httpPort}/status`);
      });
    }
    if (this.options.register) {
      void this.registerWithBackend();
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), 15_000);
      this.heartbeatTimer.unref?.();
    }
    this.log(`[ue] Unreal replication server listening udp ${this.options.bindHost}:${this.options.udpPort} map=${this.currentMap} netver=${this.options.networkVersion} engineNetVer=${this.options.engineNetVersion} endpoint=${this.currentEndpoint() || "none"}`);
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.httpServer?.close();
    this.socket.close();
    this.started = false;
  }

  get status() {
    return {
      listening: this.started,
      endpoint: this.currentEndpoint(),
      udpPort: this.options.udpPort,
      map: this.currentMap,
      gameMode: this.currentGameMode,
      matchId: this.currentMatchId,
      networkVersion: this.options.networkVersion,
      engineNetVersion: this.options.engineNetVersion,
      serverId: this.serverId,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      connections: this.conns.size,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id, name: p.name, matchId: p.matchId, team: p.team,
        position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
        rotation: { yaw: Math.round(p.yaw), pitch: Math.round(p.pitch) },
        health: p.health, score: p.score,
      })),
    };
  }

  private sendJson(res: http.ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const token = this.config.adminToken;
    if (!token) return false;
    const header = req.headers.authorization || "";
    return header === `Bearer ${token}`;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const rawUrl = req.url || "/";
    const qIndex = rawUrl.indexOf("?");
    const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
    const params = new URLSearchParams(qIndex < 0 ? "" : rawUrl.slice(qIndex + 1));
    const method = req.method || "GET";

    if (method === "GET" && (path === "/health" || path === "/status")) {
      return this.sendJson(res, { ok: true, ...this.status, match: this.match.getSnapshot() });
    }
    if (method === "GET" && path === "/match") {
      return this.sendJson(res, this.match.getSnapshot());
    }
    if (method === "GET" && path === "/match/events") {
      const limit = Math.min(250, Math.max(1, Number(params.get("limit")) || 100));
      return this.sendJson(res, { events: this.match.getEvents(limit) });
    }
    if (method === "GET" && path === "/match/result") {
      return this.sendJson(res, this.match.result);
    }
    if (method === "GET" && path === "/metrics") {
      const snap = this.match.getSnapshot();
      const lines = [
        `# HELP loki_ue_connections Active UE client connections`,
        `# TYPE loki_ue_connections gauge`,
        `loki_ue_connections ${this.conns.size}`,
        `# HELP loki_ue_players Human players in the match`,
        `# TYPE loki_ue_players gauge`,
        `loki_ue_players ${snap.playersAlive}`,
        `# HELP loki_ue_bots Bots in the match`,
        `# TYPE loki_ue_bots gauge`,
        `loki_ue_bots ${snap.botsAlive}`,
        `# HELP loki_ue_match_phase 0=waiting 1=countdown 2=playing 3=ended`,
        `# TYPE loki_ue_match_phase gauge`,
        `loki_ue_match_phase ${[ "waiting", "countdown", "playing", "ended" ].indexOf(snap.phase)}`,
        `# HELP loki_ue_round_phase ELokiGameModeType ERoundPhase: 4=SpawnSelect 5=SpawnReveal 6=Lineup 7=Combat 8=Post`,
        `# TYPE loki_ue_round_phase gauge`,
        `loki_ue_round_phase ${snap.roundPhaseCode}`,
        `# HELP loki_ue_gamemode_type ELokiGameModeType: 0=None 1=BattleRoyale 2=LastMan 3=Barracuda 4=Tournament 5=Domination 6=PrismaBank`,
        `# TYPE loki_ue_gamemode_type gauge`,
        `loki_ue_gamemode_type ${snap.gameModeType}`,
        `# HELP loki_ue_uptime_seconds Server uptime`,
        `# TYPE loki_ue_uptime_seconds counter`,
        `loki_ue_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`,
        "",
      ];
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
      return res.end(lines.join("\n"));
    }

    if (method === "POST" && (path === "/admin/ability" || path === "/admin/input")) {
      if (!this.authorized(req)) return this.sendJson(res, { error: "unauthorized" }, 401);
      let body: Record<string, unknown> = {};
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      } catch { return this.sendJson(res, { error: "bad_json" }, 400); }
      const id = String(body.playerId || body.id || "");
      if (path === "/admin/ability") {
        const abilityId = String(body.abilityId || body.ability || "");
        const ok = this.match.requestAbility(id, abilityId);
        return this.sendJson(res, { ok: ok.ok, reason: ok.reason, ability: abilityId });
      }
      this.match.setInput(id, {
        mx: Number(body.mx) || 0, my: Number(body.my) || 0,
        yaw: Number(body.yaw) || 0, pitch: Number(body.pitch) || 0,
        fire: !!body.fire, sprint: !!body.sprint, jump: !!body.jump,
      });
      return this.sendJson(res, { ok: true });
    }

    return this.sendJson(res, { error: "not_found" }, 404);
  }

  private onMatchEvent(event: MatchEvent) {
    this.onModeEvent(event);
    if (event.type === "kill") this.log(`[match] kill ${event.killer} -> ${event.victim} (${event.weapon})`);
    else if (event.type === "match_start") this.log(`[match] start players=${event.players} bots=${event.bots}`);
    else if (event.type === "match_end") this.log(`[match] end winner=${event.winner} reason=${event.reason}`);
    else if (event.type === "zone") this.log(`[match] zone radius=${Math.round(event.radius)} dps=${event.dps.toFixed(1)}`);
    if (event.type === "kill" && process.env.LOKI_KILLFEED !== "0") this.sendKillFeed(event);
    if (event.type === "kill") this.armory?.onKill(event.killer, event.victim); // [armory] hook: kill gold
    if (event.type === "kill" && this.interact && /LVL_SkylandsBreach$/.test(this.currentMap)) {
      const v = this.players.get(event.victim);
      if (v && v.spawned) {
        const vc = [...this.conns.values()].find((c) => this.key(c.addr) === v.connKey);
        this.interact.endInteraction(vc, v);
        this.interact.onDeath(v, Loot.hash32(`${event.victim}:${event.t}`));
      }
    }
    if (event.type === "ability" && event.ok) {
      const bot = this.players.get(event.id);
      const inputId = SIM_INPUT[event.ability];
      if (bot?.isBot && inputId !== undefined) this.broadcastCastMontage(bot, CastVis.montageForInput(heroBlueprint(bot.heroId).id, inputId), event.ability);
    }
    if (event.type === "kill" && process.env.LOKI_REP_LIVING !== "0" && process.env.LOKI_REP_DEATH_HIDE === "0") {
      const victim = this.players.get(event.victim);
      if (victim) for (const conn of this.conns.values()) {
        if (conn.state !== "joined" || !conn.channels.has(victim.channel + 1)) continue;
        const payload = new BitWriter(64);
        this.propPayload(payload, [livingStateEntry(0)]);
        this.sendBunch(conn, (w) => writeContentBlock(w, true, true, payload.buffer(), payload.bits), { ch: victim.channel + 1, reliable: true, nameIndex: EChannelName.Actor });
      }
    }
    if (event.type === "damage" && REP_CARRIER) {
      // coalesce health pushes per target (sim ticks fast); syncMatchState has copied hp by the time this fires
      if (!this.hpDirty.has(event.target)) {
        this.hpDirty.add(event.target);
        setTimeout(() => {
          this.hpDirty.delete(event.target);
          const pl = this.players.get(event.target);
          if (pl) for (const conn of this.conns.values()) if (conn.state === "joined") this.sendCarrierHealth(conn, pl);
        }, 120);
      }
    }
    if ((event.type === "kill" || event.type === "respawn") && process.env.LOKI_REP_DEATH_HIDE !== "0") {
      // retail death bundle (cross-checked against retail traffic): bHidden 1 + LivingState Dead on the victim's hero; respawn reverses it
      const id = event.type === "kill" ? event.victim : event.id;
      const dead = event.type === "kill";
      setTimeout(() => {
        const pl = this.players.get(id);
        if (!pl) return;
        for (const conn of this.conns.values()) {
          if (conn.state !== "joined" || !conn.channels.has(pl.channel + 1)) continue;
          const payload = new BitWriter(64);
          this.propPayload(payload, [rawField(2, "bHidden", (w) => w.bit(dead)), livingStateEntry(dead ? 0 : 1)]);
          this.sendBunch(conn, (w) => writeContentBlock(w, true, true, payload.buffer(), payload.bits), { ch: pl.channel + 1, reliable: true, nameIndex: EChannelName.Actor });
          if (REP_CARRIER) this.sendCarrierHealth(conn, pl);
          if (REP_STATS) this.sendStats(conn, pl, false);
        }
      }, 60);
    }
    if (event.type === "kill" && process.env.LOKI_REP_REMAINING !== "0" && this.match.rules.respawnMs < 0 && !this.remainingTimer) {
      // retail GameState h35 ReplicatedNumRemainingPlayers follows every elimination (flow 7038: 24 -> 23 -> … -> 9); the HUD counter reads it
      this.remainingTimer = setTimeout(() => {
        this.remainingTimer = null;
        const alive = this.match.all().filter((c) => c.alive).length;
        for (const conn of this.conns.values()) if (conn.state === "joined") this.sendGsProps(conn, [this.val(SV_CLASS.gameState, "ReplicatedNumRemainingPlayers", alive)]);
      }, 250);
    }
    if (event.type === "kill" && REP_STATS) {
      // syncMatchState copies alive/kills/deaths from the sim; push both rows after it ran.
      setTimeout(() => {
        for (const id of [event.victim, event.killer]) {
          const pl = this.players.get(id);
          if (pl) for (const conn of this.conns.values()) if (conn.state === "joined") { this.sendStats(conn, pl, false); if (REP_CARRIER) this.sendCarrierHealth(conn, pl); }
        }
      }, 50);
    }
    if (event.type === "match_end") {
      // Retail end (flow 7038 780.40): GameState bGetPreventWeaponFire 1 + WinningTeam/WinningPawn, PlayerState
      // BattleRoyalePlayerPhase PostGame (4), bGetPreventMovement 1 ten seconds later, the client leaves ~20 s after.
      this.sendMatchEnd(event.winner);
      setTimeout(() => void this.postMatchResult(), Number(process.env.LOKI_END_DELAY_MS || 15_000));
    }
  }

  private sendMatchEnd(winner: number | null) {
    if (process.env.LOKI_END_SCREEN === "0") return;
    const G = SV_CLASS.gameState, P = SV_CLASS.playerState;
    const pawn = [...this.players.values()].find((p) => p.team === winner && p.alive)?.actorGuid ?? 0n;
    for (const conn of this.conns.values()) {
      if (conn.state !== "joined") continue;
      this.sendGsProps(conn, [
        this.val(G, "bGetPreventWeaponFire", true), this.val(G, "WinningTeam", winner ?? -1),
        ...(pawn && conn.channels.has(Number([...this.players.values()].find((p) => p.actorGuid === pawn)!.channel) + 1) ? [this.val(G, "WinningPawn", pawn)] : []),
      ]);
      for (const p of this.players.values()) if (p.connKey === this.key(conn.addr)) this.sendPsProps(conn, p, [this.val(P, "BattleRoyalePlayerPhase", 4)]);
      setTimeout(() => { if (this.conns.has(this.key(conn.addr))) this.sendGsProps(conn, [this.val(G, "bGetPreventMovement", true)]); }, 10_000);
    }
    this.log(`[match] end screen winner=${winner}`);
  }

  private syncMatchState() {
    const snap = this.match.getSnapshot();
    const live = new Set(snap.combatants.map((c) => c.id));
    for (const [id, p] of this.players) if (p.isBot && !p.spawned && !live.has(id)) this.players.delete(id);
    for (const c of snap.combatants) {
      if (c.isBot && !this.players.has(c.id)) {
        const ordinal = this.nextActorOrdinal++;
        const angle = (ordinal / Math.max(1, this.options.maxPlayers)) * Math.PI * 2;
        const radius = 2000 + (ordinal % 4) * 500;
        this.players.set(c.id, {
          id: c.id, name: c.name, matchId: this.currentMatchId, heroId: c.heroId, skin: this.roster.get(c.id)?.skin,
          actorGuid: 0x1000n + BigInt(ordinal) * 0x10n,
          psGuid: 0x2000n + BigInt(ordinal) * 0x10n,
          pcGuid: 0x3000n + BigInt(ordinal) * 0x10n,
          channel: 5 + ordinal * 3,
          x: c.x, y: c.y, z: c.z, vx: c.vx, vy: c.vy, vz: c.vz, yaw: c.yaw, pitch: c.pitch,
          health: c.hp, maxHealth: c.maxHp, shield: c.shield, maxShield: c.maxShield,
          alive: c.alive, kills: c.kills, deaths: c.deaths, assists: c.assists, score: c.score,
          team: c.team, isBot: true, spawned: false, lastMoveMs: Date.now(), connKey: `bot:${c.id}`, kind: c.kind,
        });
      }
      const p = this.players.get(c.id);
      if (!p) continue;
      p.x = c.x; p.y = c.y; p.z = c.z;
      p.vx = c.vx; p.vy = c.vy; p.vz = c.vz;
      p.yaw = c.yaw; p.pitch = c.pitch;
      p.health = c.hp; p.maxHealth = c.maxHp;
      p.shield = c.shield; p.maxShield = c.maxShield;
      p.alive = c.alive;
      p.kills = c.kills; p.deaths = c.deaths; p.assists = c.assists; p.score = c.score;
      p.team = c.team;
      p.moveMode = c.grounded ? 1 : 3;
    }
    for (const conn of this.conns.values()) {
      if (conn.state !== "joined") continue;
      for (const p of this.players.values()) if (p.spawned) this.spawnPlayer(conn, p);
    }
  }

  private async postMatchResult() {
    const key = this.currentMatchId || this.match.matchId;
    if (!this.config.autoComplete || !key || this.postedResults.has(key)) return;
    this.postedResults.add(key);
    const result = this.match.result;
    try {
      const res = await fetch(`${this.options.backendUrl}/core-game/matches/${encodeURIComponent(key)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ Results: result.results }),
      });
      this.log(`[match] result posted match=${key} status=${res.status}`);
    } catch (err) {
      this.log("[match] result post failed", err instanceof Error ? err.message : err);
    }
  }

  private currentEndpoint(): string | null {
    if (this.options.publicHost) {
      return `${this.options.publicHost}:${this.options.publicPort || this.options.udpPort}`;
    }
    return null;
  }

  private key(addr: { address: string; port: number }) { return `${addr.address}:${addr.port}`; }

  private async registerWithBackend() {
    const endpoint = this.currentEndpoint();
    if (!endpoint) { this.log("[ue] backend registration skipped: no public UDP endpoint"); return; }
    const split = endpoint.lastIndexOf(":");
    const host = endpoint.slice(0, split);
    const port = Number(endpoint.slice(split + 1));
    try {
      const res = await fetch(`${this.options.backendUrl}/api/ds/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: this.serverId, host, port, region: this.options.region,
          mapName: this.currentMap, gameMode: this.currentGameMode,
          maxPlayers: this.options.maxPlayers, matchId: this.currentMatchId || undefined,
        }),
      });
      this.log(`[ue] backend register ${res.status}`);
    } catch (err) {
      this.log("[ue] backend register failed", err instanceof Error ? err.message : err);
    }
  }

  /** userId -> seat from the backend match (`/core-game/matches/:id/details` Teams[].Members[]). */
  private roster = new Map<string, { team: number; heroId?: string; name: string; isBot: boolean; skin?: string }>();
  private rosterMatch = "";
  private rosterWait: Promise<void> = Promise.resolve();

  private async loadRoster(matchId: string) {
    if (!matchId || matchId === "unknown" || matchId === this.rosterMatch || process.env.LOKI_ROSTER === "0") return;
    try {
      const res = await fetch(`${this.options.backendUrl}/core-game/matches/${encodeURIComponent(matchId)}/details`);
      if (!res.ok) return;
      const m = await res.json() as { QueueID?: string; ArmoryEnabled?: boolean; GameConfig?: { MapName?: string; GameMode?: string }; Teams?: Array<{ TeamId: number; Members: Array<{ UserId: string; DisplayName?: string; TeamId: number; HeroId?: string; IsBot?: boolean; Cosmetics?: string }> }> };
      const members: Array<{ id: string; name: string; team: number; heroId?: string; isBot: boolean; skin?: string }> = [];
      for (const t of m.Teams || []) for (const mem of t.Members || []) {
        members.push({ id: mem.UserId, name: mem.DisplayName || mem.UserId, team: Number(mem.TeamId ?? t.TeamId) || 0, heroId: mem.HeroId || undefined, isBot: !!mem.IsBot, skin: mem.Cosmetics || undefined });
      }
      if (!members.length) return;
      this.rosterMatch = matchId;
      this.roster = new Map(members.map((x) => [x.id, x]));
      if (typeof m.QueueID === "string") this.currentQueueId = m.QueueID;
      // Backend decides per match whether the Armory system is on (classic = pre-Armory rules).
      this.matchArmory = typeof m.ArmoryEnabled === "boolean" ? m.ArmoryEnabled : undefined;
      this.applyModeProfile();
      this.setupZone();
      this.match.applyRoster(members);
      for (const p of this.players.values()) {
        const seat = this.roster.get(p.id);
        if (seat) { p.team = seat.team; p.name = seat.name; if (seat.skin) p.skin = seat.skin; if (seat.heroId && !p.spawned) p.heroId = seat.heroId; }
      }
      this.syncMatchState();
      this.log(`[ue] roster match=${matchId} players=${members.length} humans=${members.filter((x) => !x.isBot).length} teams=${new Set(members.map((x) => x.team)).size}`);
    } catch (err) {
      this.log("[ue] roster fetch failed", err instanceof Error ? err.message : err);
    }
  }

  private async heartbeat() {
    try {
      const res = await fetch(`${this.options.backendUrl}/api/ds/servers/${encodeURIComponent(this.serverId)}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: this.conns.size ? "in_progress" : "ready", playerCount: this.players.size }),
      });
      if (res.status === 404) {
        await this.registerWithBackend();
        return;
      }
      const data = await res.json().catch(() => null) as { allocation?: Record<string, unknown> } | null;
      const alloc = data?.allocation;
      if (alloc && typeof alloc === "object") {
        if (typeof alloc.MapName === "string") this.currentMap = alloc.MapName;
        if (typeof alloc.GameMode === "string") this.currentGameMode = alloc.GameMode;
        if (typeof alloc.QueueID === "string") this.currentQueueId = alloc.QueueID;
        this.applyModeProfile();
        this.setupZone();
        const mid = typeof alloc.MatchId === "string" ? alloc.MatchId : "";
        if (mid) {
          this.currentMatchId = mid;
          if (!this.readyMatches.has(mid)) {
            this.readyMatches.add(mid);
            void fetch(`${this.options.backendUrl}/api/ds/matches/${encodeURIComponent(mid)}/ready`, {
              method: "POST", headers: { "content-type": "application/json" }, body: "{}",
            }).catch(() => {});
            this.log(`[ue] marked allocation ready match=${mid}`);
          }
        }
      }
    } catch {}
  }

  private onDatagram(data: Buffer, addr: { address: string; port: number }) {
    if (!data.length) return;
    const key = this.key(addr);
    this.cap("rx", addr, data);
    const hasRealPrefix = detectRealPrefix(data);
    // Real Loki packets carry a 64-bit wrapper prefix; the handshake / game layout starts at byte 8.
    const body = hasRealPrefix ? data.subarray(8) : data;
    const known = this.conns.get(key);
    if (known) {
      // Established peer: everything is game data; only a well-formed handshake
      // packet is treated as a re-handshake (UE restarts are rare, sized 228/388 bits).
      known.lastSeenMs = Date.now();
      if (hasRealPrefix) {
        try {
          const parsed = tryParseRealPacket(body);
          if (parsed) { this.onRealPacket(known, parsed); return; }
        } catch {}
        this.log(`[ue] real packet parse failed ${key} len=${data.length} hex=${data.subarray(0, 48).toString("hex")}`);
        return;
      }
      if (isHandshake(data)) {
        try { this.onHandshake(data, addr); } catch (e) { this.log("[ue] bad handshake", e instanceof Error ? e.message : e); }
        return;
      }
      const stripped = this.stripKnown(data, known);
      if (!stripped) {
        this.log(`[ue] unknown-packet ${key} len=${data.length} hex=${data.subarray(0, 48).toString("hex")}`);
        if (process.env.UE_DEBUG_RAW) {
          this.log(`[ue] RAW ${data.length}B from ${key}: ${data.toString("hex").slice(0, 240)}`);
        }
        return;
      }
      known.clientId = stripped.clientId;
      known.travelCount = stripped.travelCount;
      try { this.onPacket(known, stripped.reader); }
      catch (e) { this.log(`[ue] packet error ${key}:`, e instanceof Error ? e.message : e); }
      return;
    }
    if (isHandshake(body)) {
      try { this.onHandshake(data, addr); } catch (e) { this.log("[ue] bad handshake", e instanceof Error ? e.message : e); }
      return;
    }
    if (hasRealPrefix) {
      if (this.tryRealHandshake(data, addr)) return;
      if (this.tryMigrate(body, addr)) return;
      this.log(`[ue] real packet from unknown peer ${key} len=${data.length} hex=${data.toString("hex").slice(0, 200)}`);
      return;
    }
    const stripped = stripHandler(data);
    if (!stripped) {
      this.log(`[ue] unknown-packet ${key} len=${data.length} hex=${data.subarray(0, 48).toString("hex")}`);
      if (process.env.UE_DEBUG_RAW) {
        this.log(`[ue] RAW ${data.length}B from ${key}: ${data.toString("hex").slice(0, 240)}`);
      }
      return;
    }
    // Late packet from a client whose handshake was lost — re-issue challenge.
    this.log(`[ue] packet from unknown peer ${key}; requesting handshake retry`);
  }

  /** Known-peer packet prefix: real Loki uses 4-bit travel + 8-bit client id,
   *  stock UE5 clients use 2-bit travel + 3-bit client id. Pick the variant
   *  whose packed sequence header is fresh for this connection. */
  private stripKnown(data: Uint8Array, known: UEConn) {
    // Non-magic packets are stock-UE clients (2b/3b prefix); Loki's 4b/8b only
    // arrives with the magic prefix, which takes the tryParseRealPacket path.
    return stripHandler(data, (seq) => this.seqFresh(seq, known.seqIn));
  }

  private seqFresh(headerSeq: number, seqIn: number): boolean {
    return headerSeq !== seqIn && this.seqDiff(headerSeq, seqIn) <= 0x2000;
  }

  /** NAT rebinding: a known client's packets arrive from a new public ip:port
   *  (seen live: the client's public address and port changed mid-match). Move the
   *  connection to the new address when exactly one live conn's seqIn is just
   *  behind the packet's header sequence. LOKI_MIGRATE=0 disables. */
  private tryMigrate(body: Uint8Array, addr: { address: string; port: number }): boolean {
    if (process.env.LOKI_MIGRATE === "0") return false;
    let parsed: ReturnType<typeof tryParseRealPacket> = null;
    try { parsed = tryParseRealPacket(body); } catch { return false; }
    if (!parsed) return false;
    const now = Date.now();
    const cands: [string, UEConn][] = [];
    for (const [k, c] of this.conns) {
      const d = (parsed.headerSeq - c.seqIn + 16384) % 16384;
      if (d >= 1 && d <= 512 && now - c.lastSeenMs < 30000) cands.push([k, c]);
    }
    if (cands.length !== 1) {
      if (cands.length > 1) this.log(`[ue] migrate ambiguous seq=${parsed.headerSeq} cands=${cands.length}`);
      return false;
    }
    const [oldKey, conn] = cands[0];
    const newKey = this.key(addr);
    this.conns.delete(oldKey);
    conn.addr = { address: addr.address, port: addr.port };
    this.conns.set(newKey, conn);
    for (const p of this.players.values()) if (p.connKey === oldKey) p.connKey = newKey;
    this.log(`[ue] migrated ${oldKey} -> ${newKey} seq=${parsed.headerSeq} in=${conn.seqIn}`);
    this.onRealPacket(conn, parsed);
    return true;
  }

  private onRealPacket(conn: UEConn, parsed: NonNullable<ReturnType<typeof tryParseRealPacket>>) {
    conn.lastSeenMs = Date.now();
    if (this.seqDiff(parsed.headerSeq, conn.seqIn) > 0x2000) return; // stale/reordered
    this.applyAcks(conn, parsed.ackedSeq, parsed.history);
    conn.seqIn = parsed.headerSeq;
    for (const bunch of parsed.bunches) {
      try { this.handleBunch(conn, bunch); } catch (e) {
        this.log(`[ue] real bunch error ${this.key(conn.addr)} ch=${bunch.chIndex} bits=${bunch.bits} exp=${+bunch.bHasPackageMapExports} must=${+bunch.bHasMustBeMappedGUIDs} part=${+bunch.bPartial}:`, e instanceof Error ? e.message : e, Buffer.from(bunch.data).toString("hex").slice(0, 160));
      }
    }
    if (parsed.bunches.length && !conn.batch) this.sendKeepalive(conn);
  }

  private tryRealHandshake(data: Buffer, addr: { address: string; port: number }): boolean {
    const body = detectRealPrefix(data) ? data.subarray(8) : data;
    let parsed: ReturnType<typeof tryParseRealPacket> = null;
    try { parsed = tryParseRealPacket(body); } catch { return false; }
    if (!parsed) return false;
    const helloBunch = parsed.bunches.find(
      (b) => b.chIndex === 0 && b.bits >= 64 && b.data.length > 0 && b.data[0] === NMT.Hello,
    );
    if (!helloBunch) return false;
    const conn = new UEConn(addr, 0, 0);
    conn.wire = "real";
    conn.realPrefix = detectRealPrefix(data) ? data.slice(0, 8) : undefined;
    conn.jitterInfo = parsed.jitter;
    conn.seqIn = parsed.headerSeq;
    conn.lastSeenMs = Date.now();
    const payload = new BitReader(helloBunch.data, helloBunch.bits);
    payload.uint8();
    try {
      conn.hello = readHello(payload);
    } catch {
      return false;
    }
    this.conns.set(this.key(addr), conn);
    this.log(`[ue] real-client hello ${this.key(addr)} netver=${conn.hello.version} jitter=${parsed.jitter} features=${conn.hello.runtimeFeatures}`);
    conn.state = "challenge";
    this.sendControl(conn, (w) => {
      w.uint8(NMT.Challenge);
      writeChallenge(w, crypto.randomBytes(16).toString("hex"));
    }, false);
    return true;
  }

  private onHandshake(data: Buffer, addr: { address: string; port: number }, prefixBytes: Uint8Array | null = null) {
    let hs: ReturnType<typeof parseHandshake>;
    try {
      hs = parseHandshake(prefixBytes ? Buffer.concat([prefixBytes, data]) : data);
    } catch (e) {
      this.log(`[ue] bad handshake from ${this.key(addr)} len=${data.length} hex=${data.subarray(0, 64).toString("hex")}`);
      return;
    }
    if (prefixBytes && !hs.realPrefix) hs.realPrefix = prefixBytes;
    const now = (Date.now() - Date.UTC(2000, 0, 1)) / 1000;
    const timestamp = hs.timestamp > 0 ? hs.timestamp : now;
    const cookieAddr = `${addr.address}:${addr.port}`;
    if (hs.restarted) {
      const ch = makeChallenge(hs, this.handshakeSecret(hs.secretId), cookieAddr, timestamp, hs.secretId);
      this.sendRaw(addr, ch.packet);
      this.log(`[ue] handshake restart -> fresh challenge ${this.key(addr)}`);
      return;
    }
    // Real UE has no packet-type field: a handshake packet whose cookie validates
    // against (secretId, timestamp, address) is the client's response; anything
    // else is an initial request and gets a fresh challenge.
    const regen = generateCookie(this.handshakeSecret(hs.secretId), cookieAddr, hs.timestamp);
    const cookieOk = hs.timestamp > 0 && regen.length === hs.cookie.length && regen.every((b, i) => b === hs.cookie[i]);
    if (cookieOk) {
      const conn = new UEConn(addr, hs.clientId, hs.travelCount);
      // The ack cookie is an HMAC value, NOT a sequence pair — seeding seqs from it
      // produced garbage AckSeq (16383+) that made the client discard our Challenge
      // (GetSequenceDelta rejects AckedSeq >= OutSeq). Real client game packets start
      // at Seq 1; the first real packet overwrites seqIn below.
      conn.seqIn = 0;
      conn.seqOut = SEQ_START;
      this.conns.set(this.key(addr), conn);
      // Exactly one ack, byte-for-byte StatelessConnectHandlerComponent::SendChallengeAck:
      // SecretId bit = 1, Timestamp = -1.0 (client requires < 0), cookie = authorised cookie.
      this.sendRaw(addr, makeAck(hs, hs.cookie, "none", undefined, { packetType: 3, timestamp: -1, secretId: 1 }));
      this.log(`[ue] handshake complete ${this.key(addr)} clientId=${hs.clientId} cookie ok resp=${data.length}B respTs=${hs.timestamp.toFixed(3)} seqIn=${conn.seqIn} seqOut=${conn.seqOut}`);
      return;
    }
    const secretId = hs.secretId === 1 ? 1 : 0;
    // Single StatelessConnectHandlerComponent::SendConnectChallenge, frame-less
    // (proven accepted: the client echoes the challenge ts/cookie verbatim).
    const ch = makeChallenge(hs, this.handshakeSecret(secretId), cookieAddr, timestamp, secretId, "none");
    this.sendRaw(addr, ch.packet);
    this.log(`[ue] handshake challenge -> ${this.key(addr)} ts=${timestamp.toFixed(3)} cookie=${ch.cookie.toString("hex").slice(0, 16)}…`);
  }

  private handshakeSecret(id: number): Uint8Array {
    if (id !== 0 && id !== 1) id = 0;
    return this.hsSecrets[id]!;
  }

  private tickHandshakeSecrets() {
    const elapsed = (Date.now() - Date.UTC(2000, 0, 1)) / 1000;
    this.hsTickCount++;
    if (this.hsTickCount % 75 === 0) {
      this.hsActiveSecret = 1 - this.hsActiveSecret;
      this.hsSecrets[this.hsActiveSecret] = crypto.randomBytes(64);
      this.hsLastSecretUpdate = elapsed;
    }
  }

  private capCounts = new Map<string, number>();
  private cap(dir: "rx" | "tx", addr: { address: string; port: number }, data: Uint8Array, note = "") {
    if (!CAPTURE_DIR) return;
    const k = `${addr.address}:${dir}`;
    const n = this.capCounts.get(k) || 0;
    if (n >= 600) return;
    this.capCounts.set(k, n + 1);
    try {
      mkdirSync(CAPTURE_DIR, { recursive: true });
      appendFileSync(`${CAPTURE_DIR}/ue-${addr.address}.jsonl`,
        JSON.stringify({ t: Date.now(), dir, a: `${addr.address}:${addr.port}`, len: data.length, note, hex: Buffer.from(data).toString("hex") }) + "\n");
    } catch {}
  }

  private sendRaw(addr: { address: string; port: number }, buf: Uint8Array) {
    this.cap("tx", addr, buf);
    try { this.socket.send(Buffer.from(buf), addr.port, addr.address); }
    catch (e) { this.log("[ue] send error", e); }
  }

  private beginPacket(conn: UEConn) {
    const w = new BitWriter(1400);
    this.writeNotifyHeader(w, conn);
    if (conn.jitterInfo) {
      w.bit(true);
      w.serializeInt(80, 1024);
      w.bit(false);
    }
    return w;
  }

  private writeNotifyHeader(w: BitWriter, conn: UEConn) {
    const historyLength = Math.max(0, Math.min(256, this.seqDiff(conn.seqIn, conn.seqAcked)));
    const wordCount = Math.max(1, Math.ceil(historyLength / 32));
    const packed = (BigInt(conn.seqOut & 0x3fff) << 18n) |
      (BigInt(conn.seqIn & 0x3fff) << 4n) | BigInt(wordCount - 1);
    w.uint32(Number(packed));
    for (let i = 0; i < wordCount; i++) w.uint32(0xffffffff);
  }

  private endPacket(conn: UEConn, w: BitWriter, reliable?: Bunch[], createdAt?: number) {
    const inner = conn.wire === "real" ? finalizePacket(w) : finalizePacket(w);
    const outer = addHandler(inner, conn.travelCount, conn.clientId, w.bits, conn.wire === "real" ? conn.realPrefix : undefined);
    const packetId = conn.seqOut;
    conn.seqOut = (conn.seqOut + 1) & 0x3fff;
    if (PACE_BPS > 0) { conn.outQ.push(outer); this.drainOut(conn); }
    else this.sendRaw(conn.addr, outer);
    if (reliable?.length) {
      const now = Date.now();
      conn.sentPackets.set(packetId, { bunches: reliable, at: now, createdAt: createdAt ?? now });
    }
    return outer;
  }

  private sendBunch(conn: UEConn, body: (w: BitWriter) => void, opts: {
    ch: number; open?: boolean; close?: boolean; reliable?: boolean;
    nameIndex?: number; exports?: GuidExport[]; mustBeMapped?: bigint[];
  }) {
    const w = this.beginPacket(conn);
    const bunch = newBunch();
    bunch.chIndex = opts.ch;
    bunch.bOpen = !!opts.open;
    bunch.bClose = !!opts.close;
    bunch.closeReason = DESTROYED;
    bunch.bReliable = opts.reliable !== false;
    bunch.chNameIndex = opts.nameIndex ?? EChannelName.Actor;
    bunch.bHasPackageMapExports = !!opts.exports?.length;
    if (bunch.bReliable) bunch.chSequence = conn.nextReliable(opts.ch);
    const payload = new BitWriter(2048);
    if (opts.exports?.length) writeNetGuidExportSection(payload, opts.exports);
    // UActorChannel: after the export section, uint16 count + NetGUIDs the client must
    // finish async-loading before it processes the bunch (spawn archetypes). Without it a
    // not-yet-loaded hero BP fails with "Unresolved Archetype GUID".
    if (opts.mustBeMapped?.length) {
      bunch.bHasMustBeMappedGUIDs = true;
      payload.uint16(opts.mustBeMapped.length);
      for (const g of opts.mustBeMapped) writeNetGuid(payload, g);
    }
    body(payload);
    bunch.data = payload.buffer();
    bunch.bits = payload.bits;
    if (conn.txLogged++ < 60) this.log(`[ue] tx ch=${opts.ch} seq=${bunch.chSequence} rel=${bunch.bReliable ? 1 : 0} open=${bunch.bOpen ? 1 : 0} close=${bunch.bClose ? 1 : 0} bits=${bunch.bits} outSeq=${conn.seqOut} ack=${conn.seqIn}`);
    if (conn.batch) { this.batchBunch(conn, bunch); return new Uint8Array(0); }
    writeBunch(bunch, w, conn.wire === "real");
    return this.endPacket(conn, w, bunch.bReliable ? [bunch] : undefined);
  }

  /** Appends one bunch to the connection's open coalescing packet, flushing first if it would not fit. */
  private batchBunch(conn: UEConn, bunch: Bunch) {
    const tmp = new BitWriter(bunch.bits + 256);
    writeBunch(bunch, tmp, conn.wire === "real");
    if (conn.batch!.count > 0 && conn.batch!.w.bits + tmp.bits > PACKET_BITS) this.flushBatch(conn, true);
    conn.batch!.w.bitsFrom(tmp.buffer(), tmp.bits);
    conn.batch!.count++;
    if (bunch.bReliable) conn.batch!.bunches.push(bunch);
  }

  private beginBatch(conn: UEConn) { conn.batch = { w: this.beginPacket(conn), bunches: [], count: 0 }; }

  /** Sends the open coalescing packet (if it has bunches). With reopen, starts a fresh one. */
  private flushBatch(conn: UEConn, reopen = false) {
    const b = conn.batch;
    if (!b) return;
    conn.batch = null;
    if (b.count > 0) this.endPacket(conn, b.w, b.bunches.length ? b.bunches : undefined);
    if (reopen) this.beginBatch(conn);
  }

  private sendControl(conn: UEConn, body: (w: BitWriter) => void, open = false) {
    const packet = this.sendBunch(conn, body, { ch: 0, open, reliable: true, nameIndex: EChannelName.Control });
    this.log(`[ue] tx control bytes=${packet.length} open=${open}`);
  }

  private onPacket(conn: UEConn, reader: BitReader, jitter = true) {
    const packed = BigInt(reader.uint32());
    const headerSeq = Number((packed >> 18n) & 0x3fffn);
    const ackedSeq = Number((packed >> 4n) & 0x3fffn);
    const historyCount = Math.min(8, Number(packed & 0xfn) + 1);
    const history = new Array<number>(historyCount);
    for (let i = 0; i < historyCount; i++) history[i] = reader.uint32();
    if (jitter) {
      if (reader.bit()) {
        reader.serializeInt(1024);
        // Server receive path: the client writes bHasServerFrameTime but never the
        // frame-time byte (WriteDummyPacketInfo only writes it when IsServer).
        reader.bit();
      }
    }
    if (headerSeq === conn.seqIn || this.seqDiff(headerSeq, conn.seqIn) > 0x2000) {
      if (conn.dupLogged++ < 20) this.log(`[ue] rx dup/stale seq=${headerSeq} in=${conn.seqIn} acked=${ackedSeq} outSeq=${conn.seqOut} bitsLeft=${reader.bitsLeft} ${this.key(conn.addr)}`);
      return;
    }
    this.applyAcks(conn, ackedSeq, history);
    conn.seqIn = headerSeq;
    let gotBunch = false;
    while (reader.bitsLeft >= 10) {
      try {
        const bunch = readBunch(reader, headerSeq);
        gotBunch = true;
        this.handleBunch(conn, bunch);
      } catch {
        break;
      }
    }
    if (gotBunch) this.sendKeepalive(conn);
  }

  private seqDiff(a: number, b: number) { return (a - b) & 0x3fff; }

  /** Client's AckedSeq + history bitmap: bit i (LSB-first across words) = our packet (ackedSeq - i)
   *  delivered. UE resends reliable bunches ONLY on NAK, so undelivered bits are resent once here. */
  private applyAcks(conn: UEConn, ackedSeq: number, history: number[]) {
    const d = this.seqDiff(conn.seqOut, ackedSeq);
    if (!(d > 0 && d < 0x2000)) return;
    if (this.seqDiff(ackedSeq, conn.seqAcked) >= 0x2000) return; // older than what we already know
    conn.seqAcked = ackedSeq;
    for (const [seq, packets] of Array.from(conn.sentPackets)) {
      if (this.seqDiff(seq, ackedSeq) > 0 && this.seqDiff(seq, ackedSeq) < 0x2000) continue; // not acked yet
      const back = this.seqDiff(ackedSeq, seq);
      const word = back >>> 5, bit = back & 31;
      const delivered = word < history.length ? ((history[word]! >>> bit) & 1) === 1 : true;
      conn.sentPackets.delete(seq);
      if (!delivered) this.resendBunches(conn, packets.bunches, packets.createdAt);
    }
  }

  /** Server packets the client has not acked yet. The client's FNetPacketNotify keeps 256 entries of history;
   *  overrun it and it stalls in SetWaitForSequenceHistoryFlush, drops everything and times out. */
  /** UE retransmits reliable *bunches*, never packets: a packet number at or below the client's InSeq is
   *  dropped as outdated, so lost bunches go out again in fresh packets (new seq, current ack header). */
  private resendBunches(conn: UEConn, bunches: Bunch[], createdAt: number) {
    if (!bunches.length) return;
    conn.resent = (conn.resent || 0) + bunches.length;
    if (conn.batch) { for (const b of bunches) this.batchBunch(conn, b); return; }
    let w = this.beginPacket(conn);
    let list: Bunch[] = [];
    for (const b of bunches) {
      const tmp = new BitWriter(b.bits + 256);
      writeBunch(b, tmp, conn.wire === "real");
      if (list.length && w.bits + tmp.bits > PACKET_BITS) { this.endPacket(conn, w, list, createdAt); w = this.beginPacket(conn); list = []; }
      w.bitsFrom(tmp.buffer(), tmp.bits);
      list.push(b);
    }
    this.endPacket(conn, w, list, createdAt);
  }

  private inflight(conn: UEConn) { return this.seqDiff(conn.seqOut, conn.seqAcked); }

  /** Sends queued game datagrams within the connection's byte budget (order preserved). */
  private drainOut(conn: UEConn) {
    const now = Date.now();
    conn.paceTokens = Math.min(PACE_BURST, conn.paceTokens + ((now - conn.paceAt) / 1000) * PACE_BPS);
    conn.paceAt = now;
    while (conn.outQ.length && conn.paceTokens >= Math.min(conn.outQ[0]!.length, PACE_BURST)) {
      const buf = conn.outQ.shift()!;
      conn.paceTokens -= buf.length;
      this.sendRaw(conn.addr, buf);
    }
  }

  private sendKeepalive(conn: UEConn) {
    this.endPacket(conn, this.beginPacket(conn));
  }

  private handleBunch(conn: UEConn, bunch: Bunch) {
    if (bunch.chIndex === 0 && bunch.bClose) {
      // The client closed its control channel: it left the match (menu "leave", quit, travel back to the
      // lobby). Before CLOSE_REASON_MAX was fixed this packet never parsed and the player lingered for 60 s.
      this.log(`[ue] client closed control channel ${this.key(conn.addr)} player=${conn.login?.playerId || "?"}`);
      this.dropConnection(conn);
      return;
    }
    if (bunch.chIndex === 0) {
      const payload = new BitReader(bunch.data, bunch.bits);
      if (payload.bitsLeft < 8) return;
      this.handleControl(conn, payload.uint8(), payload);
      return;
    }
    if (bunch.bOpen) conn.channels.add(bunch.chIndex);
    if (bunch.bClose) {
      conn.channels.delete(bunch.chIndex);
      return;
    }
    if (!bunch.bits) return;
    const player = Array.from(this.players.values()).find(
      (p) => p.connKey === this.key(conn.addr) && p.channel + 1 === bunch.chIndex,
    );
    if (player) { this.onHeroBunch(conn, player, bunch); return; }
    const pcOwner = Array.from(this.players.values()).find(
      (p) => p.connKey === this.key(conn.addr) && p.channel === bunch.chIndex,
    );
    if (pcOwner) {
      // [armory] Comp_PlayerController_Armory RPC blocks (armory.ts); the rest continues to interact / loot / onPcBunch
      const ar = this.armory?.onPcBunch(conn, pcOwner, bunch.data, bunch.bits);
      if (ar) { if (!ar.bits) return; bunch = { ...bunch, data: ar.data, bits: ar.bits }; }
      // [interact] shop-component RPC blocks first; whatever else the bunch carried continues to loot / onPcBunch
      const ir = this.interact?.onPcBunch(conn, pcOwner, bunch.data, bunch.bits);
      if (ir) { if (!ir.bits) return; bunch = { ...bunch, data: ir.data, bits: ir.bits }; }
      // [loot] hook: loot-component subobject blocks (LokiInteractionPlayerComponent / LokiInventoryOperationsV2) go to loot.ts;
      // any actor-block RPCs in the same bunch are re-fed to onPcBunch unchanged.
      const lr = this.loot?.onPcBunch(conn, pcOwner, bunch.data, bunch.bits);
      if (lr) {
        if (lr.actorBlocks.length) {
          const w = new BitWriter(bunch.bits + 64);
          for (const b of lr.actorBlocks) Loot.writeClientBlock(w, b);
          this.onPcBunch(conn, pcOwner, { ...bunch, data: w.buffer(), bits: w.bits });
        }
        return;
      }
      this.logUnknownPcBlocks(pcOwner, bunch);
      this.onPcBunch(conn, pcOwner, bunch); return;
    }
    const psOwner = Array.from(this.players.values()).find(
      (p) => p.connKey === this.key(conn.addr) && p.channel - 1 === bunch.chIndex,
    );
    if (psOwner) { this.onPsBunch(conn, psOwner, bunch); return; }
    const carOwner = Array.from(this.players.values()).find(
      (p) => p.connKey === this.key(conn.addr) && CARRIER_CH_BASE + this.statsOrdinal(p) === bunch.chIndex,
    );
    if (carOwner) this.onCarrierBunch(conn, carOwner, bunch);
  }

  private startMs = Date.now();
  private pcRpcSeen = new Set<number>();

  /** Owning PlayerController channel from the client. Retail replies decoded from recorded retail traffic
   *  (the capture decoder (not shipped)): 140 ServerEchoTimestamp(f32) -> 125 ClientProcessTimestampEcho(f32 clientTs,
   *  f32 serverWorldTime, f32 serverDelta); 93 ServerUpdateLevelVisibility with a valid 9-bit transaction
   *  (cell unload) -> 19 ClientAckUpdateLevelVisibility(FName pkg, txn echoed, bClientAckCanMakeVisible=1). */
  /** Subobject RPC blocks on the PC channel that no handler claimed used to vanish silently (shop / chest RPCs addressed to a
   *  component or usable we name differently). Log each distinct one (LOKI_LOG_PC_BLOCKS=0 = off). */
  private pcBlockSeen = new Map<string, number>();
  private logUnknownPcBlocks(player: Player, bunch: Bunch) {
    if (process.env.LOKI_LOG_PC_BLOCKS === "0") return;
    const blocks = Loot.parseClientBlocks(bunch.data, bunch.bits);
    if (!blocks) { this.log(`[ue] pc bunch unparsed from ${player.id} bits=${bunch.bits}`); return; }
    for (const b of blocks) {
      if (b.isActor) continue;
      const k = Loot.describeRef(b.obj);
      const n = (this.pcBlockSeen.get(k) ?? 0) + 1;
      this.pcBlockSeen.set(k, n);
      if (n <= 5 || n % 100 === 0) {
        const hex = Buffer.from(b.data).toString("hex").slice(0, 96);
        this.log(`[ue] pc subobject block UNHANDLED obj=${k} rep=${b.rep ? 1 : 0} bits=${b.bits} from ${player.id} #${n} data=${hex}`);
      }
    }
  }

  private onPcBunch(conn: UEConn, player: Player, bunch: Bunch) {
    for (const f of readRpcFields(bunch.data, bunch.bits, Number(process.env.LOKI_PC_FIELD_MAX || 162))) {
      try {
        if (f.idx === 140 && process.env.LOKI_TS_ECHO !== "0") {
          const r = new BitReader(f.data, f.bits);
          if (!r.bit()) continue;
          const clientTs = r.float();
          const now = (Date.now() - this.startMs) / 1000;
          this.sendPcRpc(conn, player, "ClientProcessTimestampEcho", 125, (p) => {
            p.bit(true); p.float(clientTs); p.bit(true); p.float(now); p.bit(true); p.float(1 / 30);
          }, undefined, undefined, true);
        } else if (f.idx === 93 && process.env.LOKI_VIS_ACK !== "0") {
          const r = new BitReader(f.data, f.bits);
          r.bit(); r.bit(); const visible = r.bit(); r.bit(); r.bit(); // pres, same, bIsVisible, 2 flags
          if (r.bit()) continue; // hardcoded FName — not a level package
          const pkg = r.fstring(); r.uint32();
          if (!r.bit()) continue; // no transaction requested -> no ack (retail)
          const txn = r.bitsFrom(8)[0]!;
          this.sendPcRpc(conn, player, "ClientAckUpdateLevelVisibility", 19, (p) => {
            p.bit(true); p.bit(false); p.fstring(pkg); p.uint32(0);
            p.bit(true); p.bit(true); p.bitsFrom(Uint8Array.of(txn), 8);
            p.bit(true);
          }, undefined, undefined, true);
          void visible;
        } else if (f.idx === 78 && process.env.LOKI_POSSESS_CHECK !== "0") {
          // ServerCheckClientPossessionReliable: the client has no (or the wrong) pawn. Make sure its hero is
          // open on this connection and possess it again (retail answers with ClientRestart).
          const now = Date.now();
          if (now - (player.possessCheckAt || 0) > 1500 && (!this.dropEnabled() || conn.drop.landed)) {
            player.possessCheckAt = now;
            if (!conn.channels.has(player.channel + 1)) { conn.heroGate = "all"; this.spawnPlayer(conn, player); }
            this.log(`[ue] possession check from ${player.id} -> ClientRestart`);
            setTimeout(() => this.sendClientRestart(conn, player, false), 200);
          }
        } else if (!this.pcRpcSeen.has(f.idx)) {
          this.pcRpcSeen.add(f.idx);
          this.log(`[ue] pc rpc idx=${f.idx} bits=${f.bits} from ${player.id}`);
        }
      } catch {}
    }
  }

  private heroRpcSeen = new Set<number>();
  private moveState = new Map<string, { ts: number; at: number; x: number; y: number; z: number; lastFixAt: number; acks: number; logAt: number; stuckSince?: number; unsticks?: number; lastGood?: [number, number, number]; wedgedSince?: number; lastUnstickAt?: number }>();

  /** Hero actor channel from the owning client: RPC fields only (ServerMovePacked = 32, GAS). */
  private onHeroBunch(conn: UEConn, player: Player, bunch: Bunch) {
    if (this.gasEnabled) this.parseClientMovement(player, bunch);
    let newest: ClientMove | null = null;
    for (const f of readRpcFields(bunch.data, bunch.bits, HERO_FIELD_MAX)) {
      if (f.idx === HERO_FIELD.ServerMovePacked) {
        const m = decodeServerMovePacked(f);
        if (m && (!newest || m.timeStamp >= newest.timeStamp)) newest = m;
      } else if (!this.heroRpcSeen.has(f.idx)) {
        this.heroRpcSeen.add(f.idx);
        this.log(`[ue] hero rpc idx=${f.idx} bits=${f.bits} from ${player.id} (unhandled)`);
      }
    }
    if (newest) this.onClientMove(conn, player, newest);
  }

  /** Client-authoritative CharacterMovement: follow the client, ack every move with
   *  ClientMoveResponsePacked so its saved-move buffer drains (it stops moving at 96 unacked),
   *  and correct only when the hero has fallen out of the world. */
  private onClientMove(conn: UEConn, player: Player, m: ClientMove) {
    const now = Date.now();
    // [loot] Based moves (movement.ts MoveBaseRef): the location is RELATIVE to the base. On a loot box (its slab / mesh, the
    // client's only way into use reach - retail flows 7038/7039) resolve it through the box's frame and remember the box; on any
    // other dynamic base we cannot place (platforms, trains, capture points) keep the last world position and skip the
    // position-based fixes below, but still ack the move.
    let unresolvedBase = false;
    if (m.base) {
      const onBox = this.loot?.resolveBase(m.base);
      const onCamp = onBox ? null : this.capture?.resolveBase(player.id, m.base); // [capture] hook: standing on a basecamp
      if (onBox) { m = { ...m, loc: onBox.world(m.loc) }; player.lootBaseBox = onBox.i; }
      else if (onCamp && this.capture) { m = { ...m, loc: this.capture.baseToWorld(onCamp, m.loc) }; player.lootBaseBox = undefined; }
      else {
        const prev = this.moveState.get(player.id);
        m = { ...m, loc: prev ? [prev.x, prev.y, prev.z] : [player.x, player.y, player.z] };
        player.lootBaseBox = undefined; unresolvedBase = true;
      }
    } else player.lootBaseBox = undefined;
    const st = this.moveState.get(player.id) || { ts: 0, at: now, x: m.loc[0], y: m.loc[1], z: m.loc[2], lastFixAt: 0, acks: 0, logAt: 0 };
    const dt = Math.max(0.001, m.timeStamp - st.ts);
    const fresh = st.ts > 0 && m.timeStamp > st.ts && dt < 1;
    const vx = fresh ? (m.loc[0] - st.x) / dt : 0, vy = fresh ? (m.loc[1] - st.y) / dt : 0, vz = fresh ? (m.loc[2] - st.z) / dt : 0;
    player.x = m.loc[0]; player.y = m.loc[1]; player.z = m.loc[2];
    player.vx = vx; player.vy = vy; player.vz = vz;
    player.yaw = m.yaw; player.pitch = m.pitch;
    player.lastMoveMs = now;
    this.match.setClientState(player.id, { x: m.loc[0], y: m.loc[1], z: m.loc[2], vx, vy, vz, yaw: m.yaw, pitch: m.pitch, grounded: m.mode === MOVE_MODE.Walking });
    const killZ = Number(process.env.LOKI_RESCUE_Z || -700);
    if (!unresolvedBase && m.mode === MOVE_MODE.Walking && m.loc[2] > killZ + 300) {
      st.lastGood = [m.loc[0], m.loc[1], m.loc[2] + 60];
      learnFloor(this.currentMap, m.loc[0], m.loc[1], m.loc[2]);
    }
    let correction: MoveCorrection | undefined;
    const inDrop = this.dropEnabled() && !conn.drop.landed;
    // Abyss: after the streaming grace a real fall off the island is a death (retail), not a free
    // teleport back to land. Respawn modes then bring the player back through the sim's respawn.
    const sim = this.match.get(player.id);
    if (process.env.LOKI_ABYSS_KILL !== "0" && !inDrop && !unresolvedBase && m.loc[2] < killZ - 300
      && now > (player.abyssGraceUntil || 0) && sim?.alive && this.match.isStarted) {
      st.lastFixAt = now;
      this.log(`[ue] abyss death ${player.id} z=${Math.round(m.loc[2])}`);
      this.match.killByAbyss(player.id);
    } else if (process.env.LOKI_RESCUE !== "0" && !inDrop && !unresolvedBase && m.loc[2] < killZ && now - st.lastFixAt > 2000
      && (now <= (player.abyssGraceUntil || 0) || process.env.LOKI_ABYSS_KILL === "0" || !this.match.isStarted)) {
      const sp0 = spawnPointFor(this.currentMap, player.team, player.id);
      const sp = st.lastGood ? { x: st.lastGood[0], y: st.lastGood[1], z: st.lastGood[2], source: "last-good" } : sp0;
      correction = { loc: [sp.x, sp.y, sp.z], vel: [0, 0, 0], mode: MOVE_MODE.Falling };
      st.lastFixAt = now;
      this.log(`[ue] rescue ${player.id} z=${Math.round(m.loc[2])} -> (${sp.x},${sp.y},${sp.z}) ${sp.source}`);
      this.sendClientSetLocation(conn, player, [sp.x, sp.y, sp.z], m.yaw, "rescue");
      st.lastFixAt = now;
    }
    // Landed inside a prop (rocks are not in the floor triangles): the client reports Falling with no motion
    // at all. After LOKI_STUCK_MS put it down on the nearest verified player start (designer-clear ground).
    if (process.env.LOKI_UNSTICK !== "0" && !inDrop && !correction && !unresolvedBase) {
      const still = Math.abs(m.loc[0] - st.x) < 1 && Math.abs(m.loc[1] - st.y) < 1 && Math.abs(m.loc[2] - st.z) < 1;
      if (m.mode === MOVE_MODE.Falling && still) st.stuckSince = st.stuckSince || now;
      else st.stuckSince = 0;
      // Wedged: walking and pushing (accel) but not moving for LOKI_WEDGE_MS -> step to open terrain 350 uu
      // behind the push direction (opposite the wall), found by floorAt; falls back to the nearest player start.
      const pushing = Math.hypot(m.accel[0], m.accel[1]) > 100;
      const crawl = Math.hypot(m.loc[0] - st.x, m.loc[1] - st.y) < 4;
      if (m.mode === MOVE_MODE.Walking && pushing && crawl) st.wedgedSince = st.wedgedSince || now; else st.wedgedSince = 0;
      if (st.wedgedSince && now - st.wedgedSince > Number(process.env.LOKI_WEDGE_MS || 4000) && now - st.lastFixAt > 4000) {
        const back = Math.atan2(-m.accel[1], -m.accel[0]);
        let dest: [number, number, number] | null = null;
        for (const da of [0, 0.6, -0.6, 1.2, -1.2, Math.PI]) for (const r of [350, 600, 900]) {
          if (dest) break;
          const px = m.loc[0] + Math.cos(back + da) * r, py = m.loc[1] + Math.sin(back + da) * r;
          const z = floorAt(this.currentMap, px, py);
          if (z !== null && Math.abs(z - m.loc[2]) < 400) dest = [Math.round(px), Math.round(py), Math.round(z) + 110];
        }
        if (!dest) { const nf = nearestFloor(this.currentMap, m.loc[0], m.loc[1]); if (nf) dest = [nf.x, nf.y, nf.z]; }
        st.wedgedSince = 0; st.lastFixAt = now;
        if (dest) {
          correction = { loc: dest, vel: [0, 0, 0], mode: MOVE_MODE.Falling };
          this.log(`[ue] unwedge ${player.id} at (${m.loc.map(Math.round)}) -> (${dest})`);
          this.sendClientSetLocation(conn, player, dest, m.yaw, "unwedge");
        }
      }
      // the 4-try cap resets after a minute of normal movement, so a later stuck still gets fixed
      if (!st.stuckSince && (st.unsticks || 0) > 0 && now - (st.lastUnstickAt || 0) > 60_000) st.unsticks = 0;
      if (st.stuckSince && now - st.stuckSince > Number(process.env.LOKI_STUCK_MS || 2500) && (st.unsticks || 0) < 4) {
        st.lastUnstickAt = now;
        const nf = st.lastGood && (st.unsticks || 0) === 0 ? { x: st.lastGood[0], y: st.lastGood[1], z: st.lastGood[2] } : nearestFloor(this.currentMap, m.loc[0] + (st.unsticks || 0) * 400, m.loc[1]);
        const sp = nf || spawnPointFor(this.currentMap, player.team, player.id);
        st.unsticks = (st.unsticks || 0) + 1; st.stuckSince = 0;
        correction = { loc: [sp.x, sp.y, sp.z], vel: [0, 0, 0], mode: MOVE_MODE.Falling };
        this.log(`[ue] unstick ${player.id} at (${m.loc.map(Math.round)}) mode=${m.mode} -> (${sp.x},${sp.y},${sp.z}) try=${st.unsticks}`);
        this.sendClientSetLocation(conn, player, [sp.x, sp.y, sp.z], m.yaw, "unstick");
      }
    }
    Object.assign(st, { ts: m.timeStamp, at: now, x: m.loc[0], y: m.loc[1], z: m.loc[2] });
    st.acks++;
    this.moveState.set(player.id, st);
    if (process.env.LOKI_MOVE_ACK !== "0") this.sendHeroRpc(conn, player, HERO_FIELD.ClientMoveResponsePacked, (p) => writeMoveResponse(p, m.timeStamp, correction));
    if (now - st.logAt > 5000) {
      st.logAt = now;
      this.log(`[ue] move ${player.id} t=${m.timeStamp.toFixed(2)} pos=(${Math.round(m.loc[0])},${Math.round(m.loc[1])},${Math.round(m.loc[2])}) mode=${m.mode} accel=(${m.accel.map(Math.round).join(",")}) yaw=${Math.round(m.yaw)} acks=${st.acks}`);
    }
  }

  /** One RPC on the owning hero's channel (unreliable, like CharacterMovement's own). */
  private sendHeroRpc(conn: UEConn, player: Player, idx: number, params: (w: BitWriter) => void) {
    const p = new BitWriter(512);
    params(p);
    const field = new BitWriter(1024);
    field.serializeIntVar(idx, HERO_FIELD_MAX);
    field.packed32(p.bits);
    field.bitsFrom(p.buffer(), p.bits);
    this.sendBunch(conn, (w) => {
      writeContentBlock(w, false, true, field.buffer(), field.bits);
    }, { ch: player.channel + 1, reliable: false, nameIndex: EChannelName.Actor });
  }

  private handleControl(conn: UEConn, type: number, r: BitReader) {
    if (type === NMT.Hello) {
      conn.hello = readHello(r);
      conn.state = "challenge";
      this.log(`[ue] NMT_Hello ${this.key(conn.addr)} netver=${conn.hello.version} features=${conn.hello.runtimeFeatures}`);
      this.sendControl(conn, (w) => {
        w.uint8(NMT.Challenge);
        writeChallenge(w, crypto.randomBytes(16).toString("hex"));
      }, false);
      return;
    }
    if (type === NMT.Netspeed) {
      const speed = r.uint32();
      this.log(`[ue] NMT_Netspeed ${this.key(conn.addr)} ${speed}`);
      return;
    }
    if (type === NMT.Login) {
      const response = r.fstring();
      const url = r.fstring();
      let uniqueId: { type: string; contents: string } | null = null;
      let platform = "NULL";
      try {
        uniqueId = readUniqueNetIdRepl(r);
        platform = r.fstring() || "NULL";
      } catch {}
      const matchId = /MatchId=([^&?\s]+)/i.exec(url)?.[1]
        || /MatchId=([^&?\s]+)/i.exec(response)?.[1]
        || this.currentMatchId || "unknown";
      const uid = uniqueId?.contents
        || /userId=([^&?\s]+)/i.exec(url)?.[1]
        || /PlayerId=([^&?\s]+)/i.exec(url)?.[1]
        || response
        || this.key(conn.addr);
      conn.login = { url, playerId: uid, platform, matchId };
      conn.state = "welcome";
      this.log(`[ue] NMT_Login ${this.key(conn.addr)} match=${matchId} player=${uid} platform=${platform}`);
      // One account = one pawn. A second login for the same player (relaunch, a second game
      // instance, or a stale socket after a NAT flip) replaces the old connection; before this
      // both stayed in the world and the old pawn lingered as a ghost the new client could see.
      if (process.env.LOKI_DUP_LOGIN !== "keep") {
        for (const other of [...this.conns.values()]) {
          if (other === conn || other.login?.playerId !== uid) continue;
          this.log(`[ue] duplicate login ${uid}: dropping older connection ${this.key(other.addr)}`);
          this.dropConnection(other, true);
        }
      }
      // The backend hands the client our address before our 15 s heartbeat learns the
      // allocation, so refresh it now: Welcome must name the match's map and GameState.
      const welcome = () => {
        if (conn.login) conn.login.matchId = this.currentMatchId || conn.login.matchId;
        this.log(`[ue] NMT_Welcome map=${this.currentMap} game=${this.currentGameMode} match=${this.currentMatchId || "unknown"}`);
        this.sendControl(conn, (w) => {
          w.uint8(NMT.Welcome);
          writeWelcome(w, this.currentMap, this.currentGameMode, "");
        });
      };
      if (this.options.register) {
        const timeout = new Promise((r) => setTimeout(r, 2500));
        // login URLs carry no match id; the heartbeat learns it from the allocation, so load the roster after it
        this.rosterWait = Promise.race([this.heartbeat().then(() => this.loadRoster(this.currentMatchId && this.currentMatchId !== "unknown" ? this.currentMatchId : matchId)), timeout]).then(() => {}, () => {});
        void this.rosterWait.finally(welcome);
      } else {
        this.rosterWait = Promise.race([this.loadRoster(matchId), new Promise((r) => setTimeout(r, 1500))]).then(() => {}, () => {});
        void this.rosterWait.finally(welcome);
      }
      return;
    }
    if (type === NMT.Join || type === 31) {
      if (conn.state !== "joined") {
        conn.state = "joined";
        void this.rosterWait.then(() => {
          // Coalesce the whole join (team states, GS, PS, PC, every hero) into full packets.
          const own = COALESCE && !conn.batch;
          if (own) this.beginBatch(conn);
          try { this.onJoin(conn); } finally { if (own) this.flushBatch(conn); }
        });
      }
      return;
    }
    if (type === NMT.CloseReason || type === NMT.Failure) {
      let reason = "";
      try { reason = r.fstring(); } catch {}
      this.log(`[ue] client closing ${this.key(conn.addr)} reason=${reason}`);
      this.dropConnection(conn);
    }
  }

  private dropConnection(conn: UEConn, replaced = false) {
    const key = this.key(conn.addr);
    const gone: Player[] = [];
    for (const [id, player] of this.players) {
      if (player.connKey === key) {
        this.players.delete(id);
        this.match.removePlayer(player.id);
        this.gas.delete(player.id);
        this.moveState.delete(player.id);
        gone.push(player);
      }
    }
    this.conns.delete(key);
    if (this.conns.size === 0) { if (!replaced) this.resetWorld(); return; }
    for (const p of gone) this.despawnPlayer(p);
  }

  /** Closes a departed player's actor channels (PlayerState, hero, stats, carrier) on every other
   *  connection, so the remaining clients drop the pawn instead of keeping a frozen ghost. */
  private despawnPlayer(p: Player) {
    if (process.env.LOKI_DESPAWN === "0") return;
    const ord = this.statsOrdinal(p);
    const chans = [p.channel - 1, p.channel + 1, STATS_CH_BASE + ord, CARRIER_CH_BASE + ord];
    for (const conn of this.conns.values()) {
      if (conn.state !== "joined") continue;
      for (const ch of chans) {
        if (!conn.channels.has(ch)) continue;
        conn.channels.delete(ch);
        this.sendBunch(conn, () => {}, { ch, close: true, reliable: true, nameIndex: EChannelName.Actor });
      }
    }
    this.log(`[ue] despawned ${p.id} (${p.name}) from ${this.conns.size} connection(s)`);
  }

  /** Last human left: throw the bot world away so the next allocation gets a fresh match on
   *  fresh ordinals/channels, and tell the backend we are allocatable again right away. */
  private resetWorld() {
    this.players.clear();
    this.nextActorOrdinal = 0;
    this.currentMatchId = this.options.matchId;
    this.lastGameStateSentS = -1;
    this.roster = new Map(); this.rosterMatch = "";
    this.moveState.clear();
    // Ability grants are per match: keeping them across the reset meant only the first match after a DS
    // restart granted abilities ("abilities worked on my first launch, never again").
    this.gas.clear(); this.hpDirty.clear();
    const mode = resolveMode(this.currentGameMode, this.currentMap);
    this.match = new MatchWorld({
      ...this.config.rules,
      maxPlayers: this.options.maxPlayers,
      matchId: this.currentMatchId || this.serverId,
    }, { onEvent: (event) => this.onMatchEvent(event), gameModeType: mode.gameModeType, spawnPoints: () => floorSpawnList(this.currentMap), floorAt: (x, y) => floorAt(this.currentMap, x, y) });
    this.applyModeProfile();
    this.setupZone();
    this.retail = undefined;
    this.planeState = null;
    this.trainEpoch = 0;
    this.loot?.reset(); // [loot] hook: fresh boxes for the next match
    this.interact?.reset(); // [interact] hook
    this.armory?.reset(); this.capture?.reset(); // [armory] / [capture] hooks
    this.log("[ue] world reset (no connections)");
    void this.heartbeat();
  }

  private onJoin(conn: UEConn) {
    if (!conn.login) return;
    const key = this.key(conn.addr);
    let player = this.players.get(key);
    if (!player) {
      const seat = this.roster.get(conn.login.playerId);
      const heroId = /[?&](?:HeroAssetID|HeroId|HunterId)=([^&?\s]+)/i.exec(conn.login.url)?.[1] || seat?.heroId;
      const combatant = this.match.addPlayer(conn.login.playerId, seat?.name || conn.login.playerId, { heroId, team: seat?.team });
      if (!this.currentMatchId || this.currentMatchId === "unknown") this.currentMatchId = conn.login.matchId;
      const ordinal = this.nextActorOrdinal++;
      player = {
        id: combatant.id, name: combatant.name, matchId: conn.login.matchId, heroId: combatant.heroId, skin: seat?.skin,
        actorGuid: 0x1000n + BigInt(ordinal) * 0x10n,
        psGuid: 0x2000n + BigInt(ordinal) * 0x10n,
        pcGuid: 0x3000n + BigInt(ordinal) * 0x10n,
        channel: 5 + ordinal * 3,
        x: combatant.x, y: combatant.y, z: combatant.z,
        vx: combatant.vx, vy: combatant.vy, vz: combatant.vz,
        yaw: combatant.yaw, pitch: combatant.pitch,
        health: combatant.hp, maxHealth: combatant.maxHp,
        shield: combatant.shield, maxShield: combatant.maxShield,
        alive: combatant.alive,
        kills: 0, deaths: 0, assists: 0, score: 0, team: combatant.team,
        isBot: false, spawned: false, lastMoveMs: Date.now(), connKey: key,
      };
      if (hasSpawnPoints(this.currentMap) && process.env.LOKI_REAL_SPAWNS !== "0") {
        const sp = spawnPointFor(this.currentMap, player.team, player.id);
        player.x = sp.x; player.y = sp.y; player.z = sp.z; player.vx = player.vy = player.vz = 0;
        this.match.setClientState(player.id, { x: sp.x, y: sp.y, z: sp.z, vx: 0, vy: 0, vz: 0, yaw: player.yaw, pitch: 0, grounded: false });
      }
      this.players.set(key, player);
      this.syncMatchState();
    }
    const isNew = !player.spawned;
    if (this.dropEnabled() && !conn.drop.opened && process.env.LOKI_DROP_HERO_GATE !== "0") conn.heroGate = "none";
    this.ensureRetailWorld();
    if (REP_TEAMS) this.spawnTeams(conn, player);
    // Spawn every known player into this connection (late joiners see existing players).
    for (const other of this.players.values()) {
      this.spawnPlayer(conn, other);
      other.spawned = true;
    }
    // Tell existing connections about this player once.
    if (isNew) {
      for (const [otherKey, otherConn] of this.conns) {
        if (otherKey === key) continue;
        if (otherConn.state !== "joined") continue;
        this.spawnPlayer(otherConn, player);
      }
    }
    player.spawned = true;
    player.abyssGraceUntil = Math.max(player.abyssGraceUntil || 0, Date.now() + Number(process.env.LOKI_ABYSS_JOIN_GRACE_MS || 20000));
    conn.players.add(key);
    setTimeout(() => { if (this.conns.has(key)) this.spawnTrains(conn); }, Number(process.env.LOKI_TRAIN_DELAY_MS || 2500));
    setTimeout(() => { if (this.conns.has(key)) this.spawnAirdoos(conn); }, Number(process.env.LOKI_AIRDOO_DELAY_MS || 3500));
    if (this.zoneKind === "ffa") setTimeout(() => { if (this.conns.has(key)) this.spawnZone(conn); }, Number(process.env.LOKI_ZONE_DELAY_MS || 3000)); // [zone] FFA: static circle from the start
    // [loot] hook: boxes + the owner's PC loot components, alongside the trains
    setTimeout(() => { if (this.conns.has(key)) this.spawnLoot(conn, player); }, Number(process.env.LOKI_LOOT_DELAY_MS || 3000));
    if (this.retail && !conn.retailQueued) {
      conn.retailQueued = true;
      setTimeout(() => { if (this.conns.has(key) && this.retail) conn.retailQueue = this.retail.bunches.slice(); },
        Number(process.env.LOKI_RETAIL_DELAY_MS || 600));
    }
    this.log(`[ue] joined ${player.id} match=${player.matchId} actors=${this.players.size} pos=(${Math.round(player.x)},${Math.round(player.y)},${Math.round(player.z)})`);
  }

  private exportsFor(player: Player, conn: UEConn): GuidExport[] {
    const list: GuidExport[] = [];
    const add = (guid: bigint, path: string, outer = 0n, noLoad = false) => {
      if (outer && !noLoad && path.startsWith("Default__")) ARCHETYPE_PACKAGE.set(guid, outer);
      if (conn.exportedGuids.has(guid)) return;
      conn.exportedGuids.add(guid);
      list.push({ guid, path, outer, noLoad });
    };
    add(GUID.EnginePackage, "/Script/Engine");
    add(GUID.GamePackage, "/Script/Loki");
    add(GUID.LevelPackage, this.currentMap, 0n, false);
    // Package -> UWorld (same short name as the package) -> PersistentLevel.
    add(GUID.World, this.currentMap.split("/").pop()!, GUID.LevelPackage, true);
    add(GUID.Level, "PersistentLevel", GUID.World, true);
    // Spawn archetypes must be class default objects (Default__X), never the UClass:
    // the client spawns Archetype->GetClass(), and a UClass archetype spawns nothing.
    const gs = this.gameStateClassName();
    add(GUID.GameStateBPPackage, gs.pkg, 0n, false);
    add(GUID.GameStateClass, `Default__${gs.cls}`, GUID.GameStateBPPackage, false);
    const psBp = this.playerStateBp();
    add(GUID.PlayerStateBPPackage, psBp.pkg, 0n, false);
    add(GUID.PlayerStateClass, `Default__${psBp.cls}`, GUID.PlayerStateBPPackage, false);
    add(GUID.PlayerControllerBPPackage, PLAYER_CONTROLLER_BP.pkg, 0n, false);
    add(GUID.PlayerControllerClass, `Default__${PLAYER_CONTROLLER_BP.cls}`, GUID.PlayerControllerBPPackage, false);
    const hero = heroBlueprint(player.heroId);
    add(heroPackageGuid(hero.index), hero.pkg, 0n, false);
    add(heroCdoGuid(hero.index), `Default__${hero.cls}`, heroPackageGuid(hero.index), false);
    if (REP_TEAMS) {
      add(GUID_TEAM_PKG, TEAM_BP.pkg, 0n, false);
      add(GUID_TEAM_CDO, `Default__${TEAM_BP.cls}`, GUID_TEAM_PKG, false);
      add(GUID_TEAMONLY_CDO, "Default__LokiTeamState_TeamOnly", GUID.GamePackage, false);
    }
    if (REP_STATS) add(GUID_STATS_CDO, "Default__LokiPlayerState_Stats", GUID.GamePackage, false);
    if (REP_CARRIER) add(GUID_CARRIER_CDO, "Default__LokiPlayerState_HeroAffiliated", GUID.GamePackage, false);
    // Dynamic (even) actor GUIDs are introduced by their spawn bunch, never by path:
    // a path export makes the client log "RegisterNetGUID_Client: Guid with pathname".
    return list;
  }

  private teamIndices(): number[] {
    return [...new Set([...this.players.values()].map((p) => p.team))].sort((a, b) => a - b);
  }

  /** Writes an array of object refs in the RepLayout array form the client already accepts for
   *  GameFeatureToggles: uint16 count, element handles i+1, 0 terminator. */
  private objArray(cls: string, name: string, guids: bigint[]): [NetField | null, (w: BitWriter) => void] {
    const field = this.handleFor(cls, name);
    return [field, (w) => {
      w.uint16(guids.length);
      guids.forEach((g, i) => { w.packed32(i + 1); writeNetGuid(w, g); });
      w.packed32(0);
    }];
  }

  /** One BP_LokiTeamState per team (Index, Players, TeamStateTeamOnly) plus the native
   *  LokiTeamState_TeamOnly for the connection's own team. Sent before the GameState so its
   *  TeamStates array resolves immediately. */
  private statsOrdinal(p: Player) { return Number((p.psGuid - 0x2000n) / 0x10n); }

  /** Opens (initial) or updates a player's ALokiPlayerState_Stats on this connection. Wire per the reference's
   *  retail-verified ALokiPlayerState_Stats: RemoteRole h5, Owner h13 (= the PlayerState), Role h14, then
   *  PlayerStatsReplicated h17 — FLokiPlayerSharedStats native NetSerialize, 20 fields x 32 bits, bool as UBOOL. */
  private sendStats(conn: UEConn, p: Player, initial: boolean) {
    const ord = this.statsOrdinal(p);
    const ch = STATS_CH_BASE + ord;
    if (initial && conn.channels.has(ch)) return;
    if (!initial && !conn.channels.has(ch)) return;
    const C = "LokiPlayerState_Stats";
    const stats: [NetField, (w: BitWriter) => void] = [
      { h: STATS_HANDLE, class: C, name: "PlayerStatsReplicated", type: "struct" },
      (w) => {
        const ints = [p.alive ? 1 : 0, p.kills | 0, 0, p.kills | 0, p.deaths | 0, p.assists | 0, 0, 0, p.kills | 0, 0, 0, 0, 0];
        for (const v of ints) w.uint32(v >>> 0);
        for (let i = 0; i < 4; i++) w.float(0);
        for (let i = 0; i < 3; i++) w.uint32(0);
      },
    ];
    const payload = new BitWriter(1024);
    this.propPayload(payload, initial ? [
      this.val(C, "RemoteRole", 1), this.val(C, "Owner", p.psGuid), this.val(C, "Role", 3), stats,
    ] : [stats]);
    if (initial) {
      conn.channels.add(ch);
      const exports = this.exportsFor(p, conn);
      this.sendBunch(conn, (w) => {
        writeNewActor(w, statsGuid(ord), GUID_STATS_CDO, [0, 0, 0], [0, 0, 0], GUID.Level);
        writeContentBlock(w, true, true, payload.buffer(), payload.bits);
      }, { ch, open: true, reliable: true, exports, mustBeMapped: [GUID_STATS_CDO, GUID.GamePackage], nameIndex: EChannelName.Actor });
    } else {
      this.sendBunch(conn, (w) => writeContentBlock(w, true, true, payload.buffer(), payload.bits), { ch, reliable: true, nameIndex: EChannelName.Actor });
    }
  }

  /** The carrier + its stable AttributeSet / AttributeSetHealth (stable header carries the client's extra 0 bit, as
   *  writeStableBlock already does). Sent once per player per connection, after that player's hero. */
  private spawnCarrier(conn: UEConn, p: Player) {
    const ord = this.statsOrdinal(p);
    const ch = CARRIER_CH_BASE + ord;
    if (conn.channels.has(ch)) return;
    conn.channels.add(ch);
    const g = carrierGuid(ord), attrGuid = g + 2n, healthGuid = g + 4n;
    const C = "LokiPlayerState_HeroAffiliated";
    const head = new BitWriter(256);
    this.propPayload(head, [this.val(C, "RemoteRole", 1), this.val(C, "Owner", p.psGuid), this.val(C, "Role", 3)]);
    const folder = heroBlueprint(p.heroId).id;
    const [move, accel] = HERO_MOVE[folder] ?? [455, 5400];
    const kit = { maxMana: 100, maxStamina: 200, ...(GAS_POLICY.heroes[folder] ?? {}) };
    const attr = (base: number, v: number): Array<[NetField, (w: BitWriter) => void]> =>
      [rawField(base, "b", (w) => w.float(v)), rawField(base + 1, "c", (w) => w.float(v))];
    const attrs = new BitWriter(1024);
    this.propPayload(attrs, [
      ...attr(1, 1),            // Level
      ...attr(13, move),        // MoveSpeed
      ...attr(15, 700),         // MaxMoveSpeed
      ...attr(17, accel),       // MaxAcceleration
      ...attr(19, 1),           // GroundFriction
      ...attr(21, 2220),        // BrakingDecelerationWalking
      ...attr(23, 1),           // AirControlMultiplier
      ...attr(25, -1),          // YawRotationRate (instant turn)
      ...attr(27, 100),         // Mass
      ...attr(39, kit.maxMana),     // Mana (the client's Cost gate reads it: 0 = every costed press silently refused)
      ...attr(41, kit.maxMana),     // MaxMana
      ...attr(49, kit.maxStamina),  // Stamina
      rawField(52, "c", (w) => w.float(kit.maxStamina)), // MaxStamina Current only (retail never sends its Base)
      ...attr(103, 1),          // BarracudaBasePrimaryAttackSpeed (CT seed 1.0)
    ]);
    const hp = new BitWriter(256);
    const maxHp = p.maxHealth || 1000, cur = p.alive ? (p.health || maxHp) : 0;
    this.propPayload(hp, [...attr(1, cur), ...attr(3, maxHp)]);
    const subExports: GuidExport[] = [
      { guid: attrGuid, path: "AttributeSet", outer: g, noLoad: true },
      { guid: healthGuid, path: "AttributeSetHealth", outer: g, noLoad: true },
    ];
    this.sendBunch(conn, (w) => {
      writeNewActor(w, g, GUID_CARRIER_CDO, [0, 0, 0], [0, 0, 0], GUID.Level);
      writeContentBlock(w, true, true, head.buffer(), head.bits);
      this.writeStableBlock(w, attrGuid, true, attrs);
      this.writeStableBlock(w, healthGuid, true, hp);
    }, { ch, open: true, reliable: true, exports: [...this.exportsFor(p, conn), ...subExports], mustBeMapped: [GUID_CARRIER_CDO, GUID.GamePackage], nameIndex: EChannelName.Actor });
  }

  private gas = new Map<string, { specs: Array<{ handle: number; cls: string; inputId: number; i: number }>; ackKey: number; ord: number }>();

  /** Grant the owner's hero kit into its carrier ASC. Owner connection only (field 8 is owner-only on retail). */
  private grantAbilities(conn: UEConn, p: Player) {
    if (!REP_GAS) return;
    const ord = this.statsOrdinal(p), ch = CARRIER_CH_BASE + ord;
    if (!conn.channels.has(ch) || this.gas.has(p.id)) return;
    const folder = heroBlueprint(p.heroId).id;
    const rows = Gas.heroGrants(folder).filter((r) => r.pkg && r.cls && r.inputId >= 0 && r.inputId !== 16);
    if (!rows.length) { this.log(`[gas] no kit for ${folder}`); return; }
    const specs = rows.map((r, i) => ({ handle: 1000 + ord * 100 + i, cls: r.cls, inputId: r.inputId, i, row: r }));
    const exports: GuidExport[] = [];
    specs.forEach(({ row, i }) => {
      const pkg = abilGuid(row.cls);
      if (conn.exportedGuids.has(pkg)) return;
      conn.exportedGuids.add(pkg);
      exports.push({ guid: pkg, path: row.pkg, outer: 0n },
        { guid: pkg + 2n, path: row.cls, outer: pkg },
        { guid: pkg + 4n, path: `Default__${row.cls}`, outer: pkg });
    });
    const asc = ascGuidOf(ord);
    const handleOf = (cls: string) => specs.find((s) => s.cls === cls)?.handle ?? 0;
    // One small bunch per ability (its 3 exports + its instance): a single grant bunch carried 42 exports and went past
    // the client's MTU ("Malformed_Packet: bytes > max MTU"), then jammed every reliable bunch behind it.
    const repOf = (cls: string) => GAS_INSTANCES === "all" || (GAS_INSTANCES === "policy" && !!GAS_POLICY.classes[cls]?.rep);
    // 1) ASC actor info first: the client's OnRep_OwningActor runs InitAbilityActorInfo(carrier, hero), which sets each
    //    selector's MyAbilitySystem (OnAvatarSet) — an instance arriving before it has no avatar.
    if (GAS_ACTOR_INFO) {
      const ai = new BitWriter(192);
      this.propPayload(ai, [rawField(7, "OwnerActor", (w) => writeNetGuid(w, carrierGuid(ord))), rawField(8, "AvatarActor", (w) => writeNetGuid(w, p.actorGuid))]);
      this.sendBunch(conn, (w) => this.writeStableBlock(w, asc, true, ai),
        { ch, reliable: true, nameIndex: EChannelName.Actor, exports: [{ guid: asc, path: "AbilitySystemComponent", outer: carrierGuid(ord), noLoad: true }] });
    }
    // 2) per ability: class/CDO exports, plus its instance where the client expects a replicated one (one small bunch each:
    //    a single 42-export grant bunch exceeded the client's MTU).
    for (const s of specs) {
      const g = abilGuid(s.cls), inst = abilInstGuid(ord, s.i);
      const ex = exports.filter((e) => e.guid === g || e.guid === g + 2n || e.guid === g + 4n);
      if (!repOf(s.cls)) {
        if (ex.length) this.sendBunch(conn, () => {}, { ch, reliable: true, nameIndex: EChannelName.Actor, exports: ex });
        continue;
      }
      const subs = (s.row.subSpells ?? []).map((x) => handleOf(x.cls)).filter(Boolean);
      const pol = GAS_POLICY.classes[s.cls];
      let props: BitWriter | null = null;
      if (s.row.selector && subs.length) props = Gas.encodeSelectorSubSpellHandles(subs);
      else if (s.row.swapper && subs.length) props = Gas.encodeSwapperInitial(subs);
      else if (pol?.maxCharges) props = Gas.encodeSpellCharges(pol.maxCharges);
      this.sendBunch(conn, (w) => {
        w.bit(!!props); w.bit(false); writeNetGuid(w, inst); w.bit(false); w.bit(false); writeNetGuid(w, g + 2n); w.bit(true);
        w.packed32(props ? props.bits : 0); if (props) w.bitsFrom(props.buffer(), props.bits);
      }, { ch, reliable: true, nameIndex: EChannelName.Actor, exports: ex, mustBeMapped: [g + 2n] });
    }
    const delta = Gas.grantSpecsDelta(specs.map((s) => ({ handle: s.handle, ability: abilGuid(s.cls) + 4n, level: s.row.level || 1, inputId: s.inputId, sourceObject: 0, instances: repOf(s.cls) ? [abilInstGuid(ord, s.i)] : [] })));
    this.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, asc, [Gas.ascField(Gas.ASC.ActivatableAbilities, Gas.encodeActivatableAbilities(delta))]),
      { ch, reliable: true, nameIndex: EChannelName.Actor, exports: [{ guid: asc, path: "AbilitySystemComponent", outer: carrierGuid(ord), noLoad: true }] });
    this.gas.set(p.id, { specs: specs.map(({ handle, cls, inputId, i }) => ({ handle, cls, inputId, i })), ackKey: 1, ord });
    this.log(`[gas] granted ${specs.length} abilities to ${p.id} (${folder}) asc=0x${asc.toString(16)} instances=${specs.filter((s) => repOf(s.cls)).length} (${GAS_INSTANCES}) actorInfo=${GAS_ACTOR_INFO}`);
  }

  /** castvis: play the cast's warmup montage on `caster`'s body for every other connection that has the caster's carrier and
   *  hero open and is within LOKI_CAST_RANGE: ASC RepAnimMontageInfo (handle 11, retail wire — castvis.ts), with OwnerActor /
   *  AvatarActor (h7/h8) the first time so the observer's ASC knows which body to animate. The caster's own client predicts its
   *  montage locally, so it is skipped. Each play flips ForcePlayBit (PlayInstanceId & 1), which is what makes observers replay. */
  private castLog = 0;
  private broadcastCastMontage(caster: Player, row: CastVis.MontageRow | null, why: string) {
    if (!CAST_MONTAGE || !REP_CARRIER || !row || !caster.spawned || !caster.alive) return;
    caster.castPlays = ((caster.castPlays ?? 0) + 1) & 0xff;
    const ord = this.statsOrdinal(caster), ch = CARRIER_CH_BASE + ord, asc = ascGuidOf(ord);
    const mg = CastVis.montageGuids(row.pkg);
    let sent = 0;
    for (const conn of this.conns.values()) {
      if (conn.state !== "joined") continue;
      const key = this.key(conn.addr);
      if (caster.connKey === key) continue;
      if (!conn.channels.has(ch) || !conn.channels.has(caster.channel + 1)) continue;
      const self = [...this.players.values()].find((p) => p.connKey === key);
      if (self && Math.hypot(self.x - caster.x, self.y - caster.y) > CAST_RANGE) continue;
      const exports: GuidExport[] = [];
      if (!conn.exportedGuids.has(asc)) { conn.exportedGuids.add(asc); exports.push({ guid: asc, path: "AbilitySystemComponent", outer: carrierGuid(ord), noLoad: true }); }
      const freshMontage = !conn.exportedGuids.has(mg.pkg);
      if (freshMontage) { conn.exportedGuids.add(mg.pkg); conn.exportedGuids.add(mg.obj); exports.push({ guid: mg.pkg, path: row.pkg, outer: 0n }, { guid: mg.obj, path: row.obj, outer: mg.pkg }); }
      const fields: Array<[NetField | null, (w: BitWriter) => void]> = [];
      const firstInfo = !conn.castAscReady.has(caster.id);
      if (firstInfo) {
        conn.castAscReady.add(caster.id);
        fields.push(rawField(7, "OwnerActor", (w) => writeNetGuid(w, carrierGuid(ord))), rawField(8, "AvatarActor", (w) => writeNetGuid(w, caster.actorGuid)));
      }
      fields.push(rawField(11, "RepAnimMontageInfo", (w) => CastVis.writeRepAnimMontage(w, {
        position: 0, forcePlayBit: !!(caster.castPlays! & 1), montage: mg.obj, combat: row.combat, rate: row.rate, blend: row.blend,
      })));
      const pl = new BitWriter(512);
      this.propPayload(pl, fields);
      if (CAST_DUMP) appendFileSync(CAST_DUMP, JSON.stringify({ to: key, caster: caster.id, ch, asc: asc.toString(), montage: mg.obj.toString(), pkg: row.pkg, exports: exports.map((e) => e.guid.toString()), bits: pl.bits, hex: Buffer.from(pl.buffer()).toString("hex") }) + "\n");
      this.sendBunch(conn, (w) => this.writeStableBlock(w, asc, true, pl), {
        ch, reliable: exports.length > 0 || firstInfo, nameIndex: EChannelName.Actor, exports,
        mustBeMapped: freshMontage ? [mg.obj] : undefined,
      });
      sent++;
    }
    if (sent && this.castLog++ < 400) this.log(`[cast] ${caster.id} ${why} -> ${row.obj} play=${caster.castPlays} conns=${sent}`);
  }

  private sendAsc(conn: UEConn, p: Player, fields: BitWriter[]) {
    const st = this.gas.get(p.id); if (!st) return;
    const ch = CARRIER_CH_BASE + st.ord;
    if (!conn.channels.has(ch)) return;
    this.sendBunch(conn, (w) => Gas.writeAscRpcBlock(w, ascGuidOf(st.ord), fields), { ch, reliable: true, nameIndex: EChannelName.Actor });
  }

  /** Client ASC RPCs on the owner's carrier channel (stable subobject block, header bound 60). */
  private onCarrierBunch(conn: UEConn, p: Player, bunch: Bunch) {
    const st = this.gas.get(p.id); if (!st) return;
    // C->S subobject header is [rep][isActor][guid] only (no stably-named bit; same as the drop-pod RPCs).
    const fields = readSubobjectRpc(bunch.data, bunch.bits, Gas.ASC_BOUND, 0)
      ?? readSubobjectRpc(bunch.data, bunch.bits, Gas.ASC_BOUND, 2) ?? [];
    if (!fields.length) this.log(`[gas] carrier bunch unparsed bits=${bunch.bits} hex=${Buffer.from(bunch.data).toString("hex").slice(0, 160)}`);
    for (const f of fields) {
      try {
        if (f.idx === Gas.ASC.ServerTryActivateAbility) {
          const t = Gas.decodeServerTryActivateAbility(f.data, f.bits);
          // [loot] hook: the search spell stays active until the Stop (no auto-End timer, no sim ability)
          if (this.loot?.onActivate(conn, p, t.handle, t.key)) continue;
          if (this.interact?.onActivate(conn, p, t.handle, t.key)) continue;
          const spec = st.specs.find((s) => s.handle === t.handle);
          this.sendAsc(conn, p, [Gas.ascField(Gas.ASC.ClientActivateAbilitySucceed, Gas.encodeClientActivateAbilitySucceed(t.handle, t.key))]);
          if (spec) this.broadcastCastMontage(p, CastVis.montageForSpell(heroBlueprint(p.heroId).id, spec.cls), spec.cls);
          const sim = spec ? ABILITY_SIM[spec.inputId] : undefined;
          if (sim) { const res = this.match.requestAbility(p.id, sim); if (!res.ok && res.reason !== "cooldown") this.log(`[gas] sim ${sim} refused: ${res.reason}`); }
          const endMs = Number(process.env.LOKI_GAS_END_MS || (spec?.inputId === 3 ? 450 : 700));
          setTimeout(() => {
            this.sendAsc(conn, p, [Gas.ascField(Gas.ASC.ClientEndAbility, Gas.encodeClientEndAbility(t.handle, { mode: Gas.ActivationMode.Confirmed, key: t.key }))]);
            setTimeout(() => { st.ackKey++; this.sendAsc(conn, p, [Gas.ascField(Gas.ASC.ReplicatedPredictionKeyMap, Gas.ackPredictionKey(t.key, st.ackKey))]); }, 10);
          }, endMs);
          this.log(`[gas] activate ${p.id} handle=${t.handle} ${spec?.cls ?? "?"} key=${t.key.current}`);
        } else if (f.idx === Gas.ASC.ServerSetBufferedSpell) {
          const d = Gas.decodeServerSetBufferedSpell(f.data, f.bits).data;
          if (d) this.sendAsc(conn, p, [Gas.ascField(Gas.ASC.ClientClearBufferedSpell, Gas.encodeClientClearBufferedSpell(d.handle))]);
        } else if (!this.heroRpcSeen.has(1000 + f.idx)) {
          this.heroRpcSeen.add(1000 + f.idx);
          this.log(`[gas] asc rpc idx=${f.idx} bits=${f.bits} from ${p.id}`);
        }
      } catch (err) { this.log(`[gas] asc rpc ${f.idx} decode failed: ${err instanceof Error ? err.message : err}`); }
    }
  }

  private trainEpoch = 0;

  /** Spawn the six Breach train cars on this connection (once). Cars carry RemoteRole/Role (+ FrontCar h20 train index)
   *  and their movable-base component's track distance (h2 bIsActive, h3 double), bit-for-bit retail's open blocks. */
  private spawnTrains(conn: UEConn) {
    if (!REP_TRAIN || !/LVL_SkylandsBreach$/.test(this.currentMap) || conn.trainsSent || this.modeProfile?.trains === false) return;
    conn.trainsSent = true;
    if (!this.trainEpoch) this.trainEpoch = Date.now();
    const elapsed = (Date.now() - this.trainEpoch) / 1000;
    const rawF = (h: number, write: (w: BitWriter) => void) => rawField(h, `h${h}`, write);
    TRAIN_CARS.forEach(([ci, train, loc, d0], i) => {
      const cls = TRAIN_CLASSES[ci]!, guid = trainCarGuid(i), comp = guid + 2n, ch = TRAIN_CH_BASE + i;
      if (conn.channels.has(ch)) return;
      conn.channels.add(ch);
      const exports: GuidExport[] = [];
      if (!conn.exportedGuids.has(cls.guid)) {
        conn.exportedGuids.add(cls.guid);
        exports.push({ guid: cls.guid, path: cls.pkg, outer: 0n }, { guid: cls.guid + 2n, path: cls.cdo, outer: cls.guid });
      }
      exports.push({ guid: comp, path: "BP_TrainMovableBaseComponentV2", outer: guid, noLoad: true });
      const actor = new BitWriter(128);
      this.propPayload(actor, [
        rawF(5, (w) => Gas.writeBitsN(w, 1, 3)),   // RemoteRole SimulatedProxy
        rawF(14, (w) => Gas.writeBitsN(w, 3, 3)),  // Role Authority
        ...(ci === 0 ? [rawF(20, (w) => w.int32(train))] : []),
      ]);
      const dist = ((d0 + elapsed * TRAIN_SPEED) % TRAIN_LOOP + TRAIN_LOOP) % TRAIN_LOOP;
      const cp = new BitWriter(128);
      this.propPayload(cp, [rawF(2, (w) => w.bit(true)), rawF(3, (w) => w.double(dist))]);
      this.sendBunch(conn, (w) => {
        writeNewActor(w, guid, cls.guid + 2n, loc, [0, 0, 0], GUID.Level);
        writeContentBlock(w, true, true, actor.buffer(), actor.bits);
        this.writeStableBlock(w, comp, true, cp);
      }, { ch, open: true, reliable: true, nameIndex: EChannelName.Actor, exports, mustBeMapped: [cls.guid + 2n] });
    });
    setTimeout(() => this.sendTrainStates(conn), 1500);
    this.log(`[train] spawned 6 cars -> ${this.key(conn.addr)} t+${elapsed.toFixed(1)}s`);
  }

  /** Points this match parks Airdoos on: LOKI_AIRDOO_COUNT (retail 5) of AIRDOO_POINTS, seeded by the match id so
   *  every connection in one match sees the same vehicles. */
  private airdooPoints(): Array<[number, number, number]> {
    if (this.airdooPick && this.airdooPickFor === this.currentMatchId) return this.airdooPick;
    const n = Math.max(0, Math.min(AIRDOO_POINTS.length, Number(process.env.LOKI_AIRDOO_COUNT || AIRDOO_POINTS.length)));
    let seed = 2166136261;
    for (const ch of String(this.currentMatchId || this.serverId)) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    const idx = AIRDOO_POINTS.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0;
      const j = seed % (i + 1);
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    this.airdooPick = idx.slice(0, n).sort((a, b) => a - b).map((i) => AIRDOO_POINTS[i]!);
    this.airdooPickFor = this.currentMatchId;
    return this.airdooPick;
  }
  private airdooPick: Array<[number, number, number]> | null = null;
  private airdooPickFor = "";

  /** Parked BP_Airdoo actors (same dynamic-spawn shape as the trains: AActor h5 RemoteRole SimulatedProxy + h14 Role
   *  Authority; location/rotation ride in the spawn header). The actor's own BP_LokiRelevantIcon_Component puts it on
   *  the minimap once the client has it, so every Airdoo is sent to every connection. */
  private spawnAirdoos(conn: UEConn) {
    if (!REP_AIRDOO || !/LVL_SkylandsBreach$/.test(this.currentMap) || conn.airdoosSent || this.modeProfile?.trains === false) return; // same Breach-only modes as the trains
    conn.airdoosSent = true;
    const pts = this.airdooPoints();
    pts.forEach((loc, i) => {
      const guid = airdooGuid(i), ch = AIRDOO_CH_BASE + i;
      if (conn.channels.has(ch)) return;
      conn.channels.add(ch);
      const sub = (k: keyof typeof AIRDOO_SUBS) => guid + BigInt(AIRDOO_SUBS[k][0]);
      const exports: GuidExport[] = [];
      if (!conn.exportedGuids.has(AIRDOO_CLASS.guid)) {
        conn.exportedGuids.add(AIRDOO_CLASS.guid);
        exports.push({ guid: AIRDOO_CLASS.guid, path: AIRDOO_CLASS.pkg, outer: 0n }, { guid: AIRDOO_CLASS.guid + 2n, path: AIRDOO_CLASS.cdo, outer: AIRDOO_CLASS.guid });
      }
      if (!conn.exportedGuids.has(AIRDOO_MAT.guid)) {
        conn.exportedGuids.add(AIRDOO_MAT.guid);
        exports.push({ guid: AIRDOO_MAT.guid, path: AIRDOO_MAT.pkg, outer: 0n, checksum: 0 }, { guid: AIRDOO_MAT.guid + 2n, path: AIRDOO_MAT.obj, outer: AIRDOO_MAT.guid, checksum: 0 });
      }
      for (const k of Object.keys(AIRDOO_SUBS) as (keyof typeof AIRDOO_SUBS)[]) {
        exports.push({ guid: sub(k), path: k, outer: guid, noLoad: true, checksum: AIRDOO_SUBS[k][1] });
      }
      // Face the island centre (retail parks at assorted yaws); yaw travels as a byte in the movement block.
      const yaw = Math.atan2(-loc[1], -loc[0]) * 180 / Math.PI;
      const at: [number, number, number] = [Math.round(loc[0]), Math.round(loc[1]), Math.round(loc[2] - 256)];
      // Actor block, bit-identical to retail's for the same inputs: RemoteRole, ReplicatedMovement (physics flags 3, zero
      // angular velocity), Role, h24 hull material.
      const actor = new BitWriter(256);
      actor.bit(false);
      actor.packed32(5); Gas.writeBitsN(actor, 1, 3);
      actor.packed32(12); Loot.writeBoxMovement(actor, { flags: 3, loc: at, rot: [0, Loot.yawByte(yaw), 0], vel: [0, 0, 0] }); writeQuantizedVector(actor, 0, 0, 0, 1);
      actor.packed32(14); Gas.writeBitsN(actor, 3, 3);
      actor.packed32(24); actor.packed64(AIRDOO_MAT.guid + 2n);
      actor.packed32(0);
      const raw = (buf: Buffer, bits: number) => { const x = new BitWriter(bits + 8); x.bitsFrom(buf, bits); return x; };
      const asc = new BitWriter(256);
      asc.bit(false);
      asc.packed32(4); asc.uint16(2); asc.packed32(1); asc.packed64(sub("HealthSet")); asc.packed32(2); asc.packed64(sub("AirshipSet")); asc.packed32(0);
      asc.packed32(7); asc.packed64(guid); asc.packed32(8); asc.packed64(guid);
      asc.packed32(0);
      const seat = () => { const x = new BitWriter(64); x.bit(false); x.packed32(3); x.packed64(sub("Seats")); x.packed32(13); x.bit(true); x.packed32(0); return x; };
      this.sendBunch(conn, (w) => {
        writeNewActor(w, guid, AIRDOO_CLASS.guid + 2n, at, [0, yaw, 0], GUID.Level);
        writeContentBlock(w, true, true, actor.buffer(), actor.bits);
        this.writeStableBlock(w, sub("HealthSet"), true, raw(AIRDOO_HEALTHSET, 169));
        this.writeStableBlock(w, sub("AirshipSet"), true, raw(AIRDOO_AIRSHIPSET, 169));
        this.writeStableBlock(w, sub("AbilitySystemComponent"), true, asc);
        this.writeStableBlock(w, sub("BP_AirshipSeat_Pilot"), true, seat());
        this.writeStableBlock(w, sub("BP_AirshipSeat_Passenger"), true, seat());
      }, { ch, open: true, reliable: true, nameIndex: EChannelName.Actor, exports, mustBeMapped: [AIRDOO_CLASS.guid + 2n, AIRDOO_MAT.guid + 2n] });
    });
    this.log(`[airdoo] parked ${pts.length} (${pts.length / 2} pairs) -> ${this.key(conn.addr)}`);
    if (process.env.LOKI_AIRDOO_ICONS !== "0") this.sendAirdooIcons(conn, pts);
  }

  /** LokiMapIconManager_1 with one minimap icon per Airdoo (retail IconData items, see AIRDOO_ICON_TAIL). The open carries the
   *  first batch; the rest follow as fast-array deltas (base = previous key) so no bunch outgrows a packet (~1.1 kbit per icon). */
  private sendAirdooIcons(conn: UEConn, pts: Array<[number, number, number]>) {
    const ch = MAPICON_MGR.ch;
    if (conn.channels.has(ch)) return;
    conn.channels.add(ch);
    const exports: GuidExport[] = [];
    if (!conn.exportedGuids.has(MAPICON_MGR.guid)) {
      conn.exportedGuids.add(MAPICON_MGR.guid);
      exports.push({ guid: MAPICON_MGR.guid, path: MAPICON_MGR.path, outer: GUID.Level, noLoad: true, checksum: MAPICON_MGR.checksum });
    }
    const BATCH = 5;
    let key = 0;
    for (let s0 = 0; s0 < pts.length; s0 += BATCH) {
      const batch = pts.slice(s0, s0 + BATCH);
      const base = key; key += batch.length;
      const fa = new BitWriter(1024 + batch.length * 1200);
      Gas.writeFastArray(fa, {
        arrayKey: key, baseKey: base,
        changed: batch.map((loc, j) => ({
          id: s0 + j + 1,
          write: (w: BitWriter) => {
            w.packed32(1);
            w.fstring(`BP_Airdoo_C_${2147438600 - (s0 + j) * 4}.BP_LokiRelevantIcon_Component`);
            w.double(loc[0]); w.double(loc[1]); w.double(loc[2]);
            w.bitsFrom(AIRDOO_ICON_TAIL, AIRDOO_ICON_TAIL_BITS);
          },
        })),
      });
      const fld = Gas.field(MAPICON_FIELD, MAPICON_BOUND, fa);
      if (s0 === 0) {
        const actor = new BitWriter(256 + fld.bits);
        this.propPayload(actor, [
          rawField(5, "h5", (w) => Gas.writeBitsN(w, 1, 3)),   // RemoteRole SimulatedProxy
          rawField(14, "h14", (w) => Gas.writeBitsN(w, 3, 3)), // Role Authority
        ]);
        actor.bitsFrom(fld.buffer(), fld.bits);
        this.sendBunch(conn, (w) => {
          w.packed64(MAPICON_MGR.guid); // static actor: SerializeNewActor = the GUID only
          writeContentBlock(w, true, true, actor.buffer(), actor.bits);
        }, { ch, open: true, reliable: true, nameIndex: EChannelName.Actor, exports });
      } else {
        // Retail update form: actor block without a RepLayout part, only the custom-delta field.
        this.sendBunch(conn, (w) => writeContentBlock(w, false, true, fld.buffer(), fld.bits), { ch, reliable: true, nameIndex: EChannelName.Actor });
      }
    }
    this.log(`[airdoo] ${pts.length} minimap icons -> ${this.key(conn.addr)} (LokiMapIconManager_1 ch ${ch}, key ${key})`);
  }

  /** Comp_GameState_Train h3 TrainStates (retail 235-bit block): [Train, RewardClass, StarCount 1, bIsUnlocked 0] × 2. */
  private sendTrainStates(conn: UEConn) {
    if (!this.conns.has(this.key(conn.addr))) return;
    const exports: GuidExport[] = [];
    TRAIN_REWARDS.forEach((pkg, i) => {
      const g = trainRewardGuid(i);
      if (conn.exportedGuids.has(g)) return;
      conn.exportedGuids.add(g);
      exports.push({ guid: g, path: pkg, outer: 0n }, { guid: g + 2n, path: `${pkg.split("/").pop()}_C`, outer: g });
    });
    exports.push({ guid: GUID_TRAINCOMP, path: "Comp_GameState_Train", outer: GUID.GameStateActor, noLoad: true });
    const p = new BitWriter(512);
    p.bit(false); p.packed32(3); p.uint16(2);
    [1, 4].forEach((car, i) => {
      const b = i * 4;
      p.packed32(b + 1); writeNetGuid(p, trainCarGuid(car));
      p.packed32(b + 2); writeNetGuid(p, trainRewardGuid(i) + 2n);
      p.packed32(b + 3); p.int32(1);
      p.packed32(b + 4); p.bit(false);
    });
    p.packed32(0); p.packed32(0);
    this.sendBunch(conn, (w) => this.writeStableBlock(w, GUID_TRAINCOMP, true, p),
      { ch: GAMESTATE_CH, reliable: true, nameIndex: EChannelName.Actor, exports, mustBeMapped: [trainRewardGuid(0) + 2n, trainRewardGuid(1) + 2n] });
    this.log(`[train] TrainStates -> ${this.key(conn.addr)}`);
  }

  // ---------------------------------------------------------------- [zone] the storm (zone.ts, gate tools/check-zone.ts)
  private zone: Zone.Zone | null = null;
  /** ms when the storm clock started (= first Combat on Breach, match open on FFA); 0 = not started, nobody burns */
  private zoneEpoch = 0;
  private zoneKind: "breach" | "ffa" | null = null;
  private zoneFor: MatchWorld | null = null;

  /** Picks this match's storm: Breach drop modes run BP_DeathCircle_Skylands_Bots on retail's schedule; FFA the retail
   *  static 8000 circle (replayed by the FFA retail world when that is on, ours otherwise) with spawns inside it. */
  private setupZone() {
    const kind = !REP_ZONE || !/LVL_SkylandsBreach$/.test(this.currentMap) ? null
      : this.modeProfile?.key === "ffa" ? "ffa"
      : this.dropEnabled() && this.match.rules.zone.enabled ? "breach" : null;
    if (this.zoneFor === this.match && this.zoneKind === kind) return;
    this.zoneFor = this.match; this.zoneKind = kind; this.zone = null; this.zoneEpoch = 0;
    this.match.zoneOverride = null;
    setModeSpawns(kind === "ffa" ? this.currentMap : null, kind === "ffa" ? FFA_SPAWNS : null, "ffa");
    if (!kind) return;
    if (kind === "ffa") {
      this.zone = new Zone.Zone(Zone.FFA_PHASES, Zone.FFA_CENTER, { staticCenter: true });
      this.zoneEpoch = Date.now();
    } else {
      let seed = 2166136261;
      for (const ch of String(this.currentMatchId || this.serverId)) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
      const cands = floorSpawnList(this.currentMap).map((p) => [p[0]!, p[1]!] as [number, number]);
      this.zone = new Zone.Zone(Zone.BREACH_PHASES, ZONE_CENTER0, { seed: seed >>> 0, candidates: cands });
    }
    this.match.zoneOverride = () => {
      if (!this.zone || !this.zoneEpoch) return { radius: 1e9, centerX: 0, centerY: 0, dps: 0 };
      const st = this.zone.at((Date.now() - this.zoneEpoch) / 1000 * ZONE_SPEED);
      return { radius: st.radius, centerX: st.center[0], centerY: st.center[1], dps: st.dps };
    };
    this.log(`[zone] ${kind} storm: ${this.zone.phases.length} phases, final (${this.zone.final.map(Math.round)})${kind === "ffa" ? `, ${FFA_SPAWNS.length} spawns inside` : ""}`);
  }

  private zoneState() { return this.zone && this.zoneEpoch ? this.zone.at((Date.now() - this.zoneEpoch) / 1000 * ZONE_SPEED) : null; }

  /** GameState entries for the storm: DeathCircle ref, DeathCirclePhase, day/night on a day/night edge. */
  private zoneGsEntries(st: Zone.ZoneState, withRef: boolean, guid: bigint): Array<[NetField | null, (w: BitWriter) => void]> {
    const G = SV_CLASS.gameState, z = this.zone!;
    const out: Array<[NetField | null, (w: BitWriter) => void]> = [this.val(G, "DeathCirclePhase", st.phase)];
    if (withRef) out.push(this.val(G, "DeathCircle", guid));
    if (this.zoneKind === "breach" && process.env.LOKI_ZONE_DAYNIGHT !== "0" && (withRef || z.dayNightEdge(st.phase))) {
      const startWt = this.worldTime() - (st.elapsed - z.starts[st.phase]!);
      out.push(this.val(G, "DayNightState", st.dayNight), this.val(G, "LastDayNightChangeTime", startWt), this.val(G, "TotalDayNightTime", z.dayNightSpan(st.phase)));
    }
    return out;
  }

  /** Breach: called at Combat (drop.ts timeline) — starts the storm clock and opens the storm actor on this connection. */
  private startZone(conn: UEConn) {
    if (this.zoneKind === "breach" && !this.zoneEpoch) { this.zoneEpoch = Date.now(); this.log(`[zone] storm clock started`); }
    this.spawnZone(conn);
  }

  private spawnZone(conn: UEConn) {
    const st = this.zoneState();
    if (!st || conn.zone || !this.zone) return;
    const ffaReplay = this.zoneKind === "ffa" && this.retail?.name === "ffa";
    conn.zone = { phase: st.phase, revealKey: st.revealed && st.next ? zoneKey(st.next) : "", shrinking: st.shrinking, lastShrinkMs: 0, gsSent: false };
    if (ffaReplay) {
      // the retail FFA world replays BP_DeathCircle_FFA_C itself (retail actor guid 116); only point the GameState at it
      this.sendGsProps(conn, this.zoneGsEntries(st, true, FFA_RETAIL_ZONE_GUID));
      conn.zone.gsSent = true;
      this.log(`[zone] ffa storm (retail replay) -> ${this.key(conn.addr)}`);
      return;
    }
    const cls = this.zoneKind === "ffa" ? Zone.ZONE_CLASSES.ffa : Zone.ZONE_CLASSES.breach;
    const exports: GuidExport[] = [];
    if (!conn.exportedGuids.has(GUID_ZONE_PKG)) {
      conn.exportedGuids.add(GUID_ZONE_PKG);
      exports.push({ guid: GUID_ZONE_PKG, path: cls.pkg, outer: 0n }, { guid: GUID_ZONE_CDO, path: cls.cdo, outer: GUID_ZONE_PKG });
    }
    const open = Zone.openPayload(this.zone, st, cls.cdoRadius, { cdoNextRadius: cls.cdoNextRadius });
    conn.channels.add(ZONE_CH);
    this.sendBunch(conn, (w) => {
      writeNewActor(w, GUID_ZONE, GUID_ZONE_CDO, [st.center[0], st.center[1], 0], [0, 0, 0], GUID.Level);
      writeContentBlock(w, true, true, open.buffer(), open.bits);
    }, { ch: ZONE_CH, open: true, reliable: true, nameIndex: EChannelName.Actor, exports, mustBeMapped: [GUID_ZONE_CDO] });
    // the GameState ref goes out once the actor open has been sent (retail: same frame)
    this.sendGsProps(conn, this.zoneGsEntries(st, true, GUID_ZONE));
    this.sendGamePhase(conn, this.worldTime() - (st.elapsed - this.zone.starts[st.phase]!));
    conn.zone.gsSent = true;
    this.log(`[zone] ${this.zoneKind} storm open -> ${this.key(conn.addr)} phase=${st.phase} r=${Math.round(st.radius)} c=(${st.center.map(Math.round)}) ${open.bits}b`);
  }

  /** Retail phase-start time: Comp_GameState_GamePhase h5 + GameState h92 (Breach GameState only — the BP handles of other
   *  GameState classes are unknown; LOKI_ZONE_GAMEPHASE=1 forces, =0 disables). */
  private sendGamePhase(conn: UEConn, wt: number) {
    const flag = process.env.LOKI_ZONE_GAMEPHASE;
    if (flag === "0" || (flag !== "1" && this.gameStateClassName().cls !== "BP_LokiBattleRoyaleGameState_Breach_C")) return;
    if (!conn.channels.has(GAMESTATE_CH)) return;
    const comp = Zone.gamePhasePayload(wt);
    const exports: GuidExport[] = conn.exportedGuids.has(GUID_GAMEPHASE_COMP) ? []
      : [{ guid: GUID_GAMEPHASE_COMP, path: "Comp_GameState_GamePhase", outer: GUID.GameStateActor, noLoad: true }];
    conn.exportedGuids.add(GUID_GAMEPHASE_COMP);
    this.sendBunch(conn, (w) => this.writeStableBlock(w, GUID_GAMEPHASE_COMP, true, comp), { ch: GAMESTATE_CH, reliable: true, nameIndex: EChannelName.Actor, exports });
    if (process.env.LOKI_ZONE_GS92 !== "0") this.sendGsProps(conn, [rawField(92, "PhaseStartTime", (w) => w.double(wt))]);
  }

  private sendAnnouncement(conn: UEConn, a: { hex: string; bits: number }, reliable: boolean) {
    if (process.env.LOKI_ZONE_ANNOUNCE === "0" || this.zoneKind !== "breach" || !conn.channels.has(GAMESTATE_CH)) return;
    const p = new BitWriter(64);
    p.bitsFrom(Uint8Array.from(Buffer.from(a.hex, "hex")), a.bits);
    const exports: GuidExport[] = conn.exportedGuids.has(GUID_ANNOUNCE_COMP) ? []
      : [{ guid: GUID_ANNOUNCE_COMP, path: "Comp_GameState_Announcements", outer: GUID.GameStateActor, noLoad: true }];
    conn.exportedGuids.add(GUID_ANNOUNCE_COMP);
    this.sendBunch(conn, (w) => this.writeStableBlock(w, GUID_ANNOUNCE_COMP, false, p), { ch: GAMESTATE_CH, reliable, nameIndex: EChannelName.Actor, exports });
  }

  private sendZoneProps(conn: UEConn, p: BitWriter, reliable: boolean) {
    if (!conn.channels.has(ZONE_CH)) return;
    this.sendBunch(conn, (w) => writeContentBlock(w, true, true, p.buffer(), p.bits), { ch: ZONE_CH, reliable, nameIndex: EChannelName.Actor });
  }

  /** Per tick: phase edges to the GameState, shrink frames (Radius + Center), settle + reveal of the next circle. */
  private replicateZone(conn: UEConn) {
    const zs = conn.zone;
    if (!zs || !this.zone) return;
    const st = this.zoneState();
    if (!st) return;
    if (st.phase !== zs.phase) {
      zs.phase = st.phase;
      this.sendGsProps(conn, this.zoneGsEntries(st, false, 0n));
      this.sendGamePhase(conn, this.worldTime());
      const ph = this.zone.phases[st.phase]!;
      if (ph.shrink > 0 && ph.wait === 0 && st.phase + 1 < this.zone.phases.length) this.sendAnnouncement(conn, ANNOUNCE_SHRINK, true);
      this.log(`[zone] phase ${st.phase} -> ${this.key(conn.addr)} r=${Math.round(st.radius)} level=${st.level}`);
    }
    if (!zs.warned && this.zoneKind === "breach") {
      const first = this.zone.phases.findIndex((p) => p.shrink > 0);
      if (first >= 0 && st.elapsed >= this.zone.starts[first]! + this.zone.phases[first]!.wait - 13) { zs.warned = true; this.sendAnnouncement(conn, ANNOUNCE_WARN, false); }
    }
    if (!conn.channels.has(ZONE_CH)) return; // FFA retail replay: the circle never moves
    const now = Date.now();
    const key = st.revealed && st.next ? zoneKey(st.next) : "";
    if (st.shrinking) {
      zs.shrinking = true;
      if (now - zs.lastShrinkMs >= ZONE_RATE_MS) { zs.lastShrinkMs = now; this.sendZoneProps(conn, Zone.shrinkPayload(st), process.env.LOKI_ZONE_SHRINK_RELIABLE === "1"); }
    } else if (zs.shrinking) {
      // shrink end (retail 244.05: final Center + the next circle in one reliable block)
      zs.shrinking = false;
      if (key) { this.sendZoneProps(conn, Zone.revealPayload(st.next!, { center: st.center, radius: st.radius }), true); zs.revealKey = key; }
      else this.sendZoneProps(conn, Zone.settlePayload(st), true);
      return;
    }
    if (key && key !== zs.revealKey) {
      zs.revealKey = key;
      this.sendZoneProps(conn, Zone.revealPayload(st.next!), true);
      this.log(`[zone] next circle r=${st.next!.radius} c=(${st.next!.center.map(Math.round)}) -> ${this.key(conn.addr)}`);
    }
  }

  // ---------------------------------------------------------------- [loot] world loot hooks (all logic lives in loot.ts)
  private loot: Loot.LootManager<UEConn> | null = Loot.LOOT_ENABLED ? new Loot.LootManager<UEConn>({
    log: (m) => this.log(m),
    sendBunch: (conn, body, opts) => { this.sendBunch(conn, body, { ...opts, nameIndex: EChannelName.Actor }); },
    writeNewActor: (w, guid, arch, loc, rot) => writeNewActor(w, guid, arch, loc, rot, GUID.Level),
    writeActorBlock: (w, p) => writeContentBlock(w, true, true, p.buffer(), p.bits),
    // retail's SimpleInventory block has no RepLayout bit (the fast array is a custom delta property: field loop only)
    writeStableBlock: (w, guid, payload) => this.writeStableBlock(w, guid, false, payload),
    conns: () => [...this.conns.values()].filter((c) => c.state === "joined"),
    ord: (p) => this.statsOrdinal(p as Player),
    carrier: (conn, p) => {
      const st = this.gas.get(p.id);
      if (!st || !conn.channels.has(CARRIER_CH_BASE + st.ord)) return null;
      // grantAbilities() sent the kit as field-8 items 1..n with ArrayReplicationKey 1
      return { ch: CARRIER_CH_BASE + st.ord, asc: ascGuidOf(st.ord), kitItems: st.specs.length, kitKey: 1 };
    },
    credit: (p, item, d) => {
      if (item.kind === "gold") this.log(`[loot] ${p.id} gold +${d.opt ?? 0} = ${this.match.grantLootGold(p.id, d.opt ?? 0)}`);
      else if (item.kind === "armor") this.log(`[loot] ${p.id} armor T${item.armorTier} -> shield ${this.match.grantLootArmor(p.id, Loot.ARMOR_SHIELD[item.armorTier ?? 0] ?? 75) ?? "refused"}`);
      else this.log(`[loot] ${p.id} took ${item.key} x${d.stacks ?? 1} (no inventory item actor yet: not usable)`);
    },
    // [interact] death boxes are usables of interact.ts; loot.ts hands over anything that is not one of its boxes
    foreign: {
      execute: (conn, p, e, nearest) => this.interact?.execute(conn, p as Player, e, nearest) ?? false,
      stop: (conn, p, usable, result) => this.interact?.stop(conn, p as Player, usable, result) ?? false,
      take: (conn, p, source, id) => this.interact?.take(conn, p as Player, source, id) ?? false,
    },
  }) : null;

  // ---------------------------------------------------------------- [interact] shop, wallet, death boxes (all logic in interact.ts)
  private interact: Ix.InteractManager<UEConn> | null = Ix.INTERACT_ENABLED && Loot.LOOT_ENABLED ? new Ix.InteractManager<UEConn>({
    log: (m) => this.log(m),
    sendBunch: (conn, body, opts) => { this.sendBunch(conn, body, { ...opts, nameIndex: EChannelName.Actor }); },
    writeNewActor: (w, guid, arch, loc, rot) => writeNewActor(w, guid, arch, loc, rot, GUID.Level),
    writeActorBlock: (w, p, hasRep) => writeContentBlock(w, hasRep, true, p.buffer(), p.bits),
    writeStableBlock: (w, guid, hasRep, payload) => this.writeStableBlock(w, guid, hasRep, payload),
    conns: () => [...this.conns.values()].filter((c) => c.state === "joined"),
    owners: () => {
      const out: { conn: UEConn; p: Player }[] = [];
      for (const conn of this.conns.values()) {
        if (conn.state !== "joined") continue;
        const key = this.key(conn.addr);
        const p = [...this.players.values()].find((x) => !x.isBot && x.connKey === key);
        if (p) out.push({ conn, p });
      }
      return out;
    },
    ord: (p) => this.statsOrdinal(p as Player),
    get gameStateGuid() { return GUID.GameStateActor; },
    gameStateCh: GAMESTATE_CH,
    worldTime: () => (Date.now() - this.startTime) / 1000,
    floorAt: (x, y) => floorAt(this.currentMap, x, y),
    gold: (p) => this.match.lootGoldOf(p.id),
    spendGold: (p, amount) => this.match.spendLootGold(p.id, amount),
    credit: (p, kind, amount, def, d) => {
      if (kind === "loot" && def && d) {
        if (def.kind === "gold") return `gold +${d.opt ?? 0} = ${this.match.grantLootGold(p.id, d.opt ?? 0)}`;
        if (def.kind === "armor") return `armor T${def.armorTier} -> shield ${this.match.grantLootArmor(p.id, Loot.ARMOR_SHIELD[def.armorTier ?? 0] ?? 75) ?? "refused"}`;
        return `${def.key} x${d.stacks ?? 1} (not usable yet)`;
      }
      if (kind === "gold") return `gold +${amount} = ${this.match.grantLootGold(p.id, amount)}`;
      if (kind === "heal") return `heal -> ${this.match.lootHeal(p.id, amount)?.join("/") ?? "refused"}`;
      if (kind === "repair") return `shield refill -> ${this.match.lootHeal(p.id, 0, true)?.join("/") ?? "refused"}`;
      if (kind === "armor") return `armor -> shield ${this.match.grantLootArmor(p.id, amount) ?? "refused"}`;
      return "no credit";
    },
    asc: (conn, p) => this.loot?.sharedAsc(conn, p) ?? null,
  }) : null;

  // ---------------------------------------------------------------- [armory] in-match armory buys + purse rules (all logic in armory.ts)
  private armoryMode(): string {
    const k = this.modeProfile?.key;
    if (k === "ffa") return "ffa";
    if (!k || k === "solos" || k === "duos" || k === "turbobr") return /LVL_SkylandsBreach$/.test(this.currentMap) ? "breach" : "other";
    return k;
  }
  private armory: Armory.ArmoryManager<UEConn> | null = Armory.ARMORY_ENABLED || Armory.PURSE_ENABLED ? new Armory.ArmoryManager<UEConn>({
    log: (m) => this.log(m),
    sendBunch: (conn, body, opts) => { this.sendBunch(conn, body, { ...opts, nameIndex: EChannelName.Actor }); },
    ord: (p) => this.statsOrdinal(p as Player),
    mode: () => this.armoryMode(),
    player: (id) => this.players.get(id),
    connOf: (p) => [...this.conns.values()].find((c) => this.key(c.addr) === (p as Player).connKey),
    gold: (p) => this.match.lootGoldOf(p.id),
    spendGold: (p, amount) => this.match.spendLootGold(p.id, amount),
    grantGold: (p, amount) => this.match.grantLootGold(p.id, amount),
    boost: (p, hp) => {
      const r = this.match.grantMaxHp(p.id, hp);
      if (!r) return "no sim effect (dead/unknown)";
      const pl = p as Player; pl.health = r[0]; pl.maxHealth = r[1];
      if (REP_CARRIER) for (const c of this.conns.values()) if (c.state === "joined") this.sendCarrierHealth(c, pl);
      return `max hp +${hp} -> ${r[0]}/${r[1]}`;
    },
    syncWallet: (conn, p) => this.interact?.syncWallet(conn, p as Player, true),
  }) : null;

  // ---------------------------------------------------------------- [capture] Breach basecamps (all logic in capture.ts)
  private capture: Capture.CaptureManager<UEConn> | null = Capture.CAPTURE_ENABLED ? new Capture.CaptureManager<UEConn>({
    log: (m) => this.log(m),
    sendBunch: (conn, body, opts) => { this.sendBunch(conn, body, { ...opts, nameIndex: EChannelName.Actor }); },
    writeActorBlock: (w, p, hasRep) => writeContentBlock(w, hasRep, true, p.buffer(), p.bits),
    writeStableBlock: (w, guid, hasRep, payload) => this.writeStableBlock(w, guid, hasRep, payload),
    conns: () => [...this.conns.values()].filter((c) => c.state === "joined"),
    levelGuid: () => GUID.Level,
    retailGuid: (name) => {
      const short = this.currentMap.split("/").pop()!;
      return this.retail ? this.retail.guidByPath.get(`${this.currentMap}.${short}.PersistentLevel.${name}`) : undefined;
    },
    worldTime: () => (Date.now() - this.startTime) / 1000,
    units: () => [...this.players.values()].filter((p) => p.spawned).map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y, z: p.z, alive: p.alive, isBot: p.isBot })),
  }) : null;

  /** Boxes on this connection (Breach only) + the owner's LokiInteractionPlayerComponent / LokiInventoryOperationsV2 exports. */
  private spawnLoot(conn: UEConn, owner: Player) {
    if (!this.loot || !/LVL_SkylandsBreach$/.test(this.currentMap)) return;
    if (!this.loot.boxes.length) {
      const spawns = Loot.boxSpawns(this.currentMap, floorSpawnList(this.currentMap), (x, y) => floorAt(this.currentMap, x, y));
      this.loot.setup(spawns, (Loot.hash32(this.currentMatchId || this.serverId) ^ Date.now()) >>> 0);
    }
    this.loot.exportPcComponents(conn, owner);
    this.loot.spawnFor(conn);
    this.armory?.onJoin(conn, owner); // [armory] hook: component export + FFA start purse (before the wallet sync below)
    this.interact?.spawnFor(conn, owner);
    this.capture?.spawnFor(conn); // [capture] hook: the 24 basecamps
  }

  /** Health update on a player's carrier (after damage / death / respawn). */
  private sendCarrierHealth(conn: UEConn, p: Player) {
    const ord = this.statsOrdinal(p), ch = CARRIER_CH_BASE + ord;
    if (!conn.channels.has(ch)) return;
    const healthGuid = carrierGuid(ord) + 4n;
    const cur = p.alive ? Math.max(0, p.health) : 0, maxHp = p.maxHealth || 1000;
    const hp = new BitWriter(256);
    this.propPayload(hp, [rawField(1, "hb", (w) => w.float(cur)), rawField(2, "hc", (w) => w.float(cur)), rawField(3, "mb", (w) => w.float(maxHp)), rawField(4, "mc", (w) => w.float(maxHp))]);
    this.sendBunch(conn, (w) => this.writeStableBlock(w, healthGuid, true, hp),
      { ch, reliable: true, nameIndex: EChannelName.Actor, exports: [{ guid: healthGuid, path: "AttributeSetHealth", outer: carrierGuid(ord), noLoad: true }] });
  }

  /** ClientVisibleSetDelta on the owned PlayerState: the full set (baseline 0 -> set 1) of every hero open on this connection.
   *  The client's VisibilityReceiver hides any actor (and its attachments) the server has not listed. */
  private sendVisibleSet(conn: UEConn, owner: Player) {
    if (!REP_VISIBLE) return;
    const guids = [...this.players.values()].filter((q) => conn.channels.has(q.channel + 1)).map((q) => q.actorGuid);
    // own pawn first, at most 40 per array (VisibleUnitsDelta::MaximumActorsPerArray)
    guids.sort((a, b) => (a === owner.actorGuid ? -1 : b === owner.actorGuid ? 1 : 0));
    const list = guids.slice(0, 40);
    conn.visSetId = (conn.visSetId || 0) + 1;
    const p = new BitWriter(1024);
    p.bit(true); // param send bit
    p.uint32(0); p.uint32(conn.visSetId);
    p.wrapped(list.length, 128); for (const g of list) p.packed64(g);
    p.wrapped(0, 128);
    const field = new BitWriter(p.bits + 64);
    field.serializeIntVar(VIS_FIELD, VIS_FIELD_MAX); field.packed32(p.bits); field.bitsFrom(p.buffer(), p.bits);
    this.sendBunch(conn, (w) => writeContentBlock(w, false, true, field.buffer(), field.bits),
      { ch: owner.channel - 1, reliable: true, nameIndex: EChannelName.Actor });
    this.log(`[ue] visible set ${conn.visSetId} -> ${owner.id} actors=${list.length}`);
  }

  private spawnTeams(conn: UEConn, self: Player) {
    const C = "LokiTeamState", CO = "LokiTeamState_TeamOnly";
    const ENET_SIMULATED = 1, ENET_AUTHORITY = 3;
    const sent: number[] = [];
    for (const t of this.teamIndices()) {
      const members = [...this.players.values()].filter((p) => p.team === t && (!p.kind || p.kind === "hero"));
      const mine = t === self.team;
      if (mine && !conn.channels.has(teamOnlyChannel(t))) {
        const ch = teamOnlyChannel(t);
        conn.channels.add(ch);
        const exports = this.exportsFor(self, conn);
        this.sendBunch(conn, (w) => {
          writeNewActor(w, teamOnlyGuid(t), GUID_TEAMONLY_CDO, [0, 0, 0], [0, 0, 0], GUID.Level);
          const payload = new BitWriter(256);
          this.propPayload(payload, [
            this.val(CO, "RemoteRole", ENET_SIMULATED),
            this.val(CO, "Role", ENET_AUTHORITY),
            this.val(CO, "DropLeader", self.psGuid),
          ]);
          writeContentBlock(w, true, true, payload.buffer(), payload.bits);
        }, { ch, open: true, reliable: true, exports, mustBeMapped: [GUID_TEAMONLY_CDO, GUID.GamePackage], nameIndex: EChannelName.Actor });
      }
      const ch = teamChannel(t);
      if (conn.channels.has(ch)) continue;
      conn.channels.add(ch);
      const exports = this.exportsFor(self, conn);
      this.sendBunch(conn, (w) => {
        writeNewActor(w, teamGuid(t), GUID_TEAM_CDO, [0, 0, 0], [0, 0, 0], GUID.Level);
        const payload = new BitWriter(1024);
        this.propPayload(payload, [
          this.val(C, "RemoteRole", ENET_SIMULATED),
          this.val(C, "Role", ENET_AUTHORITY),
          this.val(C, "KillerIndex", -1),
          this.objArray(C, "Players", members.map((p) => p.psGuid)),
          this.val(C, "RespawnIndex", -1),
          this.val(C, "Index", t),
          this.val(C, "Placement", 0),
          ...(mine ? [this.val(C, "TeamStateTeamOnly", teamOnlyGuid(t))] : []),
        ]);
        writeContentBlock(w, true, true, payload.buffer(), payload.bits);
      }, { ch, open: true, reliable: true, exports, mustBeMapped: [GUID_TEAM_CDO, GUID_TEAM_PKG], nameIndex: EChannelName.Actor });
      sent.push(t);
    }
    if (sent.length) this.log(`[ue] team states -> ${this.key(conn.addr)} teams=${sent.length} self=${self.team}`);
  }

  /** Real per-mode GameState class from the usmap-derived mode table. */
  // ---------------------------------------------------------------- per-mode profiles (modeconfig.ts)
  private modeAppliedTo: MatchWorld | null = null;
  private scorePushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Applies the allocation's mode profile to the (not yet started) sim. Breach-family modes have no profile,
   *  so for Breach this is a no-op unless a previous non-Breach profile has to be undone. LOKI_MODES=0 = off. */
  private applyModeProfile() {
    const prof = modeProfileFor(this.currentGameMode, this.currentMap, this.currentQueueId);
    if (!prof && !this.modeProfile) return;
    if (prof?.key === this.modeProfile?.key && this.modeAppliedTo === this.match) return;
    const base = this.config.rules;
    const clear: Partial<MatchRules> = {
      soloTeams: undefined, pveHumanTeam: undefined, endOnLastTeam: undefined, roundsToWin: undefined, roundIntermissionMs: undefined,
      teamScorePerKill: undefined, teamScoreLimit: undefined, spawnInvulnMs: undefined, botGraceMs: undefined, botAggroSpreadMs: undefined,
      objective: undefined, botVsBotDamageScale: undefined, botVsHumanDamageScale: undefined,
    };
    const { abilities: _a, ...baseRules } = base;
    const rules: Partial<MatchRules> = {
      ...baseRules, maxPlayers: this.options.maxPlayers, ...clear, ...(prof?.rules || {}),
      zone: { ...base.zone, ...(prof?.rules.zone || {}) }, shot: { ...base.shot, ...(prof?.rules.shot || {}) },
    };
    const mode = resolveMode(this.currentGameMode, this.currentMap);
    if (!this.match.configureMode(rules, mode.gameModeType)) {
      this.log(`[mode] profile ${prof?.key ?? "breach"} not applied: match already started`);
      return;
    }
    this.modeProfile = prof;
    this.modeAppliedTo = this.match;
    this.log(`[mode] profile=${prof?.key ?? "breach"} evidence=${prof?.evidence ?? "live"} gs=${mode.gameState.cls} map=${this.currentMap.split("/").pop()} queue=${this.currentQueueId || "?"} ` +
      `teams=${rules.teamCount} max=${rules.maxPlayers} respawn=${rules.respawnMs} rounds=${rules.roundsToWin ?? 0} teamScore=${rules.teamScoreLimit ?? 0} zone=${rules.zone?.enabled ? "on" : "off"} drop=${this.dropEnabled()}`);
  }

  private playerStateBp() {
    return this.modeProfile?.playerState && process.env.LOKI_MODE_PS !== "0" ? this.modeProfile.playerState : PLAYER_STATE_BP;
  }

  /** GameState TeamScores (TArray<int32>, element handle i+1 like TeamStates) indexed by team. */
  private teamScoresEntry(): [NetField | null, (w: BitWriter) => void] {
    const snap = this.match.getSnapshot();
    const src = snap.roundWins || snap.teamScores || {};
    const n = Math.max(0, ...this.teamIndices().map((t) => t + 1), ...Object.keys(src).map((t) => Number(t) + 1));
    return [this.handleFor(SV_CLASS.gameState, "TeamScores"), (w) => {
      w.uint16(n);
      for (let i = 0; i < n; i++) { w.packed32(i + 1); w.int32(Number(src[i] || 0)); }
      w.packed32(0);
    }];
  }

  /** Extra GameState fields for non-Breach profiles (retail FFA open: MaxPlayersPerTeam 1, GameOverWorldTime). */
  private modeGsProps(): Array<[NetField | null, (w: BitWriter) => void]> {
    const p = this.modeProfile;
    if (!p) return [];
    const C = SV_CLASS.gameState;
    const out: Array<[NetField | null, (w: BitWriter) => void]> = [];
    if (p.maxPlayersPerTeam) out.push(this.val(C, "MaxPlayersPerTeam", p.maxPlayersPerTeam));
    if (p.teamScoreToWin) out.push(this.val(C, "TeamScoreToWin", p.teamScoreToWin));
    if (p.rules.roundsToWin || p.rules.teamScorePerKill || p.rules.objective) out.push(this.teamScoresEntry());
    if (process.env.LOKI_MODE_GAMEOVER !== "0") out.push(this.val(C, "GameOverWorldTime", this.worldTime() + this.match.getSnapshot().remainingMs / 1000));
    return out;
  }

  /** Mode events: respawned humans are teleported to their sim spawn, score/round changes go to every GameState. */
  private onModeEvent(event: MatchEvent) {
    if (!this.modeProfile) return;
    if (event.type === "respawn" && event.x !== undefined && process.env.LOKI_MODE_RESPAWN_TP !== "0") {
      const pl = this.players.get(event.id);
      const conn = pl && !pl.isBot ? this.conns.get(pl.connKey) : undefined;
      if (pl && conn && conn.state === "joined" && pl.spawned) {
        const dest: [number, number, number] = [event.x, event.y!, event.z!];
        setTimeout(() => this.sendClientSetLocation(conn, pl, dest, pl.yaw || 0, "respawn"), 80);
      }
    }
    if (event.type === "round_end") this.log(`[mode] round ${event.round} winner=${event.winner} wins=${JSON.stringify(event.wins)}`);
    if (event.type === "round_start") this.log(`[mode] round ${event.round} start`);
    if (event.type === "objective") this.log(`[obj] ${event.what} team=${event.team} ${event.detail}`);
    if (event.type === "team_score" && event.reason && event.reason !== "push" && event.reason !== "held") this.log(`[obj] score team=${event.team} ${event.score} (${event.reason})`);
    if (event.type === "round_end") {
      for (const conn of this.conns.values()) if (conn.state === "joined") this.sendGsProps(conn, [this.teamScoresEntry()]);
    }
    if (event.type === "team_score" && !this.scorePushTimer) {
      // objective scores tick often (held points, tug %): coalesce TeamScores pushes to one per 400 ms
      this.scorePushTimer = setTimeout(() => {
        this.scorePushTimer = null;
        for (const conn of this.conns.values()) if (conn.state === "joined") this.sendGsProps(conn, [this.teamScoresEntry()]);
      }, 400);
    }
  }

  private gameStateClassName(): { cls: string; pkg: string } {
    return resolveMode(this.currentGameMode, this.currentMap).gameState;
  }

  private spawnPlayer(conn: UEConn, player: Player) {
    // PlayerControllers are bOnlyRelevantToOwner: a client that receives a foreign PC
    // runs HandleClientPlayer on it and binds the wrong local controller.
    const owned = player.connKey === this.key(conn.addr);
    const spawn = (actor: bigint, archetype: bigint, ch: number) => {
      if (conn.channels.has(ch)) return;
      conn.channels.add(ch);
      // exportsFor() is called per spawn: conn.exportedGuids makes only the first
      // bunch on this connection carry the export section.
      const exports = this.exportsFor(player, conn);
      const mustBeMapped = [archetype, ARCHETYPE_PACKAGE.get(archetype) ?? 0n].filter((g) => g > 0n);
      this.sendBunch(conn, (w) => {
        writeNewActor(w, actor, archetype, [player.x, player.y, player.z], [0, player.yaw, 0], GUID.Level);
        // APlayerController::OnSerializeNewActor / OnActorChannelOpen: uint8 NetPlayerIndex
        // sits between the new-actor header and the first content block.
        if (actor === player.pcGuid) w.uint8(0);
        if (!REP_NONE) this.writeInitialProperties(w, player, actor, owned);
      }, { ch, open: true, reliable: true, exports, mustBeMapped, nameIndex: EChannelName.Actor });
    };
    spawn(GUID.GameStateActor, GUID.GameStateClass, GAMESTATE_CH);
    if (!conn.authCfgSent && process.env.LOKI_AUTHCFG !== "0") { conn.authCfgSent = true; setTimeout(() => this.sendAuthConfig(conn), Number(process.env.LOKI_AUTHCFG_DELAY_MS || 800)); }
    spawn(player.psGuid, GUID.PlayerStateClass, player.channel - 1);
    if (REP_STATS) this.sendStats(conn, player, true);
    if (owned) spawn(player.pcGuid, GUID.PlayerControllerClass, player.channel);
    const selfTeam = conn.heroGate === "team" ? [...this.players.values()].find((p) => p.connKey === this.key(conn.addr))?.team : undefined;
    if (conn.heroGate === "all" || (conn.heroGate === "team" && player.team === selfTeam)) {
      spawn(player.actorGuid, heroCdoGuid(heroBlueprint(player.heroId).index), player.channel + 1);
      if (REP_CARRIER) {
        this.spawnCarrier(conn, player);
        if (player.connKey === this.key(conn.addr)) setTimeout(() => this.grantAbilities(conn, player), Number(process.env.LOKI_GAS_GRANT_MS || 4000));
      }
    }
    if (owned && !conn.restartSent) {
      conn.restartSent = true;
      if (this.dropEnabled()) {
        setTimeout(() => this.sendSetHud(conn, player), 1500);
        setTimeout(() => this.sendGotoState(conn, player, Drop.NAME_SPECTATING), 2300);
        setTimeout(() => this.openDrop(conn, player), Number(process.env.LOKI_DROP_OPEN_MS || 8000));
      } else {
        for (const [i, delay] of [1500, 5000].entries()) setTimeout(() => this.sendClientRestart(conn, player, i === 0), delay);
        for (const d of [2200, 6000]) setTimeout(() => { if (this.conns.has(this.key(conn.addr))) this.sendVisibleSet(conn, player); }, d);
      }
      // Hold the hero at its spawn while World Partition streams the island in. Without this the
      // possessed pawn starts falling at t=0, drops below the not-yet-loaded floor and never lands
      // (2026-11-24: z -48,000 after 46 s, camera following it = "still spectating").
      // Drop modes land on verified floor; non-drop modes on a streamed map (Warm-Up FFA on Breach) spawn the hero
      // before its island is loaded and it fell through ("Zeph fell down the map"), so they are pinned by default.
      if (process.env.LOKI_PIN === "1" || (process.env.LOKI_PIN !== "0" && !this.dropEnabled() && hasSpawnPoints(this.currentMap))) {
        const sp = spawnPointFor(this.currentMap, player.team, player.id);
        const pinMs = (process.env.LOKI_PIN_MS || "1700,2300,3000,3800,4600,5300,6000,7000,8000,9500,11000").split(",").map(Number);
        for (const d of pinMs) setTimeout(() => {
          const st = this.moveState.get(player.id);
          if (st && st.z > sp.z - 150 && d > 6000) return; // already standing near spawn
          if (st?.lastGood && st.z > sp.z - 400) return; // walking on real ground already: never yank a moving player back
          this.sendClientSetLocation(conn, player, [sp.x, sp.y, sp.z], player.yaw || 0, "pin");
        }, d);
      }
    }
  }

  /** APlayerController::ClientRestart(NewPawn) — the client-side possession that sets Pawn->Controller,
   *  calls AcknowledgePossession and lets the HUD leave the loading screen. Field index = position in the
   *  BP_LokiPlayerController_C ClassNetCache (Actor 11 + Controller 4 + PC props 3 + PC net funcs sorted,
   *  flags read from the live client's FFunctionParams → data/sv-funcflags-204.json).
   *  SerializeInt is variable-width, so LOKI_PC_FIELD_MAX (fields+1) matters: 162 if the BP adds nothing. */
  // ---------------------------------------------------------------- the drop (plane phase), drop.ts
  /** LOKI_DROP=plane (default on SkylandsBreach) runs retail's plane timeline; =off keeps the old
   *  possess-at-join flow. The pod itself is not built yet: a launch lands the hero directly. */
  private possessAtLand() {
    return this.dropEnabled() && (process.env.LOKI_DROP_POSSESS || "land").toLowerCase() !== "combat";
  }

  private dropEnabled() {
    const m = (process.env.LOKI_DROP || "plane").toLowerCase();
    if (m === "off" || m === "0") return false;
    return m === "force" || (/SkylandsBreach/.test(this.currentMap) && (this.modeProfile?.drop ?? true));
  }

  private worldTime() { return (Date.now() - this.startTime) / 1000 + 1000; }

  private sendSetHud(conn: UEConn, player: Player) {
    if (!this.conns.has(this.key(conn.addr))) return;
    const hudPkg = process.env.LOKI_HUD_PKG || (process.env.LOKI_MODE_HUD !== "0" && this.modeProfile?.hud) || "/Game/Loki/Core/GameModes/BP_LokiGameHUD";
    const hudCls = hudPkg.split("/").pop() + "_C";
    const exports: GuidExport[] = [];
    if (!conn.exportedGuids.has(GUID_HUD_PKG)) {
      conn.exportedGuids.add(GUID_HUD_PKG); conn.exportedGuids.add(GUID_HUD_CLASS);
      exports.push({ guid: GUID_HUD_PKG, path: hudPkg, outer: 0n }, { guid: GUID_HUD_CLASS, path: hudCls, outer: GUID_HUD_PKG });
    }
    this.sendPcRpc(conn, player, "ClientSetHUD", Number(process.env.LOKI_PC_SETHUD_IDX || 54), (p) => {
      p.bit(true); writeNetGuid(p, GUID_HUD_CLASS);
    }, exports, [GUID_HUD_CLASS, GUID_HUD_PKG]);
  }

  private sendGotoState(conn: UEConn, player: Player, nameIndex: number) {
    if (!this.conns.has(this.key(conn.addr))) return;
    this.sendPcRpc(conn, player, `ClientGotoState(${nameIndex === Drop.NAME_PLAYING ? "Playing" : nameIndex})`, 31, (p) => {
      p.bit(true); p.bit(true); p.packed32(nameIndex);
    });
  }

  /** One reliable GameState property block. */
  private sendGsProps(conn: UEConn, entries: Array<[NetField | null, (w: BitWriter) => void]>) {
    if (!conn.channels.has(GAMESTATE_CH)) return;
    const payload = new BitWriter(512);
    this.propPayload(payload, entries);
    this.sendBunch(conn, (w) => writeContentBlock(w, true, true, payload.buffer(), payload.bits), { ch: GAMESTATE_CH, reliable: true, nameIndex: EChannelName.Actor });
  }

  private sendPsProps(conn: UEConn, player: Player, entries: Array<[NetField | null, (w: BitWriter) => void]>) {
    const ch = player.channel - 1;
    if (!conn.channels.has(ch)) return;
    const payload = new BitWriter(256);
    this.propPayload(payload, entries);
    this.sendBunch(conn, (w) => writeContentBlock(w, true, true, payload.buffer(), payload.bits), { ch, reliable: true, nameIndex: EChannelName.Actor });
  }

  /** Stably named subobject block (retail's header: guid, bStablyNamed 1, then a 0 bit). */
  private writeStableBlock(w: BitWriter, guid: bigint, hasRepLayout: boolean, payload: BitWriter | null) {
    w.bit(hasRepLayout); w.bit(false); writeNetGuid(w, guid); w.bit(true); w.bit(false);
    const bits = payload ? payload.bits : 0;
    w.packed32(bits);
    if (payload && bits) w.bitsFrom(payload.buffer(), bits);
  }

  private planeState: { start: number[]; end: number[]; openedAt: number; startedAt?: number; allowed: number } | null = null;

  private planeExports(conn: UEConn): GuidExport[] {
    const out: GuidExport[] = [];
    const add = (guid: bigint, path: string, outer: bigint, noLoad: boolean) => {
      if (conn.exportedGuids.has(guid)) return; conn.exportedGuids.add(guid); out.push({ guid, path, outer, noLoad });
    };
    add(GUID_PLANE_PKG, Drop.PLANE_PKG, 0n, false);
    add(GUID_PLANE_CDO, `Default__${Drop.PLANE_CLS}`, GUID_PLANE_PKG, false);
    // retail re-exports the rideable's path in every bunch that references it
    out.push({ guid: GUID_PLANE_RIDE, path: Drop.RIDEABLE_NAME, outer: GUID_PLANE, noLoad: true });
    return out;
  }

  /** Plane open for one connection: retail frame 12.141 (flow 7038). */
  private openDrop(conn: UEConn, player: Player) {
    if (!this.conns.has(this.key(conn.addr)) || conn.drop.opened) return;
    const now = Date.now();
    conn.drop.opened = now;
    if (!this.planeState) {
      const usePath = process.env.LOKI_DROP_PATH || "spawn";
      const through = [player.x, player.y, 0];
      const p = usePath === "retail" ? { start: [...Drop.RETAIL_PATH.start], end: [...Drop.RETAIL_PATH.end] } : Drop.pathThrough(through);
      this.planeState = { ...p, openedAt: now, allowed: this.worldTime() };
    }
    const ps = this.planeState;
    const wt = this.worldTime();
    const G = SV_CLASS.gameState;
    this.sendGotoState(conn, player, Drop.NAME_SPECTATING);
    this.sendGotoState(conn, player, Drop.NAME_PLAYING);
    this.sendGsProps(conn, [
      this.val(G, "bGetPreventWeaponFire", true), this.val(G, "bGetPreventMovement", true),
      this.val(G, "SpawnSelectEndTime", wt + 1), this.val(G, "CurrentPhase", Drop.PHASE.SpawnSelect),
    ]);
    // the plane actor + its stable rideable (empty block, as retail)
    conn.channels.add(PLANE_CH);
    const open = Drop.planeOpenPayload(ps.start, ps.end, ps.allowed);
    this.sendBunch(conn, (w) => {
      writeNewActor(w, GUID_PLANE, GUID_PLANE_CDO, [ps.start[0]!, ps.start[1]!, ps.start[2]!], [0, 0, 0], GUID.Level);
      writeContentBlock(w, true, true, open.buffer(), open.bits);
      this.writeStableBlock(w, GUID_PLANE_RIDE, false, null);
    }, { ch: PLANE_CH, open: true, reliable: true, nameIndex: EChannelName.Actor, exports: this.planeExports(conn), mustBeMapped: [GUID_PLANE_CDO] });
    // the PlayerState's dynamic drop component, created bound to the plane
    this.createDropComponent(conn, player);
    const at = (s: number, fn: () => void) => setTimeout(() => { if (this.conns.has(this.key(conn.addr))) fn(); }, Math.round(s * 1000));
    at(Drop.T_SPAWN_REVEAL, () => this.sendGsProps(conn, [
      this.val(G, "SpawnSelectEndTime", this.worldTime() + 1), this.val(G, "CurrentPhase", Drop.PHASE.SpawnReveal),
    ]));
    at(Drop.T_COMBAT, () => this.dropCombat(conn, player));
    at(Drop.T_CAN_EXIT, () => this.sendPlaneSub(conn, true, Drop.canExitPayload(), false));
    at(Drop.T_START, () => this.startPlane(conn));
    const fallback = Number(process.env.LOKI_DROP_FALLBACK_MS || 25_000);
    at(Drop.T_START + fallback / 1000, () => { if (!conn.drop.launched) { this.log(`[drop] fallback launch ${player.id}`); this.launchDrop(conn, player); } });
    this.log(`[drop] plane open -> ${this.key(conn.addr)} start=(${ps.start.map(Math.round)}) end=(${ps.end.map(Math.round)})`);
  }

  private createDropComponent(conn: UEConn, player: Player) {
    const ch = player.channel - 1;
    if (!conn.channels.has(ch)) return;
    const guid = DROP_COMP_GUID_BASE + BigInt(this.players.size > 0 ? [...this.players.values()].indexOf(player) : 0) * 2n;
    conn.drop.compGuid = guid;
    const exports: GuidExport[] = [];
    if (!conn.exportedGuids.has(GUID_DROPCOMP_PKG)) {
      conn.exportedGuids.add(GUID_DROPCOMP_PKG); conn.exportedGuids.add(GUID_DROPCOMP_CLS);
      exports.push({ guid: GUID_DROPCOMP_PKG, path: Drop.DROP_COMP_PKG, outer: 0n }, { guid: GUID_DROPCOMP_CLS, path: Drop.DROP_COMP_CLS, outer: GUID_DROPCOMP_PKG });
    }
    exports.push({ guid: GUID_PLANE_RIDE, path: Drop.RIDEABLE_NAME, outer: GUID_PLANE, noLoad: true });
    const payload = Drop.compPayload([
      [Drop.COMP_H.CurrentRideableObject, (w) => writeNetGuid(w, GUID_PLANE_RIDE)],
      [Drop.COMP_H.DropPlane, (w) => writeNetGuid(w, GUID_PLANE)],
    ]);
    this.sendBunch(conn, (w) => {
      // dynamic subobject header: guid, bStablyNamed 0, bIsDestroyMessage 0, class, bActorIsOuter 1
      w.bit(true); w.bit(false); writeNetGuid(w, guid); w.bit(false); w.bit(false); writeNetGuid(w, GUID_DROPCOMP_CLS); w.bit(true);
      w.packed32(payload.bits); w.bitsFrom(payload.buffer(), payload.bits);
    }, { ch, reliable: true, nameIndex: EChannelName.Actor, exports, mustBeMapped: [GUID_DROPCOMP_CLS, GUID_DROPCOMP_PKG] });
  }

  private sendDropComp(conn: UEConn, player: Player, entries: Array<[number, (w: BitWriter) => void]>, exports?: GuidExport[]) {
    const guid = conn.drop.compGuid;
    if (!guid) return;
    const payload = Drop.compPayload(entries);
    this.sendBunch(conn, (w) => {
      w.bit(true); w.bit(false); writeNetGuid(w, guid); w.bit(false); w.bit(false); writeNetGuid(w, GUID_DROPCOMP_CLS); w.bit(true);
      w.packed32(payload.bits); w.bitsFrom(payload.buffer(), payload.bits);
    }, { ch: player.channel - 1, reliable: true, nameIndex: EChannelName.Actor, exports });
  }

  /** A block for the plane's rideable (properties or RPC fields). */
  private sendPlaneSub(conn: UEConn, rep: boolean, payload: BitWriter, unreliable = false) {
    if (!conn.channels.has(PLANE_CH)) return;
    this.sendBunch(conn, (w) => this.writeStableBlock(w, GUID_PLANE_RIDE, rep, payload),
      { ch: PLANE_CH, reliable: !unreliable, nameIndex: EChannelName.Actor, exports: [{ guid: GUID_PLANE_RIDE, path: Drop.RIDEABLE_NAME, outer: GUID_PLANE, noLoad: true }] });
  }

  private planeRiders(conn: UEConn) {
    return [...this.players.values()].filter((p) => p.spawned && !(p.connKey === this.key(conn.addr) && conn.drop.launched)).map((p) => p.psGuid);
  }

  /** Combat (retail 14.143): phase 7, the riders aboard, then possession in retail's order. */
  private dropCombat(conn: UEConn, player: Player) {
    conn.drop.combat = true;
    const G = SV_CLASS.gameState, wt = this.worldTime();
    this.sendGsProps(conn, [
      this.val(G, "bGetPreventWeaponFire", false), this.val(G, "bGetPreventMovement", false),
      this.val(G, "RoundStartTime", wt), this.val(G, "ReplicatedNumRemainingPlayers", this.match.all().filter((c) => c.alive).length || this.players.size),
      this.val(G, "GameStartWorldTime", wt), this.val(G, "CurrentPhase", Drop.PHASE.Combat),
    ]);
    const riders = this.planeRiders(conn);
    if (process.env.LOKI_DROP_BOARD_RPC !== "0") for (const g of riders) {
      this.sendPlaneSub(conn, false, Drop.rpcField(Drop.RIDE_FIELDS.BoardMulticast, Drop.RIDE_FIELDS.max, (p) => { p.bit(true); writeNetGuid(p, g); }));
    }
    this.sendPlaneSub(conn, true, Drop.ridersPayload(riders), true);
    // LOKI_DROP_POSSESS=land (default): no hero and no possession until the pod lands. Possessing at
    // Combat (retail order) left our hero under the plane with gravity on: it fell through unstreamed
    // terrain past KillZ and the client went to SPECTATING / team "DEAD" (2026-11-25 05:24 UTC run).
    if (this.possessAtLand()) conn.drop.deferRestart = true;
    else {
      if (conn.heroGate === "none") conn.heroGate = "team";
      for (const p of this.players.values()) if (p.spawned) this.spawnPlayer(conn, p);
      this.sendClientRestart(conn, player, false);
    }
    this.startZone(conn); // [zone]
    this.log(`[drop] combat -> ${this.key(conn.addr)} riders=${riders.length}`);
  }

  private startPlane(conn: UEConn) {
    if (!this.planeState || conn.drop.started) return;
    conn.drop.started = true;
    if (!this.planeState.startedAt) this.planeState.startedAt = Date.now();
    const wt = this.worldTime() - (Date.now() - this.planeState.startedAt) / 1000;
    const p = Drop.planeStartPayload(wt);
    this.sendBunch(conn, (w) => writeContentBlock(w, true, true, p.buffer(), p.bits), { ch: PLANE_CH, reliable: true, nameIndex: EChannelName.Actor });
    this.log(`[drop] plane start -> ${this.key(conn.addr)} t=${wt.toFixed(2)} duration=${Drop.planeDuration(this.planeState.start, this.planeState.end).toFixed(1)}s`);
  }

  /** Per tick while flying: the server flies the plane (retail ~30 Hz loc-only RepMovement). */
  private replicatePlane(conn: UEConn) {
    const ps = this.planeState;
    if (!ps?.startedAt || !conn.drop.started || !conn.channels.has(PLANE_CH)) return;
    const t = (Date.now() - ps.startedAt) / 1000;
    const dur = Drop.planeDuration(ps.start, ps.end);
    if (t > dur + 1) return;
    const loc = Drop.planeLocationAt(ps.start, ps.end, t).map(Math.round);
    const p = Drop.planeMovePayload(loc);
    this.sendBunch(conn, (w) => writeContentBlock(w, true, true, p.buffer(), p.bits), { ch: PLANE_CH, reliable: false, nameIndex: EChannelName.Actor });
  }

  /** Client RPCs on the owned PlayerState's drop component (ServerSetDropPodDestination 10, ServerLaunchDropPod 8). */
  private onPsBunch(conn: UEConn, player: Player, bunch: Bunch) {
    for (const extra of [0, 1]) {
      const fields = readSubobjectRpc(bunch.data, bunch.bits, Drop.COMP_FIELDS.max, extra);
      if (!fields) continue;
      for (const f of fields) {
        if (f.idx === Drop.COMP_FIELDS.ServerSetDropPodDestination) {
          try {
            const r = new BitReader(f.data, f.bits);
            if (r.bit()) { const v: [number, number, number] = [r.double(), r.double(), r.double()]; conn.drop.dest = v; }
          } catch {}
          this.log(`[drop] ServerSetDropPodDestination ${player.id} -> ${conn.drop.dest?.map(Math.round)}`);
          this.sendDropComp(conn, player, [[Drop.COMP_H.bDropLocationSelected, (w) => w.bit(true)]]);
        } else if (f.idx === Drop.COMP_FIELDS.ServerLaunchDropPod) {
          this.log(`[drop] ServerLaunchDropPod ${player.id}`);
          this.launchDrop(conn, player);
        } else if (!this.pcRpcSeen.has(1000 + f.idx)) {
          this.pcRpcSeen.add(1000 + f.idx);
          this.log(`[drop] comp rpc idx=${f.idx} bits=${f.bits} from ${player.id}`);
        }
      }
      return;
    }
  }

  /** The launch (ServerLaunchDropPod, or the fallback): the leader's BP_DropPod_C 21015 uu above the spot
   *  running retail's Intro -> Descending -> Outro -> Destroying timeline; at Destroying the hero is put
   *  down Walking on the nearest verified floor and the PlayerState goes Combat. LOKI_DROP_POD=0 skips the pod. */
  private launchDrop(conn: UEConn, player: Player) {
    if (conn.drop.launched || !this.conns.has(this.key(conn.addr))) return;
    conn.drop.launched = true;
    const P = SV_CLASS.playerState;
    const ps = this.planeState;
    const want = conn.drop.dest ?? (ps?.startedAt ? Drop.planeLocationAt(ps.start, ps.end, (Date.now() - ps.startedAt) / 1000) : [player.x, player.y, 0]);
    // Our floor triangles only cover ~6 km round the tutorial patch. Off that patch a guessed z put heroes under the
    // island (walking on z -923); instead drop them from LOKI_LAND_DROP_Z above the click so the client's own collision
    // lands them on the top surface, and the void rescue catches a miss.
    const lf = landingFloor(this.currentMap, want[0]!, want[1]!);
    // The floor triangles miss props/raised terrain, so an "exact" landing could put the hero inside a hill
    // (tester: "dropped into terrain", then fell through the island). Land a little above the triangle and let
    // the client's real collision put the hero down.
    const above = Number(process.env.LOKI_LAND_ABOVE || 600);
    // Not over terrain (e.g. the fallback launch at the plane's end, off the island): land on the nearest terrain
    // the ring search / verified floor found, never on the raw aim point - that was a fall into the void.
    const dropZ = Number(process.env.LOKI_LAND_DROP_Z || 2500);
    const floor = lf?.exact ? { ...lf, z: lf.z + above }
      : lf ? { x: lf.x, y: lf.y, z: Math.max(lf.z + above, dropZ) }
      : { x: want[0]!, y: want[1]!, z: dropZ };
    this.sendPsProps(conn, player, [this.val(P, "BattleRoyalePlayerPhase", Drop.BR_PHASE.Dropping)]);
    this.sendPlaneSub(conn, true, Drop.ridersPayload(this.planeRiders(conn)), true);
    const land = () => {
      if (!this.conns.has(this.key(conn.addr)) || conn.drop.landed) return;
      conn.drop.landed = true;
      conn.heroGate = "all";
      player.x = floor.x; player.y = floor.y; player.z = floor.z; player.vx = player.vy = player.vz = 0;
      this.match.setClientState(player.id, { x: floor.x, y: floor.y, z: floor.z, vx: 0, vy: 0, vz: 0, yaw: player.yaw, pitch: 0, grounded: true });
      this.moveState.delete(player.id);
      if (conn.drop.deferRestart) {
        // the hero opens standing on the landing floor, then the client possesses it
        conn.drop.deferRestart = false;
        for (const p of this.players.values()) if (p.spawned) this.spawnPlayer(conn, p);
        setTimeout(() => this.sendClientRestart(conn, player, false), 250);
        for (const d of [600, 1500, 3500, 8000]) setTimeout(() => { if (this.conns.has(this.key(conn.addr))) this.sendVisibleSet(conn, player); }, d);
        setTimeout(() => this.sendClientSetLocation(conn, player, [floor.x, floor.y, floor.z], player.yaw || 0, "land"), 900);
      } else {
        this.sendClientSetLocation(conn, player, [floor.x, floor.y, floor.z], player.yaw || 0, "land");
      }
      this.sendPsProps(conn, player, [this.val(P, "BattleRoyalePlayerPhase", Drop.BR_PHASE.Combat)]);
      this.sendDropComp(conn, player, [
        [Drop.COMP_H.bDropComplete, (w) => w.bit(true)],
        [Drop.COMP_H.CurrentRideableObject, (w) => writeNetGuid(w, 0n)],
        [Drop.COMP_H.DropPod, (w) => writeNetGuid(w, 0n)],
      ]);
      this.log(`[drop] landed ${player.id} at (${Math.round(floor.x)},${Math.round(floor.y)},${Math.round(floor.z)}) wanted (${want.map((v) => Math.round(v!))})`);
    };
    if (process.env.LOKI_DROP_POD === "0") { setTimeout(land, Number(process.env.LOKI_DROP_LAND_MS || 1500)); return; }
    this.openPod(conn, player, floor, land);
  }

  private openPod(conn: UEConn, player: Player, floor: { x: number; y: number; z: number }, land: () => void) {
    const ord = BigInt([...this.players.values()].indexOf(player));
    const pod = GUID_POD_BASE + ord * 0x10n, team = pod + 2n, ride = pod + 4n;
    const ch = POD_CH_BASE + Number(ord);
    const exports: GuidExport[] = [];
    if (!conn.exportedGuids.has(GUID_POD_PKG)) {
      conn.exportedGuids.add(GUID_POD_PKG); conn.exportedGuids.add(GUID_POD_CDO);
      exports.push({ guid: GUID_POD_PKG, path: Drop.POD_PKG, outer: 0n }, { guid: GUID_POD_CDO, path: `Default__${Drop.POD_CLS}`, outer: GUID_POD_PKG });
    }
    const subExports = [
      { guid: team, path: Drop.POD_TEAM_NAME, outer: pod, noLoad: true },
      { guid: ride, path: Drop.POD_RIDE_NAME, outer: pod, noLoad: true },
    ];
    const dest: [number, number, number] = [floor.x, floor.y, floor.z];
    const groundZ = floor.z - 110; // nearestFloor adds the spawn clearance
    const targetZ = groundZ + Drop.POD_HALF_HEIGHT;
    conn.channels.add(ch);
    const open = Drop.podOpenPayload({ pod, pilot: player.psGuid, team: Math.max(0, player.team), dest });
    this.sendBunch(conn, (w) => {
      writeNewActor(w, pod, GUID_POD_CDO, [Math.round(dest[0]), Math.round(dest[1]), Drop.POD_SPAWN_Z], [0, 0, 0], GUID.Level);
      writeContentBlock(w, true, true, open.buffer(), open.bits);
      this.writeStableBlock(w, team, true, Drop.teamPayload(Math.max(0, player.team)));
      this.writeStableBlock(w, ride, true, Drop.ridersPayload([player.psGuid]));
    }, { ch, open: true, reliable: true, nameIndex: EChannelName.Actor, exports: [...exports, ...subExports], mustBeMapped: [GUID_POD_CDO] });
    // the PlayerState component follows the pod (retail 37.161: rideable, DropPod, DropPodLaunched; then the multicast)
    this.sendDropComp(conn, player, [
      [Drop.COMP_H.CurrentRideableObject, (w) => writeNetGuid(w, ride)],
      [Drop.COMP_H.DropPod, (w) => writeNetGuid(w, pod)],
      [Drop.COMP_H.DropPodLaunched, (w) => w.bit(true)],
    ], [{ guid: ride, path: Drop.POD_RIDE_NAME, outer: pod, noLoad: true }]);
    setTimeout(() => this.sendDropCompRpc(conn, player, Drop.COMP_FIELDS.MulticastOnDropPodLaunched, (p) => { p.bit(true); writeNetGuid(p, pod); }), 40);
    const t0 = Date.now();
    const fallFrom = Drop.POD_SPAWN_Z, fallSecs = Drop.POD_T.destroying - Drop.POD_T.descending;
    const vz = -(fallFrom - targetZ) / fallSecs;
    const send = (payload: BitWriter, reliable: boolean) => {
      if (!this.conns.has(this.key(conn.addr)) || !conn.channels.has(ch)) return;
      this.sendBunch(conn, (w) => writeContentBlock(w, true, true, payload.buffer(), payload.bits), { ch, reliable, nameIndex: EChannelName.Actor });
    };
    const at = (s: number, fn: () => void) => setTimeout(fn, Math.round(s * 1000));
    at(Drop.POD_T.descending, () => send(Drop.podMovePayload([Math.round(dest[0]), Math.round(dest[1]), fallFrom], [0, 0, Math.round(vz)], Drop.POD_STATE.Descending), true));
    const fall = setInterval(() => {
      const t = (Date.now() - t0) / 1000 - Drop.POD_T.descending;
      if (t <= 0) return;
      if (t >= fallSecs || !this.conns.has(this.key(conn.addr))) { clearInterval(fall); return; }
      send(Drop.podMovePayload([Math.round(dest[0]), Math.round(dest[1]), Math.round(fallFrom + vz * t)], [0, 0, Math.round(vz)]), false);
    }, 34);
    at(Drop.POD_T.outro, () => send(Drop.podMovePayload([Math.round(dest[0]), Math.round(dest[1]), Math.round(fallFrom + vz * (Drop.POD_T.outro - Drop.POD_T.descending))], [0, 0, Math.round(vz)], Drop.POD_STATE.OutroSequence), true));
    at(Drop.POD_T.destroying, () => {
      send(Drop.podMovePayload([Math.round(dest[0]), Math.round(dest[1]), Math.round(targetZ)], [0, 0, 0], Drop.POD_STATE.Destroying, true), true);
      land();
    });
    at(Drop.POD_T.close, () => {
      if (!this.conns.has(this.key(conn.addr)) || !conn.channels.has(ch)) return;
      this.sendBunch(conn, () => {}, { ch, close: true, reliable: true, nameIndex: EChannelName.Actor });
      conn.channels.delete(ch);
    });
    this.log(`[drop] pod launch ${player.id} ch=${ch} dest=(${dest.map(Math.round)}) fall ${Math.round(fallFrom)}->${Math.round(targetZ)}`);
  }

  private sendDropCompRpc(conn: UEConn, player: Player, idx: number, params: (p: BitWriter) => void) {
    const guid = conn.drop.compGuid;
    if (!guid || !this.conns.has(this.key(conn.addr))) return;
    const f = Drop.rpcField(idx, Drop.COMP_FIELDS.max, params);
    this.sendBunch(conn, (w) => {
      w.bit(false); w.bit(false); writeNetGuid(w, guid); w.bit(false); w.bit(false); writeNetGuid(w, GUID_DROPCOMP_CLS); w.bit(true);
      w.packed32(f.bits); w.bitsFrom(f.buffer(), f.bits);
    }, { ch: player.channel - 1, reliable: true, nameIndex: EChannelName.Actor });
  }

  private sendClientRestart(conn: UEConn, player: Player, setHud = true) {
    if (!this.conns.has(this.key(conn.addr))) return;
    // APlayerController::ClientSetHUD(TSubclassOf<AHUD>) first, as GameMode::InitializeHUDForPlayer does:
    // without a HUD the Loki controller's TryUIReady retries forever behind the loading screen.
    const hudPkg = process.env.LOKI_HUD_PKG || (process.env.LOKI_MODE_HUD !== "0" && this.modeProfile?.hud) || "/Game/Loki/Core/GameModes/BP_LokiGameHUD";
    const hudCls = hudPkg.split("/").pop() + "_C";
    const exports: GuidExport[] = [];
    if (!conn.exportedGuids.has(GUID_HUD_PKG)) {
      conn.exportedGuids.add(GUID_HUD_PKG); conn.exportedGuids.add(GUID_HUD_CLASS);
      exports.push({ guid: GUID_HUD_PKG, path: hudPkg, outer: 0n }, { guid: GUID_HUD_CLASS, path: hudCls, outer: GUID_HUD_PKG });
    }
    if (setHud) this.sendPcRpc(conn, player, "ClientSetHUD", Number(process.env.LOKI_PC_SETHUD_IDX || 54), (p) => {
      p.bit(true); writeNetGuid(p, GUID_HUD_CLASS);
    }, exports, [GUID_HUD_CLASS, GUID_HUD_PKG]);
    // Retail order in one frame (recorded retail traffic flow 7038 t=14.143, v6b notes):
    // ClientGotoState(NAME_Playing=320) -> ClientRestart(hero) -> ClientSetRotation(0,0,0, bResetCamera=1).
    if (process.env.LOKI_GOTO_PLAYING !== "0") this.sendPcRpc(conn, player, "ClientGotoState(Playing)", 31, (p) => {
      p.bit(true); p.bit(true); p.packed32(Number(process.env.LOKI_NAME_PLAYING || 320)); // hardcoded FName
    });
    this.sendPcRpc(conn, player, "ClientRestart", Number(process.env.LOKI_PC_RESTART_IDX || 46), (p) => {
      p.bit(true); writeNetGuid(p, player.actorGuid); // NewPawn
    });
    if (process.env.LOKI_RESET_CAMERA !== "0") this.sendPcRpc(conn, player, "ClientSetRotation(reset)", 14, (p) => {
      p.bit(true); p.bit(false); p.bit(false); p.bit(false); // FRotator(0,0,0), every component compressed to 0
      p.bit(true);                                          // bResetCamera
    });
  }

  /** AController::ClientSetLocation(FVector NewLocation, FRotator NewRotation): Pawn->TeleportTo on the
   *  owning client. Field 13 = Actor 11 props + Controller {PlayerState, Pawn}, then Controller's net
   *  functions sorted (ClientSetLocation, ClientSetRotation). Params as the client itself sends
   *  ServerSetSpectatorLocation (197 bits): [1][FVector 3x double][1][FRotator compressed shorts].
   *  Used instead of a ClientMoveResponsePacked correction, which this client ignores. */
  private sendClientSetLocation(conn: UEConn, player: Player, loc: [number, number, number], yaw: number, why = "") {
    if (!this.conns.has(this.key(conn.addr))) return;
    this.sendPcRpc(conn, player, `ClientSetLocation(${why} ${loc.map(Math.round).join(",")})`, Number(process.env.LOKI_PC_SETLOC_IDX || 13), (p) => {
      p.bit(true); p.double(loc[0]); p.double(loc[1]); p.double(loc[2]);
      writeRotation(p, 0, yaw, 0, true);
    });
    const st = this.moveState.get(player.id);
    if (st) st.lastFixAt = Date.now();
    // Any server teleport (landing, respawn, rescue, unstick) re-arms the streaming grace: the
    // client may fall through terrain it has not streamed yet, which must not count as the abyss.
    player.abyssGraceUntil = Date.now() + Number(process.env.LOKI_ABYSS_GRACE_MS || 12000);
  }

  /** ULokiServerAuthConfig.GameFeatureToggles (TArray<bool>, handle 3) on the GameState's stably named
   *  component. Without it every ULokiGameFeatureToggles::Get logs "not ready" and the controller's
   *  TryUIReady keeps retrying behind the loading screen. The component's FName is not in the exe's
   *  plain strings, so each candidate name goes out in its own bunch: unknown names resolve to null and
   *  the client skips that content block. */
  private sendAuthConfig(conn: UEConn) {
    if (!this.conns.has(this.key(conn.addr))) return;
    const names = (process.env.LOKI_AUTHCFG_NAMES || "ServerAuthConfig").split(",").map((n) => n.trim()).filter(Boolean);
    // Retail values per mode, decoded from recorded retail match traffic:
    // Breach 93/149 on,
    // FFA 91/149 (differs in BotsKeepMatchesAlive 96 and HunterJourneyFeatureUnlock 118).
    const RETAIL_BREACH = "4,6,7,8,9,11,12,13,18,19,20,22,25,26,28,29,32,34,35,36,37,38,40,41,43,44,46,48,49,51,53,54,55,58,59,60,61,64,65,66,67,68,70,71,72,73,74,75,76,79,81,83,84,85,86,91,92,93,94,96,97,98,100,101,104,106,108,109,112,113,115,116,118,119,120,121,122,123,124,127,129,130,132,133,134,136,138,139,140,141,143,144,145";
    const retail = RETAIL_BREACH.split(",").map(Number);
    const ffa = process.env.LOKI_TOGGLES_SET ? process.env.LOKI_TOGGLES_SET === "ffa" : this.modeProfile ? this.modeProfile.toggles === "ffa" : /ffa|deathmatch|solo/i.test(this.gameStateClassName().cls + " " + this.currentGameMode);
    const on = new Set(process.env.LOKI_TOGGLES_ON ? process.env.LOKI_TOGGLES_ON.split(",").map(Number) : retail.filter((t) => !ffa || (t !== 96 && t !== 118)));
    // Armory family (ELokiGameFeatureToggle): 106 Armory, 116 GemsForArmory, 131 CustomsArmoryUnlock,
    // 140 ArmoryFuture. The client ships balance overrides and usables for both modes, tagged
    // EArmoryEnabledState Enabled/Disabled/Both on GameStateAttributeModifierComponent /
    // GameStateCurveTableOverrideComponent and EUsableArmory on LokiUsableAction, and picks between
    // them on this toggle — so "classic" (pre-Armory) is this switch, not new content.
    // LOKI_ARMORY=0|1 forces it for every match; otherwise the backend's ArmoryEnabled decides.
    const armoryOn = process.env.LOKI_ARMORY ? process.env.LOKI_ARMORY !== "0" : this.matchArmory !== false;
    if (!armoryOn) for (const t of [106, 116, 131, 140]) on.delete(t);
    for (const t of (process.env.LOKI_TOGGLES_OFF || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number)) on.delete(t);
    for (const t of (process.env.LOKI_TOGGLES_EXTRA_ON || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number)) on.add(t);
    const count = Number(process.env.LOKI_TOGGLES_COUNT || 149);
    const sendBlock = (name: string, guid: bigint, payload: BitWriter, withExport: boolean) => {
      this.sendBunch(conn, (w) => {
        w.bit(true);  // bHasRepLayout
        w.bit(false); // bIsActor -> sub-object follows
        writeNetGuid(w, guid);
        w.bit(true);  // bStablyNamed
        // Client ReadContentBlockHeader (decrypted at rva 0x3722ca8) reads one more bit after a set
        // bStablyNamed; 1 sends it down the dynamic/destroy path, 0 returns the stably named object.
        w.bit(false);
        w.packed32(payload.bits);
        w.bitsFrom(payload.buffer(), payload.bits);
      }, { ch: GAMESTATE_CH, reliable: process.env.LOKI_AUTHCFG_RELIABLE === "1", nameIndex: EChannelName.Actor,
           exports: withExport ? [{ guid, path: name, outer: GUID.GameStateActor, noLoad: true }] : undefined });
    };
    const payload = new BitWriter(1024);
    payload.bit(false); // bDoChecksum
    // ULokiGameFeatureToggles::Get needs the component's bHasBegunPlay (byte +0xb3 bit 6, set by
    // UActorComponent::BeginPlay at rva 0x359e4f2) and Num(GameFeatureToggles) > toggle.
    // Retail sends only handle 3 with every element present (on and off) — 1558-bit block in all captured flows.
    if (process.env.LOKI_AUTHCFG_FLAGS === "1") { payload.packed32(1); payload.bit(true); payload.packed32(2); payload.bit(true); }
    payload.packed32(3); // GameFeatureToggles
    payload.uint16(count);
    const sparse = process.env.LOKI_TOGGLES_SPARSE === "1";
    for (let t = 0; t < count; t++) if (!sparse || on.has(t)) { payload.packed32(t + 1); payload.bit(on.has(t)); }
    payload.packed32(0); // array terminator
    if (process.env.LOKI_AUTHCFG_BOGUS === "1") payload.packed32(77); // TEMP probe: client must reject handle 77 if it processes this block
    payload.packed32(0); // property terminator
    // One self-contained block (export + payload) per attempt, each under a fresh NetGUID: a path that
    // fails to resolve (GameState not spawned yet) is not retried by the client for the same GUID.
    const name = names[0]!;
    (process.env.LOKI_AUTHCFG_TRIES || "0,2000,5000,9000,15000").split(",").map(Number).forEach((delay, i) => {
      setTimeout(() => {
        if (!this.conns.has(this.key(conn.addr))) return;
        const guid = BigInt(process.env.LOKI_AUTHCFG_GUID || 0x7101) + BigInt(i) * 2n;
        sendBlock(name, guid, payload, true);
      }, delay);
    });
    this.log(`[ue] AuthConfig toggles -> ${this.key(conn.addr)} names=${names.join("|")} on=${on.size}/${count} armory=${armoryOn ? "on" : "off"}`);
  }

  /** One RPC on the owning PlayerController channel: field header = SerializeInt(index, fields+1) +
   *  packed payload bits + params (non-bool params carry a 1-bit "present" flag). */
  /** Retail kill feed: ALokiGameState::MulticastPlayerKilled (GS field 61, bound 63), reliable on the GameState channel to
   *  every connection, one Knocked then one Dead event per elimination (FFA sends the pair together; v22 capture). */
  private sendKillFeed(event: { killer: string; victim: string; assistants: string[]; weapon: string }) {
    const victim = this.players.get(event.victim); if (!victim) return;
    const killer = event.killer === "zone" ? undefined : this.players.get(event.killer);
    const assists = event.assistants.map((id) => this.players.get(id)?.psGuid).filter((g): g is bigint => g !== undefined);
    const teamWipe = victim.team >= 0 && ![...this.players.values()].some((p) => p !== victim && p.team === victim.team && p.alive);
    const abyss = event.weapon === "void" || event.weapon === "abyss" || victim.z < Number(process.env.LOKI_RESCUE_Z || -700);
    const max = Number(process.env.LOKI_GS_FIELD_MAX || 63);
    const build = (result: number, wipe: boolean) => {
      const p = Gas.encodeMulticastPlayerKilled({
        killer: killer?.actorGuid ?? 0n, killerPlayerState: killer?.psGuid ?? 0n,
        killerName: killer?.name || "Unknown", assists, victimPlayerState: victim.psGuid,
        location: [victim.x, victim.y, victim.z], eventResult: result,
        bIsTeamWipe: wipe, bDiedToAbyss: abyss,
      });
      const field = new BitWriter(1024);
      field.serializeIntVar(Gas.GS.MulticastPlayerKilled, max);
      field.packed32(p.bits);
      field.bitsFrom(p.buffer(), p.bits);
      return field;
    };
    const knocked = build(Gas.LivingState.Knocked, false), dead = build(Gas.LivingState.Dead, teamWipe);
    for (const conn of this.conns.values()) {
      if (conn.state !== "joined" || !conn.channels.has(GAMESTATE_CH)) continue;
      for (const f of [knocked, dead])
        this.sendBunch(conn, (w) => writeContentBlock(w, false, true, f.buffer(), f.bits), { ch: GAMESTATE_CH, reliable: true, nameIndex: EChannelName.Actor });
    }
    this.log(`[killfeed] ${killer?.name ?? "Unknown"} -> ${victim.name}${teamWipe ? " (team wipe)" : ""}${abyss ? " (abyss)" : ""}`);
  }

  private sendPcRpc(conn: UEConn, player: Player, name: string, idx: number, params: (w: BitWriter) => void,
    exports?: GuidExport[], mustBeMapped?: bigint[], quiet = false) {
    const max = Number(process.env.LOKI_PC_FIELD_MAX || 162);
    const p = new BitWriter(256);
    params(p);
    const field = new BitWriter(512);
    field.serializeIntVar(idx, max);
    field.packed32(p.bits);
    field.bitsFrom(p.buffer(), p.bits);
    this.sendBunch(conn, (w) => {
      writeContentBlock(w, false, true, field.buffer(), field.bits);
    }, { ch: player.channel, reliable: true, nameIndex: EChannelName.Actor, exports, mustBeMapped });
    if (!quiet) this.log(`[ue] ${name} -> ${player.id} idx=${idx} max=${max} bits=${field.bits}`);
  }

  /** One content-block property payload: packed handles + typed data, terminator 0.
   *  Handles must ascend (FRepLayout::ReceiveProperties walks cmds in order). */
  private propPayload(payload: BitWriter, entries: Array<[NetField | null, (w: BitWriter) => void]>) {
    const live = entries.filter((e): e is [NetField, (w: BitWriter) => void] => !!e[0]);
    live.sort((x, y) => x[0].h - y[0].h);
    payload.bit(false); // FRepLayout::ReceiveProperties: bDoChecksum (ENABLE_PROPERTY_CHECKSUMS)
    for (const [field, write] of live) {
      payload.packed32(field.h);
      write(payload);
    }
    payload.packed32(0);
  }

  private handleFor(className: string, fieldName: string): NetField | null {
    const field = this.layout.fieldOf(className, fieldName);
    if (!field) {
      if (!this.warnedHandles.has(`${className}.${fieldName}`)) {
        this.warnedHandles.add(`${className}.${fieldName}`);
        this.log(`[ue] no rep-layout handle for ${className}.${fieldName}; skipping`);
      }
      return null;
    }
    return field;
  }

  /** [field, writer] for a scalar/enum/string/name/object value using the field's own wire type. */
  private val(cls: string, name: string, value: unknown): [NetField | null, (w: BitWriter) => void] {
    const field = this.handleFor(cls, name);
    return [field, (w) => {
      if (!field) return;
      if (field.type === "object" || field.type === "class" || field.type === "weak_object") writeNetGuid(w, value as bigint);
      else if (field.type.startsWith("struct:PrimaryAssetType")) w.fname(String(value));
      else if (!writePropValue(w, field, value)) throw new Error(`no writer for ${cls}.${name} (${field.type})`);
    }];
  }

  private writeInitialProperties(w: BitWriter, player: Player, actor: bigint, owned = false) {
    const ENET_SIMULATED = 1, ENET_AUTONOMOUS = 2, ENET_AUTHORITY = 3;
    let entries: Array<[NetField | null, (w: BitWriter) => void]> | null = null;
    const hero = heroBlueprint(player.heroId);
    if (actor === player.actorGuid) {
      const C = SV_CLASS.hero;
      entries = [
        // Server RemoteRole becomes the client's Role: AutonomousProxy for the
        // connection's own hero, SimulatedProxy for everyone else's.
        this.val(C, "RemoteRole", owned ? ENET_AUTONOMOUS : ENET_SIMULATED),
        [this.handleFor(C, "ReplicatedMovement"), (p) => writeRepMovement(p, {
          location: [player.x, player.y, player.z],
          rotation: [0, player.yaw, 0],
          velocity: [player.vx, player.vy, player.vz],
          shortRotation: false,
        })],
        // Owner/Controller: the 0x3240 failure was the stray acceleration bit in writeRepMovement, not
        // these handles. LOKI_REP_HERO_OWNER=0 / LOKI_REP_HERO_CONTROLLER=0 turn them off.
        owned && process.env.LOKI_REP_HERO_OWNER !== "0" ? this.val(C, "Owner", player.pcGuid) : [null, () => {}],
        this.val(C, "Role", ENET_AUTHORITY),
        this.val(C, "PlayerState", player.psGuid),
        owned && process.env.LOKI_REP_HERO_CONTROLLER !== "0" ? this.val(C, "Controller", player.pcGuid) : [null, () => {}],
        // ReplicatedMovementMode (layout h32) made the real client read a float there (client log:
        // "AnimRootMotionTranslationScale corrupted", Handle=9) — client handle map differs past Controller(20).
        ...(process.env.LOKI_REP_MOVEMODE === "1" ? [this.val(C, "ReplicatedMovementMode", 1)] : []),
        ...(REP_LOKI_FIELDS ? [
          this.val(C, "bCharacterMovementEnabled", true),
        ] : []),
        // ALokiCharacter::LivingState: client native handle 64, 3-bit enum (Dead 0 / Alive 1 / Knocked 2), verified by the
        // engine-level wire test (LokiLivingStateLayoutTests.cpp). The client default is Dead, so without this every
        // hero — ours included — is dead: SPECTATING + "Join waiting room" and team rows DEAD (2026-11-25 05:42 UTC run).
        ...(process.env.LOKI_REP_LIVING !== "0" ? [livingStateEntry(player.alive ? 1 : 0)] : []),
        // CosmeticsAssetID (parent 47 -> handles 75/76): the ONLY thing that makes the client build the hero's body
        // (OnRep_CosmeticsAssetID -> LoadCosmetics -> CharacterMesh0); without it the hero is an invisible capsule.
        ...(REP_COSMETICS ? [
          rawField(75, "CosmeticsAssetID.PrimaryAssetType", (w) => w.fname("HeroCosmeticsBundle")),
          rawField(76, "CosmeticsAssetID.PrimaryAssetName", (w) => w.fname(skinBundle(player))),
        ] : []),
      ];
    } else if (actor === player.psGuid) {
      const C = SV_CLASS.playerState;
      const ordinal = Number((player.psGuid - 0x2000n) / 0x10n);
      entries = [
        this.val(C, "Score", player.score),
        this.val(C, "PlayerId", 256 + ordinal),
        this.val(C, "CompressedPing", 0),
        this.val(C, "bIsABot", player.isBot),
        this.val(C, "StartTime", 0),
        this.val(C, "PlayerNamePrivate", player.name),
      ];
      if (REP_PS_LOKI) entries.push(
        this.val(C, "ParticipantMatchStartDetails.ID", player.id),
        this.val(C, "ParticipantMatchStartDetails.TeamID", BigInt(player.team)),
        this.val(C, "ParticipantMatchStartDetails.DisplayName", player.name),
        this.val(C, "ParticipantMatchStartDetails.HeroAssetID.PrimaryAssetType", "Hero"),
        this.val(C, "ParticipantMatchStartDetails.HeroAssetID.PrimaryAssetName", hero.id.toLowerCase()), // "Hero:firefox"
        this.val(C, "ReplicatedTeamIndex", player.team),
        this.val(C, "BattleRoyalePlayerPhase", Number(process.env.LOKI_PS_BRPHASE || 1)), // 1 Pregame, 2 Dropping, 3 Combat
      );
    } else if (actor === player.pcGuid) {
      const C = SV_CLASS.playerController;
      entries = [
        this.val(C, "RemoteRole", ENET_AUTONOMOUS),
        this.val(C, "Role", ENET_AUTHORITY),
        this.val(C, "PlayerState", player.psGuid),
        this.val(C, "Pawn", player.actorGuid),
      ];
    } else if (actor === GUID.GameStateActor) {
      entries = this.gameStateProps(true);
    }
    if (!entries) return;
    const kind = actor === player.actorGuid ? "hero" : actor === player.psGuid ? "ps" : actor === player.pcGuid ? "pc" : "gs";
    if (REP_EMPTY.has(kind)) entries = [];
    const probe = REP_PROBE[kind];
    if (probe) {
      // Probe mode: raw handle/value pairs, used to read the real client's handle map
      // back out of its "corrupted serialization of <Property>" errors.
      const payload = new BitWriter(256);
      payload.bit(false); // bDoChecksum
      for (const [h, t, v] of probe) {
        payload.packed32(h);
        if (t === "bool") payload.bit(v !== 0);
        else if (t === "zeros") payload.bitsFrom(new Uint8Array(Math.ceil(v / 8)), v);
        else if (t === "ones") payload.bitsFrom(new Uint8Array(Math.ceil(v / 8)).fill(0xff), v);
        else if (t === "int32") payload.int32(v);
        else if (t === "double") payload.double(v);
      }
      if (!probe.noTerm) payload.packed32(0);
      this.log(`[ue] probe ${kind} bits=${payload.bits} ${JSON.stringify(probe)}`);
      writeContentBlock(w, true, true, payload.buffer(), payload.bits);
      return;
    }
    const payload = new BitWriter(1024);
    this.propPayload(payload, entries);
    writeContentBlock(w, true, true, payload.buffer(), payload.bits);
  }

  /** GameState replicated state (exact SUPERVIVE handles: GameStateBase 18-21, LokiGameState 22+). */
  private gameStateProps(initial = false): Array<[NetField | null, (w: BitWriter) => void]> {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const worldSeconds = elapsed + 1000;
    const C = SV_CLASS.gameState;
    const time = this.val(C, "ReplicatedWorldTimeSecondsDouble", this.worldTime());
    if (!initial) return REP_GS_TIME ? [time] : [];
    // OnRep_ReplicatedHasBegunPlay -> WorldSettings::NotifyBeginPlay on the client.
    const base: Array<[NetField | null, (w: BitWriter) => void]> = [this.val(C, "bReplicatedHasBegunPlay", true), ...(REP_GS_TIME ? [time] : [])];
    if (!REP_GS_LOKI) return base;
    const teams = new Set([...this.players.values()].map((p) => p.team));
    return [
      ...base,
      this.val(C, "ReplicatedNumRemainingPlayers", this.match.all().filter((c) => c.alive).length || this.players.size),
      this.val(C, "GameStartWorldTime", worldSeconds - elapsed),
      this.val(C, "MatchStartDetails.MatchID", this.currentMatchId || "local"),
      this.val(C, "NumTeams", Math.max(1, teams.size)),
      ...(REP_TEAMS ? [this.objArray(C, "TeamStates", this.teamIndices().map(teamGuid))] : []),
      this.val(C, "CurrentPhase", Number(process.env.LOKI_GS_PHASE || (this.modeProfile && !this.dropEnabled() ? this.modeProfile.initialPhase ?? 7 : 4))), // ERoundPhase: 4 SpawnSelect, 7 Combat
      ...this.modeGsProps(),
    ];
  }

  private parseClientMovement(player: Player, bunch: Bunch) {
    if (this.gasEnabled) {
      for (const rpc of detectRpcCalls(bunch.data, bunch.bits, this.gasRpc, this.config.rules.abilities.length)) {
        if (rpc.kind === "activate") {
          const abilityId = abilityIdForSpec(this.config.rules, rpc.specIndex);
          const result = this.match.requestAbility(player.id, abilityId);
          this.log(`[gas] activate ${player.id} ${abilityId} ${result.ok ? "ok" : result.reason || ""}`);
        }
      }
    }
    // Movement now comes from ServerMovePacked (onHeroBunch); the property-style parse below is the
    // pre-capture guess and misreads RPC fields.
    if (process.env.LOKI_LEGACY_MOVE !== "1") return;
    const r = new BitReader(bunch.data, bunch.bits);
    let moves = 0;
    while (r.bitsLeft > 16) {
      try {
        const hasRepLayout = r.bit();
        const isActor = r.bit();
        if (!hasRepLayout) break;
        if (!isActor) break;
        const payloadBits = r.packed32();
        if (payloadBits <= 0 || payloadBits > r.bitsLeft) break;
        const payload = new BitReader(r.bitsFrom(payloadBits), payloadBits);
        if (payload.bitsLeft < 8) break;
        payload.bit(); // bDoChecksum
        let handle = payload.packed32();
        let guard = 0;
        while (handle !== 0 && payload.bitsLeft > 0 && guard++ < 64) {
          if (handle === this.layout.handle("Character", "ReplicatedMovement")) {
            const move = this.readRepMovement(payload);
            if (move) {
              player.x = move.x; player.y = move.y; player.z = move.z;
              player.vx = move.vx; player.vy = move.vy; player.vz = move.vz;
              player.yaw = move.yaw; player.pitch = move.pitch;
              player.lastMoveMs = Date.now();
              moves++;
            }
          } else if (handle === this.layout.handle("Character", "ServerMovePacked")) {
            player.lastMoveMs = Date.now();
            moves++;
          }
          if (payload.bitsLeft < 1) break;
          handle = payload.packed32();
        }
      } catch {
        break;
      }
    }
    if (moves) {
      const speed = Math.hypot(player.vx, player.vy);
      const moveSpeed = this.config.rules.moveSpeed * this.config.rules.sprintMultiplier;
      const rad = (player.yaw * Math.PI) / 180;
      const fx = Math.cos(rad), fy = Math.sin(rad);
      const forward = speed > 1 ? (player.vx * fx + player.vy * fy) / moveSpeed : 0;
      const right = speed > 1 ? (-player.vx * fy + player.vy * fx) / moveSpeed : 0;
      this.match.setInput(player.id, {
        mx: Math.max(-1, Math.min(1, right)),
        my: Math.max(-1, Math.min(1, forward)),
        yaw: player.yaw, pitch: player.pitch,
      });
      this.log(`[ue] move ${player.id} -> (${Math.round(player.x)},${Math.round(player.y)},${Math.round(player.z)}) yaw=${Math.round(player.yaw)}`);
    }
  }

  private readQuantizedVector(r: BitReader, scale: number): [number, number, number] | null {
    const header = r.serializeInt(128);
    const n = header & 0x3f;
    const isScaled = !!(header & 0x40);
    if (n === 0) {
      if (isScaled) return [r.double(), r.double(), r.double()];
      return [r.float(), r.float(), r.float()];
    }
    if (n > 63 || n * 3 > r.bitsLeft) return null;
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const raw = r.bitsFrom(n);
      let value = 0n;
      for (let j = 0; j < n; j++) {
        if ((raw[j >> 3]! >> (j & 7)) & 1) value |= 1n << BigInt(j);
      }
      if (value & (1n << BigInt(n - 1))) value -= 1n << BigInt(n);
      out.push(Number(value) / (isScaled ? scale : 1));
    }
    return out as [number, number, number];
  }

  private readRotation(r: BitReader, short: boolean): [number, number, number] | null {
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (short) {
        if (!r.bit()) { out.push(0); continue; }
        out.push((r.uint16() * 360) / 65536);
      } else {
        if (!r.bit()) { out.push(0); continue; }
        out.push((r.uint8() * 360) / 256);
      }
    }
    return out as [number, number, number];
  }

  private readRepMovement(r: BitReader) {
    if (r.bitsLeft < 4) return null;
    const flags = Number(r.bitsFrom(4)[0]! & 0xf);
    const hasFrame = !!(flags & 4);
    const hasHandle = !!(flags & 8);
    const loc = this.readQuantizedVector(r, 100);
    if (!loc) return null;
    const rot = this.readRotation(r, false) || this.readRotation(r, true);
    if (!rot) return null;
    const vel = this.readQuantizedVector(r, 1);
    if (!vel) return null;
    if (flags & 2) this.readQuantizedVector(r, 1); // angular velocity
    if (hasFrame) r.packed32();
    if (hasHandle) r.packed32();
    if (this.options.engineNetVersion >= 35 && r.bit()) this.readQuantizedVector(r, 1);
    return { x: loc[0], y: loc[1], z: loc[2], vx: vel[0], vy: vel[1], vz: vel[2], yaw: rot[1], pitch: rot[0] };
  }

  private tick() {
    this.tickHandshakeSecrets();
    const now = Date.now();
    const dt = Math.min(0.25, Math.max(0, now - this.lastTickMs) / 1000);
    this.lastTickMs = now;
    if (dt > 0) {
      this.match.tick(dt);
      this.syncMatchState();
      this.capture?.tick(); // [capture] hook
      this.interact?.tick(); // [armory] hook: push purse changes (kill gold, loot) to each owner's wallet
    }
    for (const [key, conn] of this.conns) {
      this.drainOut(conn);
      if (now - conn.lastSeenMs > CONN_TIMEOUT_MS) { this.log(`[ue] timeout ${this.key(conn.addr)}`); this.dropConnection(conn); continue; }
      for (const [seq, packets] of Array.from(conn.sentPackets)) {
        if (now - packets.at <= RESEND_MS) continue;
        conn.sentPackets.delete(seq);
        this.resendBunches(conn, packets.bunches, packets.createdAt);
      }
      if (conn.state === "joined") {
        if (COALESCE) this.beginBatch(conn);
        this.drainRetail(conn);
        if (this.inflight(conn) < SEND_WINDOW) { this.replicateWorld(conn); this.replicatePlane(conn); this.replicateZone(conn); }
        if (conn.batch && conn.batch.count > 0) this.flushBatch(conn);
        else { conn.batch = null; this.sendKeepalive(conn); }
      }
    }
  }

  private replicateWorld(conn: UEConn) {
    if (REP_NONE) return;
    const nowSeconds = (Date.now() - this.startTime) / 1000;
    for (const player of this.players.values()) {
      if (player.channel + 1 === 0 || !player.spawned || !conn.channels.has(player.channel + 1)) continue;
      // The owner's hero is an autonomous proxy: real servers never send it ReplicatedMovement.
      if (player.connKey === this.key(conn.addr)) continue;
      const payload = new BitWriter(512);
      payload.bit(false); // bDoChecksum
      const rm = this.handleFor("Character", "ReplicatedMovement");
      if (rm) {
        payload.packed32(rm.h);
        writeRepMovement(payload, {
          location: [player.x, player.y, player.z],
          rotation: [0, player.yaw, 0],
          velocity: [player.vx, player.vy, player.vz],
          shortRotation: false,
        });
      }
      // Retail sends every simulated hero's movement with h29 ReplicatedServerLastTransformUpdateTimeStamp (float server time,
      // 32,060 of 41,543 remote-hero updates in flow 7038 are exactly [12][29][0]) — the client's proxy smoothing reads it.
      if (REP_SIM_TS) { payload.packed32(29); payload.float(nowSeconds); }
      // h31 ReplicatedMovementMode (uint8, retail values 1 Walking / 3 Falling / custom), sent on change like retail.
      const mode = player.moveMode ?? 1;
      // Sent on change (retail) plus every ~3 s, since this rides unreliable bunches and a lost change would stick.
      const modeKey = mode * 1e6 + Math.floor(nowSeconds / 3);
      if (REP_SIM_MOVEMODE && conn.sentMoveMode.get(player.id) !== modeKey) { payload.packed32(31); payload.uint8(mode); conn.sentMoveMode.set(player.id, modeKey); }
      payload.packed32(0);
      this.sendBunch(conn, (w) => {
        writeContentBlock(w, true, true, payload.buffer(), payload.bits);
      }, { ch: player.channel + 1, reliable: false, nameIndex: EChannelName.Actor });
    }
    // GameState channel: push elapsed/world-time/match-state once per second.
    const elapsed = Math.floor(nowSeconds);
    if (REP_GS_TIME && !REP_EMPTY.has("gs") && conn.channels.has(GAMESTATE_CH) && elapsed !== this.lastGameStateElapsed) {
      const payload = new BitWriter(256);
      this.propPayload(payload, this.gameStateProps(false));
      this.sendBunch(conn, (w) => {
        writeContentBlock(w, true, true, payload.buffer(), payload.bits);
      }, { ch: GAMESTATE_CH, reliable: false, nameIndex: EChannelName.Actor });
      this.lastGameStateElapsed = elapsed;
    }
  }

  private lastGameStateElapsed = -1;

  private retail: RetailWorld | null | undefined;

  /** Picks the retail capture for this map/mode once per match and pins the GUIDs of every path both sides
   *  export (level chain, script packages, GameState/PlayerState/PlayerController archetypes) to retail's. */
  private ensureRetailWorld() {
    if (this.retail !== undefined) return;
    Object.assign(GUID, SHIFTED_GUID);
    const gs = this.gameStateClassName();
    this.retail = RETAIL_WORLD ? pickRetailWorld(this.currentMap, gs.cls) : null;
    if (!this.retail) return;
    const map = this.currentMap, short = map.split("/").pop()!;
    const g = (p: string) => this.retail!.guidByPath.get(p);
    const pins: Array<[keyof typeof GUID, string]> = [
      ["LevelPackage", map], ["World", `${map}.${short}`], ["Level", `${map}.${short}.PersistentLevel`],
      ["EnginePackage", "/Script/Engine"], ["GamePackage", "/Script/Loki"],
      ["GameStateBPPackage", gs.pkg], ["GameStateClass", `${gs.pkg}.Default__${gs.cls}`],
      ["PlayerStateBPPackage", this.playerStateBp().pkg], ["PlayerStateClass", `${this.playerStateBp().pkg}.Default__${this.playerStateBp().cls}`],
      ["PlayerControllerBPPackage", PLAYER_CONTROLLER_BP.pkg], ["PlayerControllerClass", `${PLAYER_CONTROLLER_BP.pkg}.Default__${PLAYER_CONTROLLER_BP.cls}`],
    ];
    const pinned: string[] = [];
    for (const [k, path] of pins) { const v = g(path); if (v !== undefined) { (GUID as any)[k] = v; pinned.push(`${k}=${v}`); } }
    this.log(`[ue] retail world ${this.retail.name}: ${this.retail.bunches.length} bunches on ${this.retail.channelMap.size} channels, pinned ${pinned.join(" ")}`);
  }

  private drainRetail(conn: UEConn) {
    const q = conn.retailQueue;
    if (!q || !this.retail) return;
    let budget = Number(process.env.LOKI_RETAIL_RATE || 24);
    while (q.length && budget > 0 && this.inflight(conn) < SEND_WINDOW) budget -= this.sendRetailBunch(conn, q.shift()!);
    if (!q.length) { conn.retailQueue = null; this.log(`[ue] retail world sent -> ${this.key(conn.addr)}`); }
  }

  /** One retail logical bunch, split exactly like UE SendBunch: export-only partials first, then data
   *  partials (byte-aligned except the last). bOpen rides the first piece, bClose the last, must-be-mapped
   *  the first data piece. Returns the number of raw bunches sent. */
  private sendRetailBunch(conn: UEConn, b: RetailBunch): number {
    const ch = this.retail!.channelMap.get(b.ch)!;
    if (b.open) conn.channels.add(ch);
    const fresh = b.exports.filter((e) => !conn.exportedGuids.has(e.guid));
    for (const e of fresh) conn.exportedGuids.add(e.guid);
    const pieces: Array<{ exp: boolean; must: boolean; data: Uint8Array; bits: number }> = [];
    for (const s of exportSections(fresh, RETAIL_PIECE_BITS)) pieces.push({ exp: true, must: false, ...s });
    const body = bunchData(b);
    if (pieces.length === 1 && pieces[0]!.bits + body.bits <= RETAIL_PIECE_BITS) {
      const w = new BitWriter(pieces[0]!.bits + body.bits + 8);
      w.bitsFrom(pieces[0]!.data, pieces[0]!.bits); w.bitsFrom(body.data, body.bits);
      pieces[0] = { exp: true, must: b.must.length > 0, data: w.buffer(), bits: w.bits };
    } else {
      for (let off = 0, first = true; off < body.bits || first; first = false) {
        const n = Math.min(RETAIL_PIECE_BITS, body.bits - off);
        pieces.push({ exp: false, must: first && b.must.length > 0, data: sliceBits(body.data, off, n), bits: n });
        off += n;
        if (n <= 0) break;
      }
    }
    const partial = pieces.length > 1;
    pieces.forEach((pc, i) => {
      const w = this.beginPacket(conn);
      const bunch = newBunch();
      bunch.chIndex = ch;
      bunch.bOpen = b.open && i === 0;
      bunch.bClose = b.close && i === pieces.length - 1;
      bunch.closeReason = DESTROYED;
      bunch.bReliable = b.rel;
      bunch.chNameIndex = EChannelName.Actor;
      bunch.bHasPackageMapExports = pc.exp;
      bunch.bHasMustBeMappedGUIDs = pc.must;
      bunch.bPartial = partial;
      bunch.bPartialInitial = partial && i === 0;
      bunch.bPartialFinal = partial && i === pieces.length - 1;
      if (bunch.bReliable) bunch.chSequence = conn.nextReliable(ch);
      bunch.data = pc.data; bunch.bits = pc.bits;
      if (conn.batch) { this.batchBunch(conn, bunch); return; }
      writeBunch(bunch, w, conn.wire === "real");
      this.endPacket(conn, w, bunch.bReliable ? [bunch] : undefined);
    });
    return pieces.length;
  }
}

export function startUEGameServer(opts: UEServerOptions = {}) {
  const server = new UEGameServer(opts);
  void server.start();
  return server;
}

if (import.meta.main) {
  const server = startUEGameServer();
  // Deregister on shutdown: a restarted instance gets a new serverId, and the stale
  // registration would otherwise stay "ready" and swallow the next allocation.
  const bye = async () => {
    const o = (server as any).options;
    if (o?.register) {
      await Promise.race([
        fetch(`${o.backendUrl}/api/ds/servers/${encodeURIComponent((server as any).serverId)}`, { method: "DELETE" }).catch(() => {}),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
    process.exit(0);
  };
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
}

/** RPC fields of a subobject block sent by the client (content block: rep 0, actor 0, guid, then
 *  `extraBits` header bits UE may or may not write client-side, then packed payload bits). */
function readSubobjectRpc(data: Uint8Array, bits: number, fieldMax: number, extraBits: number) {
  try {
    const r = new BitReader(data, bits);
    const out: Array<{ idx: number; bits: number; data: Uint8Array }> = [];
    while (r.bitsLeft > 3) {
      const rep = r.bit(); const act = r.bit();
      if (rep) return null;
      if (!act) { r.packed64(); for (let i = 0; i < extraBits; i++) r.bit(); }
      const nb = r.packed32();
      if (nb > r.bitsLeft) return null;
      const p = new BitReader(r.bitsFrom(nb), nb);
      if (act) continue;
      while (p.bitsLeft > 0) {
        const idx = p.serializeIntVar(fieldMax);
        const n = p.packed32();
        if (n > p.bitsLeft || idx < 2 || idx >= fieldMax) return null;
        out.push({ idx, bits: n, data: p.bitsFrom(n) });
      }
    }
    return out.length ? out : null;
  } catch { return null; }
}
