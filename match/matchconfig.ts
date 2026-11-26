/**
 * usmap-derived match constants for SUPERVIVE 2.0.4, verified against
 * data/usmap-enums-204.json at load. These drive the welcome map,
 * GameModeType and the ERoundPhase lifecycle exposed in match details.
 *
 * Wire writes for Loki-only replicated properties stay disabled until real
 * client handles are captured (see tools/gen-loki-layout.ts report).
 */
import { readFileSync } from "node:fs";

const enumsFile = JSON.parse(
  readFileSync(new URL("./data/usmap-enums-204.json", import.meta.url).pathname, "utf8"),
) as { enums: Record<string, Record<string, number>> };

function enumValues(name: string): Record<string, number> {
  const e = enumsFile.enums[name];
  if (!e) throw new Error(`[matchconfig] usmap enum ${name} missing — regenerate data`);
  return e;
}

export const GAME_MODE_TYPE = enumValues("ELokiGameModeType");
export const ROUND_PHASE = enumValues("ERoundPhase");
export const PLAYER_LIVING_STATE = enumValues("EPlayerLivingState");

export type MatchMode =
  | "battle_royale"
  | "arena"
  | "deathmatch"
  | "domination"
  | "tournament"
  | "prisma_bank"
  | "barracuda"
  | "grindball"
  | "holdout"
  | "practice"
  | "battlefield";

/** queue/match-type name (lowercase, from the 2.0.4 matchmaking table) → mode. */
const QUEUE_MODE: Record<string, MatchMode> = {
  breach: "battle_royale",
  solos: "battle_royale",
  duos: "battle_royale",
  trios: "battle_royale",
  arena: "arena",
  "arena-duos": "arena",
  "arena-trios": "arena",
  deathmatch: "deathmatch",
  "solo-dm": "deathmatch",
  domination: "domination",
  tournament: "tournament",
  "prisma-party": "prisma_bank",
  barracuda: "barracuda",
  swordfish: "barracuda",
  grindball: "grindball",
  soccervive: "grindball",
  holdout: "holdout",
  battlefield: "battlefield",
  "warm-up": "practice",
  dropin: "practice",
  practice: "practice",
  training: "practice",
  "basic-training": "practice",
};

/** ELokiGameModeType per mode — verified against the 2.0.4 usmap enum. */
const MODE_TYPE: Record<MatchMode, number> = {
  battle_royale: GAME_MODE_TYPE.BattleRoyale,
  arena: GAME_MODE_TYPE.LastMan,
  deathmatch: GAME_MODE_TYPE.LastMan,
  domination: GAME_MODE_TYPE.Domination,
  tournament: GAME_MODE_TYPE.Tournament,
  prisma_bank: GAME_MODE_TYPE.PrismaBank,
  barracuda: GAME_MODE_TYPE.Barracuda,
  grindball: GAME_MODE_TYPE.LastMan,
  holdout: GAME_MODE_TYPE.LastMan,
  practice: GAME_MODE_TYPE.BattleRoyale,
  battlefield: GAME_MODE_TYPE.BattleRoyale,
};

/** Welcome map per mode — real 2.0.4 asset paths from catalog-204.json. */
const MODE_MAP: Record<MatchMode, string> = {
  battle_royale: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach",
  arena: "/Game/Loki/Maps/LVL_Lastman/LVL_Lastman",
  deathmatch: "/Game/Loki/Maps/LVL_Lastman/LVL_Lastman",
  domination: "/Game/Loki/Maps/Domination/LVL_Domination",
  tournament: "/Game/Loki/Maps/Bracket/LVL_Bracket_01",
  prisma_bank: "/Game/Loki/Maps/PrismaBank/LVL_PrismaBank_01",
  barracuda: "/Game/Loki/Maps/BeastHaven/LVL_BeastHaven",
  grindball: "/Game/Loki/Maps/GrindBall/LVL_GrindBallArena_01",
  holdout: "/Game/Loki/Maps/Holdout/LVL_Holdout",
  practice: "/Game/Loki/Maps/PracticeMap/LVL_Practice",
  battlefield: "/Game/Loki/Maps/Battlefield/LVL_Battlefield",
};

export function modeForQueue(queue: string): MatchMode {
  const q = queue.toLowerCase().replace(/[_\s]+/g, "-").replace(/-ranked$/, "");
  return QUEUE_MODE[q] ?? "battle_royale";
}

export function gameModeTypeFor(mode: string): number {
  return MODE_TYPE[modeForQueue(mode)] ?? GAME_MODE_TYPE.None;
}

export function welcomeMapFor(mode: string): string {
  return MODE_MAP[modeForQueue(mode)];
}

export const ALL_MODE_MAPS = { ...MODE_MAP };

/**
 * ERoundPhase for the client's match lifecycle (wire enums 4-7 are the
 * phases SuperVive lobby UI waits on: SpawnSelect/SpawnReveal/Lineup/Combat).
 * waiting → SpawnSelect; first half of countdown → SpawnReveal, second half
 * → Lineup; playing → Combat; ended → Post.
 */
export function roundPhaseFor(
  phase: "waiting" | "countdown" | "playing" | "ended",
  remainingMs: number,
  countdownMs: number,
): number {
  switch (phase) {
    case "waiting": return ROUND_PHASE.EGP_SpawnSelect;
    case "countdown": return remainingMs > countdownMs / 2 ? ROUND_PHASE.EGP_SpawnReveal : ROUND_PHASE.EGP_Lineup;
    case "playing": return ROUND_PHASE.EGP_Combat;
    case "ended": return ROUND_PHASE.EGP_Post;
  }
}
