import { readFileSync } from "node:fs";

/**
 * Mode tables for the clean-room Loki match server, all paths verified against
 * the real 2.0.4 AssetRegistry (data/204/all-packages-204.txt, 103,841 assets
 * dumped via `LokiParse allpkgs` from the non-zero .ucas payloads):
 *  - data/204/usmap-enums-204.json   (ELokiGameModeType, ERoundPhase, ...)
 *  - data/204/all-packages-204.txt   (per-mode GameState/GameMode BP classes)
 *  - data/204/catalog-204.json       (real map asset paths, 116 maps)
 *
 * Enum values are verified at load: if the usmap ever changes, fail fast
 * instead of sending a wrong wire value.
 */

interface UsmapEnums { enums: Record<string, Record<string, number>> }

export interface ModeInfo {
  /** ELokiGameModeType wire value. */
  gameModeType: number;
  /** Welcome-map fallback when no DS allocation carries an explicit MapName. */
  mapName: string;
  /** Real per-mode GameState class (asset-relative name + package path). */
  gameState: { cls: string; pkg: string };
  /** Real per-mode GameMode class (client-visible GameState.GameModeClass ref). */
  gameModeClass: { cls: string; pkg: string };
}

const file = JSON.parse(
  readFileSync(new URL("./data/usmap-enums-204.json", import.meta.url).pathname, "utf8"),
) as UsmapEnums;

export const ELOKI_GAME_MODE_TYPE = file.enums.ELokiGameModeType;
export const E_ROUND_PHASE = file.enums.ERoundPhase;
if (!ELOKI_GAME_MODE_TYPE || ELOKI_GAME_MODE_TYPE.BattleRoyale !== 1 || ELOKI_GAME_MODE_TYPE.Domination !== 5) {
  throw new Error("usmap-enums-204.json: ELokiGameModeType values changed — regenerate from the 2.0.4 usmap");
}
if (!E_ROUND_PHASE || E_ROUND_PHASE.EGP_Combat !== 7 || E_ROUND_PHASE.EGP_SpawnSelect !== 4) {
  throw new Error("usmap-enums-204.json: ERoundPhase values changed — regenerate from the 2.0.4 usmap");
}

const T = ELOKI_GAME_MODE_TYPE;
const GM_ROOT = "/Game/Loki/Core/GameModes";

// pkg is the asset package (folder + asset name), not the folder: the client loads
// `${pkg}` and finds `${cls}` / `Default__${cls}` inside it.
const gs = (cls: string, dir: string) => ({ cls: `${cls}_C`, pkg: `${dir}/${cls}` });
const gm = (cls: string, dir: string) => ({ cls: `${cls}_C`, pkg: `${dir}/${cls}` });

const BREACH_GS = gs("BP_LokiBattleRoyaleGameState_Breach", GM_ROOT);
const BREACH_GM = gm("BP_LokiBattleRoyaleGameMode_Skylands_Breach", GM_ROOT);
const SOLOS_GS = gs("BP_LokiBattleRoyaleGameState_Solos", GM_ROOT);
const SOLOS_GM = gm("BP_LokiBattleRoyaleGameMode_Skylands_Solos", GM_ROOT);
const DUOS_GM = gm("BP_LokiBattleRoyaleGameMode_Skylands_Duos", GM_ROOT);
const OLDBR_GS = gs("BP_LokiBattleRoyaleGameState_OldBR", GM_ROOT);
const OLDBR_GM = gm("BP_LokiBattleRoyaleGameMode_Skylands_OldBR", GM_ROOT);
const BR_BASE_GS = gs("BP_LokiBattleRoyaleGameState", GM_ROOT);
const BR_BASE_GM = gm("BP_LokiBattleRoyaleGameMode_Skylands", GM_ROOT);
const LASTMAN_GS = gs("BP_LokiGameStateLastMan", GM_ROOT);
const LASTMAN_GM = gm("BP_LokiGameModeLastMan", GM_ROOT);
const BATTLEFIELD_GS = gs("BP_LokiGameState_Battlefield", `${GM_ROOT}/Battlefield`);
const BATTLEFIELD_GM = gm("BP_LokiGameMode_Battlefield", `${GM_ROOT}/Battlefield`);
const DOMINATION_GS = gs("BP_DominationGameState", `${GM_ROOT}/Domination`);
const DOMINATION_GM = gm("BP_DominationGameMode", `${GM_ROOT}/Domination`);
const TOURNAMENT_GS = gs("BP_TournamentGameState", `${GM_ROOT}/Tournament`);
const TOURNAMENT_GM = gm("BP_LokiGameMode_Tournament", `${GM_ROOT}/Tournament`);
const PRISMA_GS = gs("BP_PrismaBankGameState", `${GM_ROOT}/PrismaBank`);
const PRISMA_GM = gm("BP_PrismaBankGameMode", `${GM_ROOT}/PrismaBank`);
const BARRACUDA_GS = gs("BP_GameState_Barracuda", `${GM_ROOT}/Barracuda`);
const BARRACUDA_GM = gm("BP_GameMode_Barracuda", `${GM_ROOT}/Barracuda`);
const SWORDFISH_GS = gs("BP_GameState_Barracuda_Swordfish", `${GM_ROOT}/Barracuda`);
const SWORDFISH_GM = gm("BP_GameMode_Barracuda_Swordfish", `${GM_ROOT}/Barracuda`);
const SOCCER_GS = gs("BP_SoccerviveGameState", `${GM_ROOT}/Soccervive`);
const SOCCER_GM = gm("BP_LokiGameMode_Soccervive", `${GM_ROOT}/Soccervive`);
const TUGOFWAR_GS = gs("BP_TugOfWarGameState", `${GM_ROOT}/TugOfWar`);
const TUGOFWAR_GM = gm("BP_TugOfWarGameMode", `${GM_ROOT}/TugOfWar`);
const FFA_GS = gs("BP_LokiGameState_FFA", `${GM_ROOT}/FFA`);
const FFA_GM = gm("BP_FFAGameMode", `${GM_ROOT}/FFA`);
const HOLDOUT_GS = gs("BP_LokiGameState_PvE_Holdout", GM_ROOT);
const HOLDOUT_GM = gm("BP_LokiGameMode_PvE_Holdout", GM_ROOT);
const TURBO_GS = gs("BP_LokiBattleRoyaleGameState_TurboBR", `${GM_ROOT}/TurboBR`);
const TURBO_GM = gm("BP_LokiBattleRoyaleGameMode_Skylands_TurboBR", `${GM_ROOT}/TurboBR`);
const ROUNDS_GS = gs("BP_LokiGameStateRounds", GM_ROOT);
const TRAINING_GS = gs("BP_PracticeGameState_Training", GM_ROOT);
const TUTORIAL_GS = gs("BP_LokiGameState_Tutorial", GM_ROOT);

export const MODE_TABLE: Record<string, ModeInfo> = {
  breach: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: BREACH_GS, gameModeClass: BREACH_GM },
  battle_royale: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: BREACH_GS, gameModeClass: BREACH_GM },
  oldbr: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/Battlefield/LVL_Battlefield", gameState: OLDBR_GS, gameModeClass: OLDBR_GM },
  solos: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: SOLOS_GS, gameModeClass: SOLOS_GM },
  duos: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: BR_BASE_GS, gameModeClass: DUOS_GM },
  trios: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: BR_BASE_GS, gameModeClass: BR_BASE_GM },
  arena: { gameModeType: T.LastMan, mapName: "/Game/Loki/Maps/LVL_Lastman/LVL_Lastman", gameState: LASTMAN_GS, gameModeClass: LASTMAN_GM },
  deathmatch: { gameModeType: T.LastMan, mapName: "/Game/Loki/Maps/LVL_Lastman/LVL_Lastman", gameState: LASTMAN_GS, gameModeClass: LASTMAN_GM },
  ffa: { gameModeType: T.LastMan, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: FFA_GS, gameModeClass: FFA_GM },
  domination: { gameModeType: T.Domination, mapName: "/Game/Loki/Maps/Domination/LVL_Domination", gameState: DOMINATION_GS, gameModeClass: DOMINATION_GM },
  rounds: { gameModeType: T.Domination, mapName: "/Game/Loki/Maps/TugOfWar/LVL_TugOfWar", gameState: ROUNDS_GS, gameModeClass: DOMINATION_GM },
  tournament: { gameModeType: T.Tournament, mapName: "/Game/Loki/Maps/Bracket/LVL_Bracket_01", gameState: TOURNAMENT_GS, gameModeClass: TOURNAMENT_GM },
  prisma_bank: { gameModeType: T.PrismaBank, mapName: "/Game/Loki/Maps/PrismaBank/LVL_PrismaBank_01", gameState: PRISMA_GS, gameModeClass: PRISMA_GM },
  barracuda: { gameModeType: T.Barracuda, mapName: "/Game/Loki/Maps/BeastHaven/LVL_BeastHaven", gameState: BARRACUDA_GS, gameModeClass: BARRACUDA_GM },
  swordfish: { gameModeType: T.Barracuda, mapName: "/Game/Loki/Maps/BeastHaven/LVL_BeastHaven", gameState: SWORDFISH_GS, gameModeClass: SWORDFISH_GM },
  soccervive: { gameModeType: T.LastMan, mapName: "/Game/Loki/Maps/GrindBall/LVL_GrindBallArena_01", gameState: SOCCER_GS, gameModeClass: SOCCER_GM },
  tugofwar: { gameModeType: T.LastMan, mapName: "/Game/Loki/Maps/TugOfWar/LVL_TugOfWar", gameState: TUGOFWAR_GS, gameModeClass: TUGOFWAR_GM },
  holdout: { gameModeType: T.None, mapName: "/Game/Loki/Maps/Holdout/LVL_Holdout", gameState: HOLDOUT_GS, gameModeClass: HOLDOUT_GM },
  turbobr: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", gameState: TURBO_GS, gameModeClass: TURBO_GM },
  battlefield: { gameModeType: T.BattleRoyale, mapName: "/Game/Loki/Maps/Battlefield/LVL_Battlefield", gameState: BATTLEFIELD_GS, gameModeClass: BATTLEFIELD_GM },
  training: { gameModeType: T.None, mapName: "/Game/Loki/Maps/Training/LVL_Training", gameState: TRAINING_GS, gameModeClass: gm("BP_GameMode_BasicTraining", GM_ROOT) },
  tutorial: { gameModeType: T.None, mapName: "/Game/Loki/Maps/Tutorial/LVL_Tutorial", gameState: TUTORIAL_GS, gameModeClass: gm("BP_LokiGameMode_Tutorial", GM_ROOT) },
};

/** Queue-name families (substring → MODE_TABLE family). Order matters. */
const FAMILY_HINTS: Array<[RegExp, keyof typeof MODE_TABLE]> = [
  [/swordfish/, "swordfish"],
  [/barracuda|beasthaven/, "barracuda"],
  [/turbobr|turbo_?br/, "turbobr"],
  [/oldbr|old_?br/, "oldbr"],
  [/solos/, "solos"],
  [/duos/, "duos"],
  [/trios/, "trios"],
  [/domination/, "domination"],
  [/tournament|bracket/, "tournament"],
  [/prisma_?bank|prismaparty/, "prisma_bank"],
  [/grindball|soccervive|soccervive/, "soccervive"],
  [/tugofwar|tug_?of_?war/, "tugofwar"],
  [/holdout/, "holdout"],
  [/dropin|warm_?up/, "ffa"], // retail warm-up = FFA on the Breach island (recorded retail match traffic flow 7027)
  [/ffa|deathmatch|\bdm\b/, "ffa"],
  // catalog GameMode "FreeForAll" (dropin / brdm / solodm queues); off with LOKI_MODES=0 (then those fall to breach as before)
  ...(process.env.LOKI_MODES === "0" ? [] : [[/free_?for_?all/, "ffa"]] as Array<[RegExp, keyof typeof MODE_TABLE]>),
  [/arena|lastman|last_man/, "arena"],
  [/breach|default/, "breach"],
  [/battlefield/, "battlefield"],
  [/training|practice/, "training"],
  [/tutorial/, "tutorial"],
];

/** MODE_TABLE family key for an allocation (same hint order as resolveMode); "" when nothing matched. */
export function resolveModeKey(gameMode: string, mapName: string): string {
  const haystack = `${gameMode} ${mapName}`.toLowerCase();
  for (const [re, family] of FAMILY_HINTS) if (re.test(haystack)) return family;
  return "";
}

/** Resolves the real 2.0.4 mode info from the allocated GameMode/MapName.
 *  Unmatched modes fall back to the native LokiGameState with type None(0). */
export function resolveMode(gameMode: string, mapName: string): ModeInfo {
  const haystack = `${gameMode} ${mapName}`.toLowerCase();
  for (const [re, family] of FAMILY_HINTS) {
    if (re.test(haystack)) return MODE_TABLE[family];
  }
  return {
    gameModeType: T.None,
    mapName: "/Game/Loki/Maps/Battlefield/LVL_Battlefield",
    gameState: { cls: "LokiGameState", pkg: "/Script/Loki" },
    gameModeClass: { cls: "LokiGameMode", pkg: "/Script/Loki" },
  };
}

// ---------------------------------------------------------------------------------------------
// Per-mode match profiles (2026-11-25). Breach / trios / battle_royale / oldbr have NO profile, so
// the Breach battle royale path is byte-for-byte what it was. Every profile carries an evidence grade:
//   "retail"  = backed by recorded retail match traffic flows (only FFA: flows 7027/7547/7912) or the reference's
//               retail-pcap-derived notes
//   "asset"   = class/map paths verified in data/204/all-packages-204.txt + usmap, rules guessed
//   "guess"   = rule numbers are ours (no cooked CDO values: the BP defaults are in .uasset payloads
//               we cannot export yet, see AGENTS.md lane 2)
// Kill switch: LOKI_MODES=0 → no profile applies anywhere (pre-2026-11-25 behaviour).

import type { MatchRules } from "./match.ts";

export interface ModeProfile {
  key: string;
  evidence: "retail" | "asset" | "guess";
  /** MatchWorld rule overrides (server/ue/match.ts). */
  rules: Partial<MatchRules>;
  /** run the Breach drop plane (only meaningful on LVL_SkylandsBreach). */
  drop: boolean;
  /** Breach map extras (trains). Loot stays map-gated in server.ts. */
  trains: boolean;
  /** GameState MaxPlayersPerTeam (retail FFA = 1, Breach = 3 — Breach never gets this). */
  maxPlayersPerTeam?: number;
  /** GameState TeamScoreToWin (LokiRoundGameMode.TeamScoreToWin). */
  teamScoreToWin?: number;
  /** ServerAuthConfig toggle set (retail sets exist only for breach / ffa). */
  toggles: "breach" | "ffa";
  /** spawn archetype overrides (asset paths); unset = BP_LokiPlayerState / BP_LokiGameHUD. */
  playerState?: { pkg: string; cls: string };
  hud?: string;
  /** GameState CurrentPhase at the open when there is no drop (retail FFA flow 7027 opens at 7 = EGP_Combat). */
  initialPhase?: number;
  notes: string;
}

const NO_ZONE = { enabled: false } as MatchRules["zone"];
const ARENA_BOTS = { botGraceMs: 10_000, botAggroSpreadMs: 20_000, botVsBotDamageScale: 0.5, botVsHumanDamageScale: 0.25 };
/** round modes: 5 s countdown each round and slower bot-vs-bot trades so rounds last ~1 min (numbers ours) */
const ROUND_BOTS = { botGraceMs: 10_000, botAggroSpreadMs: 12_000, botVsBotDamageScale: 0.3, botVsHumanDamageScale: 0.25 };

export const MODE_PROFILES: Record<string, ModeProfile> = {
  ffa: {
    key: "ffa", evidence: "retail", drop: false, trains: false, maxPlayersPerTeam: 1, toggles: "ffa",
    // flows 7027/7547/7912: BP_LokiPlayerState_FFA_C (adds no net fields over BP_LokiPlayerState_C), BP_FFAHUD,
    // no DropPlane components, no Comp_GameState_Train, BP_FFAPlayerRespawnComponent, respawn gap 1.7–10 s,
    // GE_FFA_SpawnInvuln 10 s, GE_FFA_KnockCausesDeath (a sim kill is already a death), BP_DeathCircle_FFA.
    playerState: { pkg: "/Game/Loki/Core/GameModes/FFA/BP_LokiPlayerState_FFA", cls: "BP_LokiPlayerState_FFA_C" },
    hud: "/Game/Loki/Core/GameModes/FFA/BP_FFAHUD",
    rules: {
      mode: "ffa", soloTeams: true, endOnLastTeam: false, respawnMs: 5000, spawnInvulnMs: 10_000,
      durationMs: 15 * 60_000, countdownMs: 5000, maxPlayers: 12, botCount: 11, minPlayers: 1,
      zone: { enabled: true, startRadius: 60000, endRadius: 15000, shrinkStartMs: 4 * 60_000, shrinkEndMs: 11 * 60_000, dps: 20 } as MatchRules["zone"],
      botGraceMs: 10_000, botAggroSpreadMs: 30_000,
    },
    initialPhase: 7,
    // GS open in flow 7027 (decoded 2026-11-25): MaxPlayersPerTeam 1, NumTeams 11, ReplicatedNumRemainingPlayers 11→12,
    // GameOverWorldTime 900 at world time 19 (≈15 min), DeathCircle set, CurrentPhase 7, no DayNightState.
    notes: "retail: classes/HUD/phase 7/15 min/12 players/respawn/invuln/no drop/no train; guess: bot pacing, zone radii",
  },
  solos: {
    key: "solos", evidence: "asset", drop: true, trains: true, maxPlayersPerTeam: 1, toggles: "breach",
    rules: { mode: "battle_royale", maxPlayers: 20, botCount: 19 },
    notes: "Breach BR rules with 20 solo teams (catalog solo queue); BP_LokiBattleRoyaleGameState_Solos",
  },
  duos: {
    key: "duos", evidence: "asset", drop: true, trains: true, maxPlayersPerTeam: 2, toggles: "breach",
    rules: { mode: "battle_royale", maxPlayers: 32, botCount: 31 },
    notes: "Breach BR rules, 16 teams of 2 (catalog duos queue)",
  },
  turbobr: {
    key: "turbobr", evidence: "guess", drop: true, trains: true, maxPlayersPerTeam: 3, toggles: "breach",
    rules: { mode: "battle_royale", durationMs: 12 * 60_000,
      zone: { enabled: true, startRadius: 60000, endRadius: 2000, shrinkStartMs: 2 * 60_000, shrinkEndMs: 9 * 60_000, dps: 60 } as MatchRules["zone"] },
    notes: "Breach BR with a faster storm (numbers ours); BP_LokiBattleRoyaleGameState_TurboBR",
  },
  arena: {
    key: "arena", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, teamScoreToWin: 4, toggles: "breach",
    hud: "/Game/Loki/Core/GameModes/BP_LastManHUD",
    rules: { mode: "rounds", teamCount: 2, maxPlayers: 8, botCount: 7, minPlayers: 1, roundsToWin: 4, roundIntermissionMs: 6000, roundDurationMs: 90_000,
      respawnMs: -1, durationMs: 25 * 60_000, countdownMs: 5000, spawnRadius: 1500, zone: NO_ZONE, ...ROUND_BOTS },
    notes: "LastMan rounds: team wipe wins a round, first to 4 (number ours); no in-round respawn",
  },
  tournament: {
    key: "tournament", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 1, teamScoreToWin: 3, toggles: "breach",
    hud: "/Game/Loki/Core/GameModes/Tournament/BP_TournamentHUD",
    rules: { mode: "rounds", soloTeams: true, maxPlayers: 8, botCount: 7, minPlayers: 1, roundsToWin: 3, roundIntermissionMs: 6000, roundDurationMs: 90_000,
      respawnMs: -1, durationMs: 25 * 60_000, spawnRadius: 2500, zone: NO_ZONE, ...ROUND_BOTS },
    notes: "8 solos, last one standing wins the round, first to 3 (bracket pairing not simulated)",
  },
  domination: {
    key: "domination", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, teamScoreToWin: 150, toggles: "breach",
    hud: "/Game/Loki/Core/GameModes/Domination/BP_DominationHUD",
    rules: { mode: "team_score", teamCount: 2, maxPlayers: 8, botCount: 7, minPlayers: 1, respawnMs: 5000, endOnLastTeam: false,
      durationMs: 15 * 60_000, spawnRadius: 2500, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "capture", points: 3, pointRadius: 500, captureSec: 8, scoreEveryMs: 4000, scoreLimit: 150 } },
    notes: "objectives.ts capture: points A/B/C between the bases, 8 s capture (retail basecamp crowd rate), +1 per held point every 4 s, first to 150",
  },
  prisma_bank: {
    key: "prisma_bank", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 3, teamScoreToWin: 100, toggles: "breach",
    hud: "/Game/Loki/Core/GameModes/PrismaBank/BP_PrismaBankHUD",
    rules: { mode: "team_score", teamCount: 4, maxPlayers: 12, botCount: 11, minPlayers: 1, respawnMs: 8000, endOnLastTeam: false,
      durationMs: 15 * 60_000, spawnRadius: 3000, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "bank", mineEveryMs: 14_000, mineCap: 4, bankRadius: 600, scoreLimit: 100 } },
    notes: "objectives.ts bank: prisma from a centre mine (2) + side mines (1) and from kills (victim drops carried + 1); walk it into your own bank (team base); first to 100",
  },
  barracuda: {
    key: "barracuda", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, toggles: "breach",
    teamScoreToWin: 3,
    rules: { mode: "team_score", teamCount: 2, maxPlayers: 8, botCount: 7, minPlayers: 1, respawnMs: 10_000, endOnLastTeam: false,
      durationMs: 25 * 60_000, spawnRadius: 3000, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "lanes", towerHp: 6000, coreHp: 10_000, towerRange: 1300, towerDamage: 150, minionEveryMs: 30_000, minionsPerWave: 3, minionHp: 550 } },
    notes: "objectives.ts lanes: per team outer tower → inner tower → core (each invulnerable while the one in front stands), 3-minion waves every 30 s; destroy the enemy core; TeamScores = structures destroyed",
  },
  swordfish: {
    key: "swordfish", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, toggles: "breach",
    teamScoreToWin: 3,
    rules: { mode: "team_score", teamCount: 2, maxPlayers: 8, botCount: 7, minPlayers: 1, respawnMs: 8000, endOnLastTeam: false,
      durationMs: 18 * 60_000, spawnRadius: 3000, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "lanes", towerHp: 4500, coreHp: 7500, towerRange: 1300, towerDamage: 170, minionEveryMs: 22_000, minionsPerWave: 4, minionHp: 450 } },
    notes: "Barracuda variant (objectives.ts lanes): softer structures, bigger + faster minion waves, shorter clock (numbers ours)",
  },
  battlefield: {
    key: "battlefield", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, toggles: "breach",
    teamScoreToWin: 300,
    rules: { mode: "team_score", teamCount: 2, maxPlayers: 8, botCount: 7, minPlayers: 1, respawnMs: 8000, endOnLastTeam: false,
      durationMs: 20 * 60_000, spawnRadius: 3000, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "conquest", points: 5, pointRadius: 550, captureSec: 10, scoreEveryMs: 5000, killPoints: 2, scoreLimit: 300 } },
    notes: "objectives.ts conquest (BP_CapturePoint_Battlefield exists in the paks): 5 points, +1 per held point every 5 s, +2 per enemy kill, first to 300",
  },
  soccervive: {
    key: "soccervive", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 3, toggles: "breach",
    hud: "/Game/Loki/Core/GameModes/Soccervive/BP_SoccerviveHUD",
    teamScoreToWin: 5,
    rules: { mode: "team_score", teamCount: 2, maxPlayers: 6, botCount: 5, minPlayers: 1, respawnMs: 4000, endOnLastTeam: false,
      durationMs: 12 * 60_000, spawnRadius: 2000, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "ball", goalRadius: 450, kickoffMs: 3000, tackleDamage: 250, halfLength: 3400, scoreLimit: 5 } },
    notes: "Grindball (objectives.ts ball): walk over the ball to pick it up, carry it into the enemy goal (their base), 250 damage tackles it loose, dying drops it; first to 5 goals",
  },
  tugofwar: {
    key: "tugofwar", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, toggles: "breach",
    hud: "/Game/Loki/Core/GameModes/TugOfWar/BP_TugOfWarHUD",
    teamScoreToWin: 100,
    rules: { mode: "team_score", teamCount: 2, maxPlayers: 8, botCount: 7, minPlayers: 1, respawnMs: 6000, endOnLastTeam: false,
      durationMs: 15 * 60_000, spawnRadius: 2500, zone: NO_ZONE, ...ARENA_BOTS,
      objective: { kind: "tug", pointRadius: 550, pushSpeed: 55, halfLength: 3000 } },
    notes: "objectives.ts tug: one point between the bases; the team with more players on it pushes it (55 uu/s, crowd rate) — into the enemy base wins; TeamScores = % pushed",
  },
  holdout: {
    key: "holdout", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 4, toggles: "breach",
    teamScoreToWin: 10,
    rules: { mode: "pve", pveHumanTeam: 0, teamCount: 2, maxPlayers: 14, botCount: 10, minPlayers: 1, respawnMs: 8000, endOnLastTeam: false,
      durationMs: 25 * 60_000, spawnRadius: 3000, zone: NO_ZONE, botGraceMs: 5_000, botAggroSpreadMs: 0, botVsHumanDamageScale: 0.3,
      objective: { kind: "waves", waves: 10, waveIntermissionMs: 10_000, waveBase: 1, defenders: 4, enemyDamageScale: 0.45 } },
    notes: "objectives.ts waves: 10 escalating waves of hero bots (size 2→10, HP ×0.48→×1.2) around the defenders' base; bots fill the defenders to 4; dead defenders return when the wave is cleared; every defender down = loss (PvE minion classes not replicable yet)",
  },
  training: {
    key: "training", evidence: "guess", drop: false, trains: false, maxPlayersPerTeam: 1, toggles: "breach",
    rules: { mode: "practice", teamCount: 2, maxPlayers: 4, botCount: 3, minPlayers: 1, respawnMs: 3000, endOnLastTeam: false,
      durationMs: 60 * 60_000, countdownMs: 0, spawnRadius: 800, zone: NO_ZONE, botGraceMs: -1 },
    notes: "passive target bots that never attack, 60 min, respawn 3 s",
  },
};
MODE_PROFILES.deathmatch = MODE_PROFILES.arena!;
MODE_PROFILES.tutorial = MODE_PROFILES.training!;

/** Profile for an allocation; null for Breach-family modes or with LOKI_MODES=0. `queue` (match QueueID) wins
 *  over GameMode/MapName when it names a family directly (e.g. "dropin" → ffa). */
export function modeProfileFor(gameMode: string, mapName: string, queue = ""): ModeProfile | null {
  if (process.env.LOKI_MODES === "0") return null;
  const forced = process.env.LOKI_MODE_PROFILE;
  if (forced) return MODE_PROFILES[forced] || null;
  const q = queue.toLowerCase().replace(/-ranked$/, "");
  const byQueue: Record<string, string> = { dropin: "ffa", brdm: "ffa", solodm: "ffa", solo: "solos", duos: "duos", turbobr: "turbobr",
    deathmatch: "arena", armorydeathmath: "arena", domination: "domination", prismabank: "prisma_bank", tournament: "tournament",
    barracuda: "barracuda", swordfish: "swordfish", battlefield: "battlefield", soccervive: "soccervive", holdout: "holdout",
    training: "training", "training-local": "training", practice: "training", tutorial: "training", "tutorial-local": "training" };
  const key = byQueue[q] || resolveModeKey(gameMode, mapName);
  return MODE_PROFILES[key] || null;
}
