/**
 * Authoritative match simulation for the clean-room Loki game server.
 *
 * Pure TypeScript: no sockets, no filesystem, no wall-clock reads except through
 * the injected `now()` function. That keeps it deterministic and trivially
 * testable; `server.ts` feeds it client input and replicates its snapshot.
 */

import { Objective, isHero, type ObjectiveSpec, type EntityKind } from "./objectives.ts";

export type MatchMode = "battle_royale" | "arena" | "deathmatch" | "domination"
  // non-Breach mode families (server/ue/modeconfig.ts MODE_PROFILES); behaviour comes from the optional rule fields below
  | "ffa" | "rounds" | "team_score" | "pve" | "practice";

export interface AbilityDef {
  id: string;
  name: string;
  cooldownMs: number;
  manaCost: number;
  damage: number;
  range: number;
  radius: number;
  heal: number;
  shield: number;
  dash: number;
  castMs: number;
}

export interface ZoneRules {
  enabled: boolean;
  startRadius: number;
  endRadius: number;
  shrinkStartMs: number;
  shrinkEndMs: number;
  dps: number;
}

export interface MatchRules {
  mode: MatchMode;
  maxPlayers: number;
  minPlayers: number;
  teamCount: number;
  botCount: number;
  fillBots: boolean;
  countdownMs: number;
  durationMs: number;
  respawnMs: number;
  scoreLimit: number;
  spawnRadius: number;
  moveSpeed: number;
  sprintMultiplier: number;
  acceleration: number;
  friction: number;
  gravity: number;
  jumpSpeed: number;
  eyeHeight: number;
  hp: number;
  shield: number;
  mana: number;
  manaRegenPerSec: number;
  shot: { damage: number; range: number; cooldownMs: number; spreadDeg: number };
  zone: ZoneRules;
  abilities: AbilityDef[];
  // ---- optional per-mode rules (modeconfig.ts MODE_PROFILES). All unset = the Breach battle royale behaviour.
  /** every combatant on its own team (FFA / Tournament) */
  soloTeams?: boolean;
  /** humans all on this team, bots on the others (Holdout PvE) */
  pveHumanTeam?: number;
  /** last team standing ends the match (default true); respawn modes turn it off */
  endOnLastTeam?: boolean;
  /** round-based (LokiRoundGameMode): a team wipe wins the round, first to N rounds wins the match */
  roundsToWin?: number;
  roundIntermissionMs?: number;
  /** round timer (LokiRoundGameMode.RoundDuration): at expiry the team with most alive (then most HP) takes the round */
  roundDurationMs?: number;
  /** team score modes: points per enemy kill, first team to the limit wins */
  teamScorePerKill?: number;
  teamScoreLimit?: number;
  /** damage immunity after a (re)spawn (retail FFA GE_FFA_SpawnInvuln = 10 s) */
  spawnInvulnMs?: number;
  /** bot passivity overrides (defaults LOKI_BOT_GRACE_MS / LOKI_BOT_AGGRO_SPREAD_MS); <0 grace = never aggressive */
  botGraceMs?: number;
  /** multiplier on bot-to-bot damage (round/arena modes pace bot fights so a human sees the round) */
  botVsBotDamageScale?: number;
  /** multiplier on bot damage against humans (default LOKI_BOT_VS_HUMAN_DMG). */
  botVsHumanDamageScale?: number;
  botAggroSpreadMs?: number;
  /** mode objective (objectives.ts): capture points, tug, prisma bank, ball, lanes, holdout waves. Scores go to TeamScores. */
  objective?: ObjectiveSpec;
}

export interface CombatantInput {
  mx: number;
  my: number;
  yaw: number;
  pitch: number;
  fire: boolean;
  sprint: boolean;
  jump: boolean;
}

export interface Combatant {
  id: string;
  name: string;
  team: number;
  heroId: string;
  isBot: boolean;
  /** objective entities (towers / cores / minions) are bots the objective drives; unset = a hero */
  kind?: EntityKind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  hp: number; maxHp: number;
  shield: number; maxShield: number;
  mana: number; maxMana: number;
  alive: boolean;
  grounded: boolean;
  respawnAtMs: number;
  kills: number; deaths: number; assists: number; score: number;
  damageDealt: number; damageTaken: number;
  cooldowns: Record<string, number>;
  recentDamage: Array<{ by: string; atMs: number; amount: number }>;
  input: CombatantInput;
  lastFireMs: number;
  lastInputMs: number;
}

export type MatchPhase = "waiting" | "countdown" | "playing" | "ended";

export type MatchEvent =
  | { t: number; type: "player_joined"; id: string; name: string; team: number; isBot: boolean }
  | { t: number; type: "player_left"; id: string }
  | { t: number; type: "match_start"; players: number; bots: number }
  | { t: number; type: "match_end"; winner: number | null; reason: string; durationMs: number }
  | { t: number; type: "kill"; killer: string; victim: string; assistants: string[]; weapon: string }
  | { t: number; type: "damage"; source: string; target: string; amount: number; hp: number; ability: string }
  | { t: number; type: "ability"; id: string; ability: string; ok: boolean; reason?: string }
  | { t: number; type: "zone"; radius: number; dps: number }
  | { t: number; type: "respawn"; id: string; x?: number; y?: number; z?: number }
  | { t: number; type: "unstick"; id: string; x: number; y: number; z: number; why?: string }
  | { t: number; type: "bot_fill"; count: number }
  | { t: number; type: "round_end"; round: number; winner: number | null; wins: Record<number, number> }
  | { t: number; type: "round_start"; round: number }
  | { t: number; type: "team_score"; team: number; score: number; scores: Record<number, number>; reason?: string }
  | { t: number; type: "objective"; what: string; team: number; detail: string };

export interface MatchSnapshot {
  matchId: string;
  phase: MatchPhase;
  roundPhase: RoundPhase;
  roundPhaseCode: number;
  gameModeType: number;
  mode: MatchMode;
  elapsedMs: number;
  remainingMs: number;
  countdownMs: number;
  zone: { radius: number; centerX: number; centerY: number; dps: number };
  winner: number | null;
  endReason: string;
  combatants: Combatant[];
  leaderboard: Array<{ id: string; name: string; team: number; kills: number; deaths: number; assists: number; score: number; alive: boolean; isBot: boolean }>;
  playersAlive: number;
  botsAlive: number;
  /** team score / round modes only */
  teamScores?: Record<number, number>;
  round?: number;
  roundWins?: Record<number, number>;
  /** objective modes only (objectives.ts state) */
  objective?: ReturnType<Objective["state"]>;
}

export interface MatchWorldOptions {
  matchId?: string;
  gameModeType?: number;
  now?: () => number;
  rng?: () => number;
  onEvent?: (event: MatchEvent) => void;
  eventLimit?: number;
  /** Real map spawn floors ([x, y, z]); bots start on these (one per team) instead of a disk round the origin. */
  spawnPoints?: () => number[][];
  /** Terrain height under (x, y), null over open sky; bots walk on it and never step off it. */
  floorAt?: (x: number, y: number) => number | null;
}
/** Client round lifecycle (values verified in data/204/usmap-enums-204.json). */
export type RoundPhase =
  | "EGP_ServerStartup" | "EGP_BeginInit" | "EGP_Pre" | "EGP_FinishInit"
  | "EGP_SpawnSelect" | "EGP_SpawnReveal" | "EGP_Lineup" | "EGP_Combat"
  | "EGP_Post" | "EGP_Shutdown";

export const ROUND_PHASE_CODE: Record<RoundPhase, number> = {
  EGP_ServerStartup: 0, EGP_BeginInit: 1, EGP_Pre: 2, EGP_FinishInit: 3,
  EGP_SpawnSelect: 4, EGP_SpawnReveal: 5, EGP_Lineup: 6, EGP_Combat: 7,
  EGP_Post: 8, EGP_Shutdown: 9,
};

const DEFAULT_ABILITIES: AbilityDef[] = [
  { id: "primary", name: "Primary Fire", cooldownMs: 250, manaCost: 0, damage: 80, range: 2800, radius: 0, heal: 0, shield: 0, dash: 0, castMs: 0 },
  { id: "bolt", name: "Arc Bolt", cooldownMs: 5500, manaCost: 18, damage: 210, range: 3200, radius: 120, heal: 0, shield: 0, dash: 0, castMs: 150 },
  { id: "nova", name: "Nova Burst", cooldownMs: 11000, manaCost: 30, damage: 320, range: 1500, radius: 750, heal: 0, shield: 0, dash: 0, castMs: 250 },
  { id: "mend", name: "Field Mend", cooldownMs: 14000, manaCost: 24, damage: 0, range: 0, radius: 0, heal: 300, shield: 120, dash: 0, castMs: 200 },
  { id: "dash", name: "Blink Dash", cooldownMs: 4500, manaCost: 12, damage: 0, range: 0, radius: 0, heal: 0, shield: 0, dash: 950, castMs: 0 },
  { id: "barrage", name: "Star Barrage", cooldownMs: 28000, manaCost: 55, damage: 525, range: 2600, radius: 1100, heal: 0, shield: 0, dash: 0, castMs: 400 },
];

// GAS works in-client since 2026-11-25, so humans can fight back: bots now target them (LOKI_BOTS_HIT_HUMANS=0 disables).
const BOTS_HIT_HUMANS = process.env.LOKI_BOTS_HIT_HUMANS !== "0";
const ZONE_HITS_HUMANS = process.env.LOKI_ZONE_HITS_HUMANS === "1";
/** MaxHealth per hero. No per-hero table is shipped; every hero uses one value unless data/hero-stats.json sets "hp". */
const HERO_HP: Record<string, number> = new Proxy((() => {
  try { return JSON.parse(require("node:fs").readFileSync(new URL("./data/hero-stats.json", import.meta.url), "utf8")).hp || {}; } catch { return {}; }
})(), { get: (t, k: string) => t[k] ?? 1290 });
const BOT_MAX_GLIDE_MS = Number(process.env.LOKI_BOT_MAX_GLIDE_MS || 20000);
const HUMAN_MELEE_REACH = Number(process.env.LOKI_HUMAN_MELEE_REACH || 450);
const HUMAN_RANGED_REACH = Number(process.env.LOKI_HUMAN_RANGED_REACH || 1500);
const BOT_VS_HUMAN_DMG = Number(process.env.LOKI_BOT_VS_HUMAN_DMG || 0.4);
const CAPSULE_HALF = Number(process.env.LOKI_CAPSULE_HALF || 90);
const BOT_SIGHT = Number(process.env.LOKI_BOT_SIGHT || 2600);
const BOT_SKILL_MIN = Number(process.env.LOKI_BOT_SKILL_MIN || 0.35);
const BOT_SKILL_MAX = Number(process.env.LOKI_BOT_SKILL_MAX || 0.9);
/** score bonus for a human target (0 = treated like any bot) */
const BOT_HUMAN_BIAS = Number(process.env.LOKI_BOT_HUMAN_BIAS || 0.5);
const MELEE_HEROES = new Set(["Ronin", "Stalker", "Wukong", "Reaper", "Earthtank", "ShieldBot", "Flex", "HookGuy", "Succubus"]);
const LONG_HEROES = new Set(["Sniper", "FarShot", "Huntress", "BountyHunter"]);
interface BotBrain {
  skill: number; reactionMs: number; preferRange: number; bravery: number;
  state: "roam" | "fight" | "retreat" | "rotate"; targetId: string; seenAtMs: number; lastHp: number;
  strafeDir: number; strafeFlipMs: number; retreatUntil: number; stuckMs: number; lastX: number; lastY: number; nextThinkMs: number;
  stuckHits: number[]; airMs: number; sampleAt: number;
}
const BOT_GRACE_MS = Number(process.env.LOKI_BOT_GRACE_MS || 45_000);
const BOT_ENGAGE_RANGE = Number(process.env.LOKI_BOT_ENGAGE_RANGE || 1600);
// Bots turn aggressive one by one over this window after the grace period, so a
// 35-bot lobby thins out over the match instead of wiping itself at the grace mark.
const BOT_AGGRO_SPREAD_MS = Number(process.env.LOKI_BOT_AGGRO_SPREAD_MS || 5 * 60_000);

export const DEFAULT_RULES: MatchRules = {
  mode: "battle_royale",
  maxPlayers: 36,
  minPlayers: 2,
  teamCount: 12,
  botCount: 35,
  fillBots: true,
  countdownMs: 5000,
  durationMs: 15 * 60_000,
  respawnMs: -1,
  scoreLimit: 0,
  spawnRadius: 7000,
  moveSpeed: 620,
  sprintMultiplier: 1.45,
  acceleration: 2400,
  friction: 1800,
  gravity: 980,
  jumpSpeed: 470,
  eyeHeight: 120,
  hp: 220,
  shield: 80,
  mana: 100,
  manaRegenPerSec: 7,
  shot: { damage: 16, range: 2800, cooldownMs: 250, spreadDeg: 2.5 },
  zone: {
    // Breach is ~80k uu across: a 9k zone killed anyone who landed off-centre within a minute.
    enabled: process.env.LOKI_ZONE !== "0", startRadius: Number(process.env.LOKI_ZONE_START || 60000), endRadius: 2000,
    shrinkStartMs: Number(process.env.LOKI_ZONE_SHRINK_MS || 6 * 60_000), shrinkEndMs: 22 * 60_000, dps: 9,
  },
  abilities: DEFAULT_ABILITIES,
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOT_NAMES = [
  "Rook", "Vesper", "Kestrel", "Hex", "Onyx", "Cinder", "Lumen", "Wraith",
  "Basil", "Quill", "Sable", "Ember", "Zephyr", "Marrow", "Pixel", "Dusk",
  "Fable", "Grit", "Halo", "Iris", "Jinx", "Kilo", "Lynx", "Mica", "Nyx",
  "Orbit", "Pike", "Rune", "Sol", "Talon", "Umbra", "Vex", "Wisp", "Yara", "Zed",
];

const HERO_IDS = ["Hero:Assault", "Hero:Alchemist", "Hero:Ronin", "Hero:Huntress", "Hero:Gunner", "Hero:Storm", "Hero:Void", "Hero:Wukong", "Hero:Beebo", "Hero:Freeze"];

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

export class MatchWorld {
  readonly matchId: string;
  readonly rules: MatchRules;
  private now: () => number;
  private rng: () => number;
  private onEvent?: (event: MatchEvent) => void;
  private events: MatchEvent[] = [];
  private combatants = new Map<string, Combatant>();
  private createdAtMs: number;
  private phaseStartedAtMs: number;
  private startAtMs: number;
  private winner: number | null = null;
  private endReason = "";
  private endedAtMs = 0;
  private botSerial = 0;
  private lastZoneRadius: number;
  private zoneAnnounced: number[] = [];
  private gameModeTypeCode?: number;
  /** Replicated storm (server.ts → zone.ts): when set and non-null it replaces the sim's radius/centre/dps, and humans burn
   *  too because the client now draws the circle (LOKI_ZONE_HITS_HUMANS=0 keeps them immune). */
  /** BR elimination order: team -> ms its last member died (placement = 1 + teams that outlasted it). */
  private teamOutAt = new Map<number, number>();
  private humansOutAt = 0;
  zoneOverride: (() => { radius: number; centerX: number; centerY: number; dps: number } | null) | null = null;

  constructor(rules: Partial<MatchRules> = {}, opts: MatchWorldOptions = {}) {
    this.rules = {
      ...DEFAULT_RULES,
      ...rules,
      shot: { ...DEFAULT_RULES.shot, ...(rules.shot || {}) },
      zone: { ...DEFAULT_RULES.zone, ...(rules.zone || {}) },
      abilities: rules.abilities || DEFAULT_RULES.abilities,
    };
    if (rules.respawnMs === undefined && (this.rules.mode === "deathmatch" || this.rules.mode === "domination") && this.rules.respawnMs < 0) {
      this.rules.respawnMs = 5000;
    }
    this.matchId = opts.matchId || "match";
    this.gameModeTypeCode = opts.gameModeType;
    this.now = opts.now || Date.now;
    this.rng = opts.rng || mulberry32(0x10c1);
    this.onEvent = opts.onEvent;
    this.spawnPoints = opts.spawnPoints;
    this.floorAt = opts.floorAt;
    this.createdAtMs = this.now();
    this.phaseStartedAtMs = this.createdAtMs;
    this.startAtMs = this.createdAtMs + this.rules.countdownMs;
    this.lastZoneRadius = this.rules.zone.startRadius;
    if (this.rules.countdownMs <= 0) this.begin();
  }

  private emit(event: MatchEvent) {
    this.events.push(event);
    const limit = 250;
    if (this.events.length > limit) this.events.splice(0, this.events.length - limit);
    this.onEvent?.(event);
  }

  get phase(): MatchPhase { return this.phaseRaw; }

  private get phaseRaw(): MatchPhase {
    if (this.endedAtMs) return "ended";
    if (!this.started && !this.countdownStarted) return "waiting";
    if (!this.started && this.now() < this.startAtMs) return "countdown";
    return "playing";
  }

  /** Client round lifecycle: spawn select before the countdown, reveal then
   *  lineup through it, combat in play, post after the match ends. Reveal
   *  covers the first 60% of the countdown, lineup the rest. */
  get roundPhase(): RoundPhase {
    const phase = this.phaseRaw;
    if (phase === "ended") return "EGP_Post";
    if (phase === "playing") return "EGP_Combat";
    if (phase === "countdown") {
      const inCountdown = this.startAtMs - this.now();
      return inCountdown > this.rules.countdownMs * 0.6 ? "EGP_SpawnReveal" : "EGP_Lineup";
    }
    return "EGP_SpawnSelect";
  }

  private started = false;
  private countdownStarted = false;

  private begin() {
    if (this.started) return;
    this.started = true;
    this.phaseStartedAtMs = this.now();
    this.botAggroAt.clear(); this.botHome.clear(); this.brains.clear();
    this.ensureObjective()?.setup();
    this.emit({ t: this.now(), type: "match_start", players: this.humanCount(), bots: this.botCount() });
  }

  addPlayer(id: string, name: string, opts: { team?: number; heroId?: string; isBot?: boolean } = {}): Combatant {
    const existing = this.combatants.get(id);
    if (existing) return existing;
    const index = this.combatants.size;
    const team = opts.team ?? (this.rules.pveHumanTeam !== undefined && !opts.isBot ? this.rules.pveHumanTeam
      : this.rules.mode === "battle_royale" || this.rules.soloTeams
      ? index
      : this.rules.teamCount <= 1 ? 0 : index % this.rules.teamCount);
    const c = this.makeCombatant(id, name, team, opts.heroId, !!opts.isBot, index);
    this.combatants.set(id, c);
    this.emit({ t: this.now(), type: "player_joined", id, name, team, isBot: c.isBot });
    this.fillBots();
    this.maybeStart();
    return c;
  }

  private spawnPoints?: () => number[][];
  private floorAt?: (x: number, y: number) => number | null;
  private makeCombatantAt(id: string, name: string, team: number, heroId: string | undefined, isBot: boolean, index: number, x: number, y: number, z: number): Combatant {
    const saved = this.spawnPoints; this.spawnPoints = undefined;
    const c = this.makeCombatant(id, name, team, heroId, isBot, index);
    this.spawnPoints = saved;
    c.x = x; c.y = y; c.z = z;
    return c;
  }
  private makeCombatant(id: string, name: string, team: number, heroId: string | undefined, isBot: boolean, index: number): Combatant {
    // Sunflower spread over the whole drop disk: ~2,400 units between neighbours at 36 players,
    // well outside BOT_ENGAGE_RANGE, so nobody starts in a fight.
    const n = Math.max(1, this.rules.maxPlayers);
    const angle = index * 2.399963229728653;
    const radius = (this.rules.spawnRadius + 1000) * Math.sqrt((index + 0.5) / n);
    const pts = isBot && process.env.LOKI_BOT_SPAWN_MAP !== "0" ? (this.spawnPoints?.() || []) : [];
    if (pts.length) {
      // one real start per team (spread over the island), team mates 180 uu apart
      const p = pts[(Math.max(0, team) * 7 + 3) % pts.length]!;
      const slot = (index % 3) - 1;
      const c = this.makeCombatantAt(id, name, team, heroId, isBot, index, p[0]! + slot * 180, p[1]! + slot * 60, p[2]! + 90);
      return c;
    }
    return {
      id, name, team,
      heroId: heroId || HERO_IDS[index % HERO_IDS.length]!,
      isBot,
      x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: this.rules.eyeHeight,
      vx: 0, vy: 0, vz: 0,
      yaw: (angle * 180) / Math.PI + 180, pitch: 0,
      hp: HERO_HP[(heroId || HERO_IDS[index % HERO_IDS.length]!).replace(/^Hero:/, "")] ?? this.rules.hp,
      maxHp: HERO_HP[(heroId || HERO_IDS[index % HERO_IDS.length]!).replace(/^Hero:/, "")] ?? this.rules.hp,
      shield: this.rules.shield, maxShield: this.rules.shield,
      mana: this.rules.mana, maxMana: this.rules.mana,
      alive: true, grounded: true, respawnAtMs: 0,
      kills: 0, deaths: 0, assists: 0, score: 0,
      damageDealt: 0, damageTaken: 0,
      cooldowns: {}, recentDamage: [],
      input: { mx: 0, my: 0, yaw: 0, pitch: 0, fire: false, sprint: false, jump: false },
      lastFireMs: 0, lastInputMs: this.now(),
    };
  }

  removePlayer(id: string) {
    if (!this.combatants.delete(id)) return;
    this.emit({ t: this.now(), type: "player_left", id });
    this.checkWin("player_left");
  }

  get(id: string) { return this.combatants.get(id); }
  get isStarted() { return this.started && !this.endedAtMs; }
  /** A human fell off the island (server-detected from its moves): retail counts that as a death. */
  killByAbyss(id: string) {
    const c = this.combatants.get(id);
    if (!c || !c.alive || !this.started || this.endedAtMs) return false;
    this.kill(null, c, "abyss");
    return true;
  }
  all(): Combatant[] { return Array.from(this.combatants.values()); }
  humanCount() { return Array.from(this.combatants.values()).filter((c) => !c.isBot).length; }
  botCount() { return Array.from(this.combatants.values()).filter((c) => c.isBot && isHero(c)).length; }

  private rosterLocked = false;

  /** Seat the backend matchmaker's roster (teams, heroes, bot slots) so party members share a team
   *  and the client's hero-select picks are the heroes that spawn. Disables free-form bot fill. */
  applyRoster(members: Array<{ id: string; name: string; team: number; heroId?: string; isBot: boolean }>) {
    this.rosterLocked = true;
    const ids = new Set(members.map((m) => m.id));
    for (const [id, c] of this.combatants) if (c.isBot && !ids.has(id)) this.combatants.delete(id); // drop free-fill bots
    for (const m of members) {
      const existing = this.combatants.get(m.id);
      if (existing) { existing.team = m.team; if (m.heroId) existing.heroId = m.heroId; existing.name = m.name || existing.name; continue; }
      if (!m.isBot) continue; // humans are seated when they connect
      this.combatants.set(m.id, this.makeCombatant(m.id, m.name, m.team, m.heroId, true, this.combatants.size));
    }
    this.emit({ t: this.now(), type: "bot_fill", count: members.filter((m) => m.isBot).length });
    this.maybeStart();
  }

  fillBots() {
    if (!this.rules.fillBots || this.rosterLocked) return;
    const humans = this.humanCount();
    const wantedBots = Math.min(
      this.rules.botCount || this.rules.maxPlayers - humans,
      Math.max(0, this.rules.maxPlayers - humans),
    );
    const need = wantedBots - this.botCount();
    if (need <= 0) return;
    const teamCount = Math.max(1, this.rules.teamCount);
    const teamSizes = new Map<number, number>();
    for (const c of this.combatants.values()) teamSizes.set(c.team, (teamSizes.get(c.team) || 0) + 1);
    for (let i = 0; i < need; i++) {
      const serial = this.botSerial++;
      const id = `bot_${serial.toString(36).padStart(3, "0")}`;
      const name = `${BOT_NAMES[serial % BOT_NAMES.length]}_${(serial / BOT_NAMES.length) | 0}`;
      let team: number;
      if (this.rules.mode === "battle_royale" || this.rules.soloTeams) {
        team = this.combatants.size;
      } else if (this.rules.pveHumanTeam !== undefined) {
        team = this.rules.pveHumanTeam === 1 ? 0 : 1;
      } else {
        team = 0;
        for (let t = 1; t < teamCount; t++) {
          if ((teamSizes.get(t) || 0) < (teamSizes.get(team) || 0)) team = t;
        }
      }
      teamSizes.set(team, (teamSizes.get(team) || 0) + 1);
      this.combatants.set(id, this.makeCombatant(id, name, team, undefined, true, this.combatants.size));
    }
    this.emit({ t: this.now(), type: "bot_fill", count: need });
    this.maybeStart();
  }

  private maybeStart() {
    if (this.countdownStarted || this.started || this.endedAtMs) return;
    if (this.rules.minPlayers <= 0 || this.combatants.size < this.rules.minPlayers) return;
    this.countdownStarted = true;
    this.startAtMs = this.now() + this.rules.countdownMs;
    if (this.rules.countdownMs <= 0) this.begin();
  }

  forceStart() {
    if (this.endedAtMs) return;
    this.countdownStarted = true;
    this.begin();
  }

  setInput(id: string, input: Partial<CombatantInput>) {
    const c = this.combatants.get(id);
    if (!c) return;
    c.input = {
      mx: clamp(input.mx ?? c.input.mx, -1, 1),
      my: clamp(input.my ?? c.input.my, -1, 1),
      yaw: Number.isFinite(input.yaw) ? input.yaw! : c.input.yaw,
      pitch: clamp(input.pitch ?? c.input.pitch, -89, 89),
      fire: input.fire ?? c.input.fire,
      sprint: input.sprint ?? c.input.sprint,
      jump: input.jump ?? c.input.jump,
    };
    if (input.yaw !== undefined) c.yaw = c.input.yaw;
    if (input.pitch !== undefined) c.pitch = c.input.pitch;
    c.lastInputMs = this.now();
  }

  private clientDriven = new Set<string>();

  /** Client-authoritative hero state from ServerMovePacked. */
  setClientState(id: string, s: { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; grounded: boolean }) {
    const c = this.combatants.get(id);
    if (!c) return;
    this.clientDriven.add(id);
    c.x = s.x; c.y = s.y; c.z = s.z;
    c.vx = s.vx; c.vy = s.vy; c.vz = s.vz;
    c.yaw = c.input.yaw = s.yaw;
    c.pitch = c.input.pitch = clamp(s.pitch > 180 ? s.pitch - 360 : s.pitch, -89, 89);
    c.grounded = s.grounded;
    c.lastInputMs = this.now();
    if (s.grounded && !c.isBot && c.alive && this.rules.objective) this.ensureObjective()?.anchor(c.team, s.x, s.y, s.z, s.yaw);
  }

  requestAbility(id: string, abilityId: string): { ok: boolean; reason?: string } {
    const c = this.combatants.get(id);
    if (!c || !c.alive || this.phaseRaw !== "playing") return { ok: false, reason: "unavailable" };
    const def = this.rules.abilities.find((a) => a.id === abilityId) || this.rules.abilities[0];
    if (!def) return { ok: false, reason: "no_ability" };
    const now = this.now();
    if (now < (c.cooldowns[def.id] || 0)) return { ok: false, reason: "cooldown" };
    if (c.mana < def.manaCost) return { ok: false, reason: "mana" };
    c.mana -= def.manaCost;
    c.cooldowns[def.id] = now + def.cooldownMs;
    this.emit({ t: now, type: "ability", id: c.id, ability: def.id, ok: true });

    if (def.dash > 0) {
      const rad = (c.yaw * Math.PI) / 180;
      c.x += Math.cos(rad) * def.dash;
      c.y += Math.sin(rad) * def.dash;
    }
    if (def.heal > 0 || def.shield > 0) {
      c.hp = Math.min(c.maxHp, c.hp + def.heal);
      c.shield = Math.min(c.maxShield, c.shield + def.shield);
    }
    if (def.damage > 0) {
      // Humans: the yaw in ServerMovePacked is the camera/control yaw of a top-down game, not the attack direction,
      // so aim at the nearest enemies in reach instead (melee heroes short reach, others mid).
      const targets = c.isBot ? this.targetsInCone(c, def.range, def.radius) : this.humanTargets(c, def);
      for (const target of targets) {
        this.applyDamage(c, target, def.damage, def.id);
        if (!target.alive) break;
      }
    }
    return { ok: true };
  }

  private humanTargets(c: Combatant, def: AbilityDef): Combatant[] {
    const hero = c.heroId.replace(/^Hero:/, "");
    const reach = MELEE_HEROES.has(hero) ? HUMAN_MELEE_REACH : HUMAN_RANGED_REACH;
    const r = def.id === "primary" ? reach : Math.max(reach, Math.min(def.range, HUMAN_RANGED_REACH)) + def.radius * 0.5;
    const out = this.all().filter((e) => e.alive && e !== c && e.team !== c.team && Math.hypot(e.x - c.x, e.y - c.y) <= r);
    out.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
    return def.radius > 0 ? out : out.slice(0, 1);
  }

  private targetsInCone(source: Combatant, range: number, radius: number): Combatant[] {
    const rad = (source.yaw * Math.PI) / 180;
    const fx = Math.cos(rad), fy = Math.sin(rad);
    const out: Combatant[] = [];
    for (const c of this.combatants.values()) {
      if (c === source || !c.alive || c.team === source.team) continue;
      if (source.isBot && !c.isBot && !BOTS_HIT_HUMANS) continue;
      const dx = c.x - source.x, dy = c.y - source.y;
      const dist = Math.hypot(dx, dy);
      if (radius > 0) {
        if (dist <= range + radius) out.push(c);
      } else if (dist <= range && (dist < 120 || (dx * fx + dy * fy) / dist > 0.55)) {
        out.push(c);
      }
    }
    return out.sort((a, b) => Math.hypot(a.x - source.x, a.y - source.y) - Math.hypot(b.x - source.x, b.y - source.y));
  }

  private applyDamage(source: Combatant | null, target: Combatant, amount: number, ability: string) {
    if (!target.alive || amount <= 0) return;
    if (this.roundResetAt) return; // round intermission
    if ((this.invulnUntil.get(target.id) || 0) > this.now()) return;
    if (this.objective && !this.objective.canDamage(source, target)) return;
    if (this.objective) amount *= this.objective.damageScale(source, target);
    this.objective?.onDamage(source, target, amount);
    // bot attacks have no visuals on the client yet, so they hit humans softer (LOKI_BOT_VS_HUMAN_DMG)
    if (source?.isBot && !target.isBot) amount *= this.rules.botVsHumanDamageScale ?? BOT_VS_HUMAN_DMG;
    // small arenas: bot-vs-bot fights at full damage end a whole round in seconds before a human acts
    if (source?.isBot && target.isBot) amount *= this.rules.botVsBotDamageScale ?? 1;
    let remaining = amount;
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, remaining);
      target.shield -= absorbed;
      remaining -= absorbed;
    }
    target.hp -= remaining;
    target.damageTaken += amount;
    if (source) {
      source.damageDealt += amount;
      target.recentDamage.push({ by: source.id, atMs: this.now(), amount });
      if (target.recentDamage.length > 8) target.recentDamage.shift();
    }
    if (ability !== "zone") {
      this.emit({ t: this.now(), type: "damage", source: source?.id || "zone", target: target.id, amount, hp: Math.max(0, target.hp), ability });
    }
    if (target.hp <= 0) this.kill(source, target, ability);
  }

  private kill(source: Combatant | null, victim: Combatant, weapon: string) {
    victim.alive = false;
    victim.hp = 0;
    victim.shield = 0;
    victim.deaths++;
    victim.score -= 10;
    const assistants: string[] = [];
    if (source && source !== victim && !isHero(victim)) {
      source.score += victim.kind === "structure" ? 150 : 15; // last hits on towers / minions are not hero kills
    } else if (source && source !== victim) {
      source.kills++;
      source.score += 100;
      for (const d of victim.recentDamage) {
        if (d.by !== source.id && this.now() - d.atMs < 10_000 && !assistants.includes(d.by)) assistants.push(d.by);
      }
    }
    for (const id of assistants) {
      const a = this.combatants.get(id);
      if (a) { a.assists++; a.score += 40; }
    }
    this.emit({ t: this.now(), type: "kill", killer: source?.id || "zone", victim: victim.id, assistants, weapon });
    if (this.rules.respawnMs >= 0) {
      victim.respawnAtMs = this.now() + this.rules.respawnMs;
    }
    victim.recentDamage = [];
    if (this.objective) {
      const d = this.objective.respawnDelay(victim);
      if (d !== undefined) victim.respawnAtMs = d === Infinity ? Infinity : this.now() + d;
      this.objective.onKill(source, victim);
      if (this.endedAtMs) return;
    }
    if (this.rules.teamScorePerKill && source && source.team !== victim.team && isHero(victim)) {
      const s = (this.teamScores.get(source.team) || 0) + this.rules.teamScorePerKill;
      this.teamScores.set(source.team, s);
      this.emit({ t: this.now(), type: "team_score", team: source.team, score: s, scores: Object.fromEntries(this.teamScores) });
      if (this.rules.teamScoreLimit && s >= this.rules.teamScoreLimit) { this.finish(source.team, "team_score"); return; }
    }
    if (this.rules.respawnMs < 0 && !this.rules.roundsToWin && !this.teamOutAt.has(victim.team)
      && !Array.from(this.combatants.values()).some((c) => c.team === victim.team && c.alive)) this.teamOutAt.set(victim.team, this.now());
    this.checkWin("kill");
  }

  /** true for last-team-standing modes without respawn (Breach family): the ones with an elimination order. */
  private get isElimination() { return this.rules.respawnMs < 0 && !this.rules.roundsToWin && this.rules.endOnLastTeam !== false; }

  /** BR placement of a team: 1 for the winner / survivors, else 1 + the teams that were still in when it went out. */
  teamPlacement(team: number): number {
    if (this.winner === team) return 1;
    const out = this.teamOutAt.get(team);
    const teams = new Set(Array.from(this.combatants.values()).map((c) => c.team));
    let better = 0;
    for (const t of teams) {
      if (t === team) continue;
      const o = this.teamOutAt.get(t);
      if (out === undefined ? (o === undefined && t === this.winner) : (o === undefined || o > out)) better++;
    }
    return better + 1;
  }

  /** Placement in score modes: teams ranked by round wins / team score / summed player score; the winner is 1st. */
  scorePlacement(team: number): number {
    if (this.winner === team) return 1;
    const sums = new Map<number, number>();
    for (const c of this.combatants.values()) sums.set(c.team, (sums.get(c.team) || 0) + c.score);
    const primary = this.rules.roundsToWin ? this.roundWins : this.usesTeamScore ? this.teamScores : sums;
    const key = (t: number) => [t === this.winner ? 1 : 0, primary.get(t) || 0, sums.get(t) || 0] as const;
    const mine = key(team);
    let better = 0;
    for (const t of sums.keys()) {
      if (t === team) continue;
      const o = key(t);
      if (o[0] > mine[0] || (o[0] === mine[0] && (o[1] > mine[1] || (o[1] === mine[1] && o[2] > mine[2])))) better++;
    }
    return better + 1;
  }

  private checkWin(reason: string) {
    if (this.endedAtMs || !this.started) return;
    const alive = Array.from(this.combatants.values()).filter((c) => c.alive);
    const teams = new Set(alive.map((c) => c.team));
    if (this.rules.roundsToWin && this.rules.roundsToWin > 0) {
      if (this.roundResetAt || (teams.size > 1)) return;
      this.endRound(alive.length ? alive[0]!.team : null, reason);
      return;
    }
    if (this.rules.endOnLastTeam === false) return;
    if (teams.size <= 1 && alive.length > 0) {
      this.finish(alive[0]!.team, `${reason}_last_team`);
    } else if (alive.length === 0) {
      this.finish(null, `${reason}_draw`);
    }
  }

  private finish(winner: number | null, reason: string) {
    if (this.endedAtMs) return;
    this.endedAtMs = this.now();
    this.winner = winner;
    this.endReason = reason;
    if (winner !== null) {
      for (const c of this.combatants.values()) if (c.team === winner) c.score += 250;
    }
    this.emit({ t: this.endedAtMs, type: "match_end", winner, reason, durationMs: this.endedAtMs - this.phaseStartedAtMs });
  }

  /** Advance simulation by dt seconds. Returns events emitted during this tick. */
  tick(dtSeconds: number) {
    const before = this.events.length;
    const now = this.now();
    const dt = clamp(dtSeconds, 0, 0.25);

    if (!this.started && this.countdownStarted && now >= this.startAtMs) this.begin();
    if (this.roundResetAt && now >= this.roundResetAt && !this.endedAtMs) this.resetRound();
    if (this.rules.roundsToWin && this.rules.roundDurationMs && this.started && !this.endedAtMs && !this.roundResetAt) {
      if (!this.roundStartedAt) this.roundStartedAt = this.phaseStartedAtMs;
      if (now - this.roundStartedAt >= this.rules.roundDurationMs) this.roundTimeout();
    }
    if (this.started && this.endReason === "" && now - this.phaseStartedAtMs >= this.rules.durationMs) {
      const scores = new Map<number, number>();
      for (const c of this.combatants.values()) scores.set(c.team, (scores.get(c.team) || 0) + c.score);
      let winner = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const ranked = this.rules.roundsToWin ? this.roundWins : this.usesTeamScore ? this.teamScores : null;
      if (ranked?.size) winner = Array.from(ranked.entries()).sort((a, b) => b[1] - a[1] || (scores.get(b[0]) || 0) - (scores.get(a[0]) || 0))[0]![0];
      if (this.rules.pveHumanTeam !== undefined) winner = this.rules.pveHumanTeam; // survived the clock
      this.finish(winner, "time_limit");
    }
    // Breach family: once every human is dead nothing is left to watch — retail sends the eliminated player to the
    // end-of-game screen. Finish LOKI_HUMANS_OUT_MS (6 s) after the last human died; bots keep their placements.
    if (this.started && !this.endedAtMs && this.isElimination && process.env.LOKI_END_HUMANS_OUT !== "0") {
      const humans = Array.from(this.combatants.values()).filter((c) => !c.isBot);
      if (humans.length && humans.every((c) => !c.alive)) {
        if (!this.humansOutAt) this.humansOutAt = now;
        else if (now - this.humansOutAt >= Number(process.env.LOKI_HUMANS_OUT_MS || 6000)) {
          const alive = new Map<number, number>();
          for (const c of this.combatants.values()) if (c.alive) alive.set(c.team, (alive.get(c.team) || 0) + 1);
          const w = Array.from(alive.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
          this.finish(w, "humans_out");
        }
      } else this.humansOutAt = 0;
    }

    const zone = this.currentZone();
    if (zone.radius < this.lastZoneRadius - 200) {
      this.lastZoneRadius = zone.radius;
      const milestone = Math.ceil(zone.radius / 1000);
      if (!this.zoneAnnounced.includes(milestone)) {
        this.zoneAnnounced.push(milestone);
        this.emit({ t: now, type: "zone", radius: zone.radius, dps: zone.dps });
      }
    }

    if (this.objective && this.started && !this.endedAtMs) {
      this.objective.tick(dt);
      if (this.endedAtMs) return this.events.slice(before);
    }

    for (const c of this.combatants.values()) {
      if (!c.alive) {
        if (this.rules.respawnMs >= 0 && now >= c.respawnAtMs) this.respawn(c);
        continue;
      }
      if (!isHero(c)) continue; // towers / cores / minions: driven and damaged by the objective (objectives.ts)
      if (c.isBot) this.botThink(c);
      if (!this.started) continue;
      this.move(c, dt);
      c.mana = Math.min(c.maxMana, c.mana + this.rules.manaRegenPerSec * dt);

      if (c.input.fire && now - c.lastFireMs >= this.rules.shot.cooldownMs) {
        c.lastFireMs = now;
        const def = this.rules.abilities[0];
        const targets = this.targetsInCone(c, this.rules.shot.range, 0);
        if (targets[0]) {
          const spread = (this.rng() - 0.5) * this.rules.shot.spreadDeg * 2;
          const hit = c.isBot ? this.rng() < this.botHitChance(c, targets[0]) : Math.abs(spread) < 2.1;
          if (hit) this.applyDamage(c, targets[0], def?.damage || this.rules.shot.damage, "primary");
        }
      }

      if (this.rules.zone.enabled && zone.dps > 0) {
        const dist = Math.hypot(c.x - zone.centerX, c.y - zone.centerY);
        // The storm is sim-only (no client storm actor is replicated yet), so a human outside it saw full HP while the server
        // killed them and then refused every action (2026-11-25 21:21 SGT live run). Humans take zone damage only on opt-in.
        const visible = this.zoneOverride !== null && process.env.LOKI_ZONE_HITS_HUMANS !== "0";
        if (dist > zone.radius && (c.isBot || ZONE_HITS_HUMANS || visible)) this.applyDamage(null, c, zone.dps * dt, "zone");
      }

      if (this.rules.scoreLimit > 0 && c.score >= this.rules.scoreLimit) {
        this.finish(c.team, "score_limit");
        break;
      }
    }
    return this.events.slice(before);
  }

  private move(c: Combatant, dt: number) {
    // Real clients drive their own hero (CharacterMovement prediction); the sim only follows.
    if (this.clientDriven.has(c.id) && this.now() - c.lastInputMs < 1000) return;
    const rad = (c.yaw * Math.PI) / 180;
    const fx = Math.cos(rad), fy = Math.sin(rad);
    const rx = -fy, ry = fx;
    const wishX = fx * c.input.my + rx * c.input.mx;
    const wishY = fy * c.input.my + ry * c.input.mx;
    const len = Math.hypot(wishX, wishY) || 1;
    const speed = this.rules.moveSpeed * (c.input.sprint ? this.rules.sprintMultiplier : 1);
    const targetVx = (wishX / len) * speed;
    const targetVy = (wishY / len) * speed;
    const accel = this.rules.acceleration * dt;
    c.vx += clamp(targetVx - c.vx, -accel, accel);
    c.vy += clamp(targetVy - c.vy, -accel, accel);
    if (!c.input.mx && !c.input.my) {
      const friction = this.rules.friction * dt;
      const mag = Math.hypot(c.vx, c.vy);
      const next = Math.max(0, mag - friction);
      if (mag > 0) { c.vx = (c.vx / mag) * next; c.vy = (c.vy / mag) * next; }
    }
    if (c.input.jump && c.grounded) {
      c.vz = this.rules.jumpSpeed;
      c.grounded = false;
    }
    c.vz -= this.rules.gravity * dt;
    const nx = c.x + c.vx * dt, ny = c.y + c.vy * dt;
    const g0 = this.floorAt?.(c.x, c.y) ?? null;
    if (this.floorAt && g0 === null && c.isBot) {
      // mid-glide over open sky: keep height, keep going, land on the next island
      c.x = nx; c.y = ny; c.vz = 0; c.grounded = false;
      return;
    }
    if (this.floorAt && g0 !== null) {
      // walk on real terrain: never step over open sky or up a wall taller than a step
      const g1 = this.floorAt(nx, ny);
      // travelling bots (sprint = roaming/rotating) glide across sky gaps like a player would; fighting bots stop at the edge
      const fighting = this.brains.get(c.id)?.state === "fight";
      const step = Number(process.env.LOKI_BOT_STEP || 140);
      // storm rotation climbs (players jump/glide up ledges); everyone else respects the step height
      const rotating = this.brains.get(c.id)?.state === "rotate";
      const blocked = (g: number | null) => g === null ? fighting : !rotating && g - g0 > step;
      if (!blocked(g1)) { c.x = nx; c.y = ny; }
      else {
        // slide along the obstacle: try each axis, then the two 45° deflections, before stopping
        const sp = Math.hypot(c.vx, c.vy) * dt;
        const cands: [number, number][] = [[nx, c.y], [c.x, ny]];
        const h = Math.atan2(c.vy, c.vx);
        for (const d of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) cands.push([c.x + Math.cos(h + d) * sp, c.y + Math.sin(h + d) * sp]);
        const ok = cands.find(([x, y]) => !blocked(this.floorAt!(x, y)));
        if (ok) { c.vx = (ok[0] - c.x) / Math.max(dt, 1e-3); c.vy = (ok[1] - c.y) / Math.max(dt, 1e-3); c.x = ok[0]; c.y = ok[1]; }
        else { c.vx = 0; c.vy = 0; }
      }
      const ground = (this.floorAt(c.x, c.y) ?? g0) + CAPSULE_HALF;
      c.z += c.vz * dt;
      if (c.z <= ground) { c.z = ground; c.vz = 0; c.grounded = true; }
      return;
    }
    c.x = nx; c.y = ny;
    c.z += c.vz * dt;
    if (c.z <= this.rules.eyeHeight) {
      c.z = this.rules.eyeHeight;
      c.vz = 0;
      c.grounded = true;
    }
  }

  private botAggroAt = new Map<string, number>();
  private botHome = new Map<string, { ox: number; oy: number; wanderMs: number; tx: number; ty: number; pauseUntil?: number }>();
  private brains = new Map<string, BotBrain>();

  private brain(c: Combatant): BotBrain {
    let b = this.brains.get(c.id);
    if (!b) {
      const skill = BOT_SKILL_MIN + this.rng() * (BOT_SKILL_MAX - BOT_SKILL_MIN);
      const hero = c.heroId.replace(/^Hero:/, "");
      b = {
        skill,
        reactionMs: 520 - skill * 380,
        preferRange: MELEE_HEROES.has(hero) ? 220 : LONG_HEROES.has(hero) ? 1300 : 800,
        bravery: 0.25 + this.rng() * 0.5,
        state: "roam", targetId: "", seenAtMs: 0, lastHp: c.hp, strafeDir: this.rng() < 0.5 ? 1 : -1,
        strafeFlipMs: 0, retreatUntil: 0, stuckMs: 0, lastX: c.x, lastY: c.y, nextThinkMs: 0, stuckHits: [], airMs: 0, sampleAt: 0,
      };
      this.brains.set(c.id, b);
    }
    return b;
  }

  /** Terrain under (x, y) or null over open sky (only maps with collision data). */
  private ground(x: number, y: number): number | null { return this.floorAt ? this.floorAt(x, y) : null; }

  private faceToward(c: Combatant, x: number, y: number, maxTurn: number) {
    const yaw = (Math.atan2(y - c.y, x - c.x) * 180) / Math.PI;
    c.yaw += clamp(((yaw - c.yaw + 540) % 360) - 180, -maxTurn, maxTurn);
  }

  /** Point to roam to: inside the safe zone, near team mates, never over open sky. */
  private botWander(c: Combatant, b?: BotBrain) {
    const now = this.now();
    let h = this.botHome.get(c.id);
    if (!h) { h = { ox: c.x, oy: c.y, wanderMs: 0, tx: c.x, ty: c.y }; this.botHome.set(c.id, h); }
    const zone = this.currentZone();
    const k = this.rules.zone.enabled ? Math.min(1, zone.radius / Math.max(1, this.rules.zone.startRadius)) : 1;
    const mates = this.all().filter((m) => m.alive && m.team === c.team && m !== c);
    if (now >= h.wanderMs || Math.hypot(h.tx - c.x, h.ty - c.y) < 150) {
      for (let tries = 0; tries < 8; tries++) {
        let tx: number, ty: number;
        const mate = mates.find((m) => Math.hypot(m.x - c.x, m.y - c.y) > 900);
        if (mate && this.rng() < 0.7) {
          // regroup only when separated; otherwise roam together toward a shared point (no orbiting each other)
          const a = this.rng() * Math.PI * 2;
          tx = mate.x + Math.cos(a) * 250; ty = mate.y + Math.sin(a) * 250;
        } else {
          const hx = zone.centerX + (h.ox - zone.centerX) * k, hy = zone.centerY + (h.oy - zone.centerY) * k;
          const a = this.rng() * Math.PI * 2, r = 800 + this.rng() * 1800 * Math.max(0.3, k);
          tx = hx + Math.cos(a) * r; ty = hy + Math.sin(a) * r;
          if (Math.hypot(tx - c.x, ty - c.y) < 800) continue;
        }
        if (this.rules.zone.enabled && Math.hypot(tx - zone.centerX, ty - zone.centerY) > zone.radius * 0.85) continue;
        if (this.floorAt && this.ground(tx, ty) === null) continue;
        h.tx = tx; h.ty = ty; break;
      }
      h.wanderMs = now + 8000 + this.rng() * 7000;
    }
    // arrived: idle a moment (look around) instead of immediately turning to a new point
    if (Math.hypot(h.tx - c.x, h.ty - c.y) < 200) {
      if (!h.pauseUntil) h.pauseUntil = now + 1500 + this.rng() * 3500;
      if (now < h.pauseUntil) { c.input = { mx: 0, my: 0, yaw: c.yaw, pitch: 0, fire: false, sprint: false, jump: false }; if (b) b.state = "roam"; return; }
      h.pauseUntil = 0; h.wanderMs = 0;
    }
    this.faceToward(c, h.tx, h.ty, 8);
    const far = Math.hypot(h.tx - c.x, h.ty - c.y) > 1500;
    c.input = { mx: 0, my: 1, yaw: c.yaw, pitch: 0, fire: false, sprint: far, jump: false };
    if (b) b.state = "roam";
  }

  private canTarget(c: Combatant, e: Combatant, now: number) {
    if (!e.alive || e.team === c.team) return false;
    // grace counts from the start of the current round too (round modes), not only the match
    const since = Math.max(this.phaseStartedAtMs, this.roundStartedAt || 0);
    if (this.botGraceMs < 0 || now - since < this.botGraceMs) return false;
    if (!isHero(e)) return !this.objective || this.objective.canDamage(c, e);
    if (!e.isBot) return BOTS_HIT_HUMANS;
    // bot vs bot fights are paced: both sides must be past their aggro time, unless one is already shooting the other
    const provoked = c.recentDamage.some((d) => d.by === e.id && now - d.atMs < 6000);
    return provoked || (now >= (this.botAggroAt.get(c.id) ?? Infinity) && now >= (this.botAggroAt.get(e.id) ?? Infinity));
  }

  private pickTarget(c: Combatant, b: BotBrain, now: number): Combatant | undefined {
    const sight = BOT_SIGHT * (0.7 + b.skill * 0.5);
    let best: Combatant | undefined, bestScore = -Infinity;
    const mateTargets = new Set(this.all().filter((m) => m.isBot && m.team === c.team && m !== c).map((m) => this.brains.get(m.id)?.targetId));
    for (const e of this.combatants.values()) {
      if (!this.canTarget(c, e, now)) continue;
      const d = Math.hypot(e.x - c.x, e.y - c.y);
      const attacker = c.recentDamage.some((r) => r.by === e.id && now - r.atMs < 5000);
      if (d > sight && !attacker) continue;
      let score = -d / 400;
      score += (1 - e.hp / Math.max(1, e.maxHp)) * 4;           // finish the weak
      if (attacker) score += 5;                                   // answer whoever is shooting
      if (mateTargets.has(e.id)) score += 3;                      // focus fire with the squad
      if (e.id === b.targetId) score += 2;                        // stick to the current target
      if (!e.isBot) score += BOT_HUMAN_BIAS;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  private useAbilities(c: Combatant, b: BotBrain, target: Combatant, dist: number, now: number) {
    const ready = (id: string) => {
      const a = this.rules.abilities.find((x) => x.id === id);
      return a && now >= (c.cooldowns[id] || 0) && c.mana >= a.manaCost ? a : undefined;
    };
    const hpFrac = c.hp / Math.max(1, c.maxHp);
    if (hpFrac < 0.5 && ready("mend")) { this.requestAbility(c.id, "mend"); return; }
    if (this.rng() > 0.25 + b.skill * 0.55) return;              // weaker bots hesitate
    const nearby = this.all().filter((e) => e.alive && e.team !== c.team && Math.hypot(e.x - c.x, e.y - c.y) < 1100).length;
    if (!target.isBot) {
      // vs a human: single-target only (an invisible AoE nuke reads as a random death)
      const bolt = ready("bolt");
      if (bolt && dist <= bolt.range && this.rng() < 0.5) this.requestAbility(c.id, "bolt");
      return;
    }
    const barrage = ready("barrage");
    if (barrage && dist <= barrage.range && (nearby >= 2 || target.hp < barrage.damage * 1.3)) { this.requestAbility(c.id, "barrage"); return; }
    const nova = ready("nova");
    if (nova && dist <= nova.radius * 0.9) { this.requestAbility(c.id, "nova"); return; }
    const bolt = ready("bolt");
    if (bolt && dist <= bolt.range && Math.abs(((Math.atan2(target.y - c.y, target.x - c.x) * 180 / Math.PI) - c.yaw + 540) % 360 - 180) < 12) { this.requestAbility(c.id, "bolt"); return; }
    const dash = ready("dash");
    if (dash && b.state === "fight" && dist > b.preferRange + 900 && dist < 2600) { this.requestAbility(c.id, "dash"); return; }
  }

  private botThink(c: Combatant) {
    const now = this.now();
    if (!this.botAggroAt.has(c.id)) this.botAggroAt.set(c.id, this.botGraceMs < 0 ? Infinity : Math.max(this.phaseStartedAtMs, this.roundStartedAt || 0) + this.botGraceMs + this.rng() * (this.rules.botAggroSpreadMs ?? BOT_AGGRO_SPREAD_MS));
    const b = this.brain(c);
    if (!this.started) { c.input = { mx: 0, my: 0, yaw: c.yaw, pitch: 0, fire: false, sprint: false, jump: false }; return; }
    const zone = this.currentZone();
    const outZone = this.rules.zone.enabled && Math.hypot(c.x - zone.centerX, c.y - zone.centerY) > zone.radius * 0.82;

    // unstick: barely moved for 1.5 s while trying to move -> new wander point / jump
    // stall check on 500 ms windows: trying to move but covered < 60 uu (walk speed covers ~230)
    if (now - b.sampleAt >= 500) {
      const moved = Math.hypot(c.x - b.lastX, c.y - b.lastY);
      if (moved < 60 && (c.input.mx || c.input.my) && b.state !== "fight") b.stuckMs += now - b.sampleAt; else b.stuckMs = 0;
      b.lastX = c.x; b.lastY = c.y; b.sampleAt = now;
    }
    if (b.stuckMs > 1500) {
      b.stuckMs = 0; b.strafeDir *= -1; const h = this.botHome.get(c.id); if (h) h.wanderMs = 0; c.input.jump = true;
      b.stuckHits = b.stuckHits.filter((t) => now - t < 10_000); b.stuckHits.push(now);
      // three stalls in 10 s: hop to open terrain nearby instead of grinding on the same wall
      if (b.stuckHits.length >= 3) { b.stuckHits = []; this.relocateBot(c, 450, "wedged"); }
    }
    // gliding over open sky too long (no island ahead): land on the nearest terrain
    if (this.floorAt) {
      if (this.ground(c.x, c.y) === null) { b.airMs += 1000 / 30; if (b.airMs > BOT_MAX_GLIDE_MS) { b.airMs = 0; this.relocateBot(c, 0, "glide"); } }
      else b.airMs = 0;
    }

    if (now >= b.nextThinkMs) {
      b.nextThinkMs = now + 150 + (1 - b.skill) * 200;
      const t = this.pickTarget(c, b, now);
      if (t && t.id !== b.targetId) { b.targetId = t.id; b.seenAtMs = now; }
      if (!t) b.targetId = "";
    }
    // objective: forced target (enemy carrier, tower, wave target) once the bot may fight at all
    const goal = this.objective?.botGoal(c) ?? null;
    if (goal?.targetId && this.botGraceMs >= 0 && now - Math.max(this.phaseStartedAtMs, this.roundStartedAt || 0) >= this.botGraceMs) {
      const forced = this.combatants.get(goal.targetId);
      if (forced?.alive && forced.id !== b.targetId) { b.targetId = forced.id; b.seenAtMs = now; }
    }
    let target = b.targetId ? this.combatants.get(b.targetId) : undefined;
    // leash: an objective bot drops a fight that would drag it away from its objective
    if (goal && target && target.id !== goal.targetId && Math.hypot(target.x - goal.x, target.y - goal.y) > (goal.leash ?? 2000)) { b.targetId = ""; target = undefined; }
    const hpFrac = c.hp / Math.max(1, c.maxHp);
    if (goal && now >= b.retreatUntil) {
      const gd = Math.hypot(goal.x - c.x, goal.y - c.y);
      const tdist = target?.alive ? Math.hypot(target.x - c.x, target.y - c.y) : Infinity;
      const onTarget = !!goal.targetId && target?.id === goal.targetId;
      // walk the objective unless a fight is right here: a forced target is fought once in range, an urgent run
      // (ball / prisma carrier) never stops to fight, anything else stops when an enemy is close
      const fightHere = onTarget ? tdist <= b.preferRange + 150 : goal.urgent ? false : tdist <= b.preferRange + 600;
      if (gd > goal.radius && !fightHere) {
        this.faceToward(c, goal.x, goal.y, 40);
        const canShoot = !!target?.alive && tdist < this.rules.shot.range && now - b.seenAtMs >= b.reactionMs;
        c.input = { mx: 0, my: 1, yaw: c.yaw, pitch: 0, fire: canShoot && !goal.urgent, sprint: gd > 1200 && !goal.noSprint, jump: false };
        b.state = "roam";
        return;
      }
      if (!target || !target.alive) {
        // on the objective with nobody to fight: hold, drift a little so it reads as guarding
        if (now >= b.strafeFlipMs) { b.strafeDir = -b.strafeDir; b.strafeFlipMs = now + 900 + this.rng() * 1600; }
        this.faceToward(c, goal.x + Math.cos(now / 1500) * 400, goal.y + Math.sin(now / 1500) * 400, 6);
        c.input = { mx: b.strafeDir * 0.35, my: gd > goal.radius * 0.5 ? 0.6 : 0, yaw: c.yaw, pitch: 0, fire: false, sprint: false, jump: false };
        b.state = "roam";
        return;
      }
    }

    if (outZone && (!target || hpFrac < 0.6)) {
      this.faceToward(c, zone.centerX, zone.centerY, 120);
      c.input = { mx: 0, my: 1, yaw: c.yaw, pitch: 0, fire: false, sprint: true, jump: false };
      b.state = "rotate"; return;
    }
    if (!target || !target.alive) { this.botWander(c, b); return; }

    const dx = target.x - c.x, dy = target.y - c.y;
    const dist = Math.hypot(dx, dy);
    const enemyHpFrac = target.hp / Math.max(1, target.maxHp);
    const outnumbered = this.all().filter((e) => e.alive && e.team !== c.team && Math.hypot(e.x - c.x, e.y - c.y) < 1500).length
      > this.all().filter((m) => m.alive && m.team === c.team && Math.hypot(m.x - c.x, m.y - c.y) < 1500).length;
    if (b.state !== "retreat" && hpFrac < 0.25 + (1 - b.bravery) * 0.2 && (enemyHpFrac > hpFrac || outnumbered)) b.retreatUntil = now + 3500 + this.rng() * 2500;

    if (now < b.retreatUntil) {
      b.state = "retreat";
      this.faceToward(c, c.x - dx, c.y - dy, 200);
      c.input = { mx: b.strafeDir * 0.4, my: 1, yaw: c.yaw, pitch: 0, fire: false, sprint: true, jump: false };
      const dash = this.rules.abilities.find((a) => a.id === "dash");
      if (dash && dist < 900 && now >= (c.cooldowns.dash || 0) && c.mana >= dash.manaCost) this.requestAbility(c.id, "dash");
      if (hpFrac < 0.5 && now >= (c.cooldowns.mend || 0)) this.requestAbility(c.id, "mend");
      return;
    }

    b.state = "fight";
    // aim: turn rate and lead scale with skill
    const lead = 0.15 + b.skill * 0.25;
    this.faceToward(c, target.x + target.vx * lead, target.y + target.vy * lead, 15 + b.skill * 15);
    c.pitch = clamp(Math.atan2(target.z - c.z, Math.max(1, dist)) * (180 / Math.PI), -60, 60);
    if (now >= b.strafeFlipMs) { b.strafeDir = this.rng() < 0.6 ? -b.strafeDir : b.strafeDir; b.strafeFlipMs = now + 500 + this.rng() * 1400 * (1.2 - b.skill); }
    const want = b.preferRange;
    let my = dist > want + 250 ? 1 : dist < want - 200 ? -0.7 : 0;
    // strafing reads as walking in circles when the bot's attacks are invisible: vs humans close in and hold
    let mx = target.isBot ? b.strafeDir * (0.4 + b.skill * 0.5) : (dist < want + 150 && this.rng() < 0.02 ? b.strafeDir * 0.6 : 0);
    // don't strafe or back off the edge of the island
    if (this.floorAt) {
      const rad = (c.yaw * Math.PI) / 180, fx = Math.cos(rad), fy = Math.sin(rad);
      const px = c.x + (fx * my - fy * mx) * 250, py = c.y + (fy * my + fx * mx) * 250;
      if (this.ground(px, py) === null) { mx = -mx; b.strafeDir = -b.strafeDir; if (my < 0) my = 0; }
    }
    const reacted = now - b.seenAtMs >= b.reactionMs;
    c.input = { mx, my, yaw: c.yaw, pitch: c.pitch, fire: reacted && dist < this.rules.shot.range, sprint: dist > 2200, jump: this.rng() < 0.004 };
    if (reacted) this.useAbilities(c, b, target, dist, now);
  }

  /** Move a bot to open terrain: the closest ground point on rings from minR outward (toward the zone centre
   *  first), else a random floor spawn. Used when a bot is wedged or has glided too long over open sky. */
  private relocateBot(c: Combatant, minR: number, why = "") {
    const zone = this.currentZone();
    const toCentre = Math.atan2(zone.centerY - c.y, zone.centerX - c.x);
    for (let r = Math.max(200, minR); r <= 8000; r += 300) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / 400));
      for (let i = 0; i < steps; i++) {
        const a = toCentre + ((i % 2 ? 1 : -1) * Math.ceil(i / 2) * 2 * Math.PI) / steps;
        const px = c.x + Math.cos(a) * r, py = c.y + Math.sin(a) * r;
        const g = this.ground(px, py);
        if (g !== null && (!this.rules.zone.enabled || Math.hypot(px - zone.centerX, py - zone.centerY) < zone.radius)) {
          c.x = px; c.y = py; c.z = g + CAPSULE_HALF; c.vx = c.vy = c.vz = 0; c.grounded = true;
          // re-home here so the bot stops walking back into the same pocket
          const h = this.botHome.get(c.id); if (h) { h.ox = px; h.oy = py; h.wanderMs = 0; }
          this.emit({ t: this.now(), type: "unstick", id: c.id, x: px, y: py, z: c.z, why });
          return;
        }
      }
    }
    const pts = this.spawnPoints?.() || [];
    if (pts.length) { const p = pts[Math.floor(this.rng() * pts.length)]!; c.x = p[0]!; c.y = p[1]!; c.z = (p[2] ?? 0) + CAPSULE_HALF; c.vx = c.vy = c.vz = 0; }
  }

  /** Bot primary-fire hit chance: skill, distance and the target's lateral speed (retail bots miss too). */
  private botHitChance(c: Combatant, target: Combatant) {
    const b = this.brains.get(c.id); if (!b) return 0.8;
    const d = Math.hypot(target.x - c.x, target.y - c.y);
    const speed = Math.hypot(target.vx, target.vy);
    return clamp(0.35 + b.skill * 0.55 - (d / this.rules.shot.range) * 0.25 - (speed / 900) * 0.2, 0.08, 0.92);
  }

  private respawn(c: Combatant, hpScale?: number) {
    const pts = this.spawnPoints?.() || [];
    const op = this.objective?.spawnPos(c);
    if (op) {
      c.x = op[0]; c.y = op[1]; c.z = op[2];
    } else if (pts.length) {
      const p = pts[Math.floor(this.rng() * pts.length)]!;
      c.x = p[0]!; c.y = p[1]!; c.z = (p[2] ?? 0) + 90;
    } else {
      const angle = this.rng() * Math.PI * 2;
      const radius = this.rules.spawnRadius * (0.5 + this.rng() * 0.5);
      c.x = Math.cos(angle) * radius;
      c.y = Math.sin(angle) * radius;
      c.z = this.rules.eyeHeight;
    }
    c.vx = c.vy = c.vz = 0;
    if (hpScale !== undefined && isHero(c)) {
      const base = HERO_HP[c.heroId.replace(/^Hero:/, "")] ?? this.rules.hp;
      c.maxHp = Math.max(1, Math.round(base * hpScale));
    }
    c.hp = c.maxHp; c.shield = isHero(c) ? c.maxShield : 0; c.mana = c.maxMana;
    c.alive = true; c.grounded = true; c.respawnAtMs = 0;
    c.cooldowns = {}; c.recentDamage = [];
    this.brains.delete(c.id); this.botHome.delete(c.id);
    if (this.rules.spawnInvulnMs) this.invulnUntil.set(c.id, this.now() + this.rules.spawnInvulnMs);
    this.emit({ t: this.now(), type: "respawn", id: c.id, x: c.x, y: c.y, z: c.z });
  }

  // ---- per-mode state (modeconfig.ts MODE_PROFILES); untouched in Breach
  private teamScores = new Map<number, number>();
  private roundWins = new Map<number, number>();
  private round = 1;
  private roundResetAt = 0;
  private invulnUntil = new Map<string, number>();

  private roundStartedAt = 0;

  // ---- mode objectives (objectives.ts). null in Breach and in the kill/round modes.
  private objective: Objective | null = null;
  private get usesTeamScore() { return !!(this.rules.teamScorePerKill || this.rules.objective); }
  /** The live objective (created on first use so a human anchoring during the countdown already places it). */
  objectiveState() { return this.objective?.state() ?? null; }
  objectiveCarried(id: string) { return this.objective?.kind === "bank" ? this.objective.carriedBy(id) : 0; }

  private ensureObjective(): Objective | null {
    if (!this.rules.objective || process.env.LOKI_OBJECTIVES === "0") return null;
    if (this.objective) return this.objective;
    this.objective = new Objective(this.rules.objective, {
      now: () => this.now(),
      rng: () => this.rng(),
      all: () => this.all(),
      teamCount: () => (this.rules.soloTeams ? 1 : Math.max(1, this.rules.teamCount)),
      addEntity: (id, name, team, kind, heroId, hp, x, y, z, held) => {
        const c = this.makeCombatantAt(id, name, team, heroId, true, this.combatants.size, x, y, z + CAPSULE_HALF);
        c.kind = kind; c.maxHp = hp; c.hp = held ? 0 : hp; c.shield = 0; c.maxShield = 0;
        if (held) { c.alive = false; c.respawnAtMs = Infinity; }
        this.combatants.set(id, c);
        this.emit({ t: this.now(), type: "player_joined", id, name, team, isBot: true });
        return c;
      },
      damage: (source, target, amount, ability) => this.applyDamage(source, target, amount, ability),
      revive: (c, hpScale) => this.respawn(c, hpScale),
      provoke: (c) => { this.botAggroAt.set(c.id, this.now()); },
      getScore: (team) => this.teamScores.get(team) || 0,
      setScore: (team, score, reason) => {
        this.teamScores.set(team, score);
        this.emit({ t: this.now(), type: "team_score", team, score, scores: Object.fromEntries(this.teamScores), reason });
      },
      finish: (winner, reason) => this.finish(winner, reason),
      log: (what, team, detail) => this.emit({ t: this.now(), type: "objective", what, team, detail }),
      eyeHeight: () => this.rules.eyeHeight,
    });
    return this.objective;
  }

  private endRound(winner: number | null, reason: string) {
    if (winner !== null) this.roundWins.set(winner, (this.roundWins.get(winner) || 0) + 1);
    this.emit({ t: this.now(), type: "round_end", round: this.round, winner, wins: Object.fromEntries(this.roundWins) });
    if (winner !== null && (this.roundWins.get(winner) || 0) >= (this.rules.roundsToWin || 1)) { this.finish(winner, `${reason}_rounds`); return; }
    this.roundResetAt = this.now() + Math.max(0, this.rules.roundIntermissionMs ?? 6000);
  }

  /** Round timer ran out: most players alive, then most total HP, takes it. */
  private roundTimeout() {
    const byTeam = new Map<number, { alive: number; hp: number }>();
    for (const c of this.combatants.values()) {
      const e = byTeam.get(c.team) || { alive: 0, hp: 0 };
      if (c.alive) { e.alive++; e.hp += c.hp + c.shield; }
      byTeam.set(c.team, e);
    }
    const best = [...byTeam.entries()].sort((a, b) => b[1].alive - a[1].alive || b[1].hp - a[1].hp)[0];
    this.endRound(best && best[1].alive > 0 ? best[0] : null, "round_timer");
  }

  /** Next round of a round mode: everyone back to full and onto a spawn (emits respawn per combatant). */
  private resetRound() {
    this.roundResetAt = 0;
    this.round++;
    this.roundStartedAt = this.now();
    this.botAggroAt.clear(); this.brains.clear();
    for (const c of this.combatants.values()) this.respawn(c);
    this.emit({ t: this.now(), type: "round_start", round: this.round });
  }

  /** Applies a mode profile's rules before the match starts (server.ts applyModeProfile). Returns false once started. */
  configureMode(overrides: Partial<MatchRules>, gameModeType?: number): boolean {
    if (this.started || this.endedAtMs) return false;
    const { zone, shot, ...rest } = overrides;
    Object.assign(this.rules, rest);
    if (zone) Object.assign(this.rules.zone, zone);
    if (shot) Object.assign(this.rules.shot, shot);
    if (gameModeType !== undefined) this.gameModeTypeCode = gameModeType;
    this.objective = null;
    this.lastZoneRadius = this.rules.zone.startRadius;
    if (this.countdownStarted) this.startAtMs = this.now() + this.rules.countdownMs;
    return true;
  }

  private get botGraceMs() { return this.rules.botGraceMs ?? BOT_GRACE_MS; }

  currentZone() {
    const o = this.zoneOverride?.();
    if (o) return o;
    const z = this.rules.zone;
    const t = this.phaseRaw === "waiting" || !this.started
      ? 0
      : clamp((this.now() - this.phaseStartedAtMs - z.shrinkStartMs) / Math.max(1, z.shrinkEndMs - z.shrinkStartMs), 0, 1);
    return {
      radius: z.enabled ? z.startRadius + (z.endRadius - z.startRadius) * t : z.startRadius,
      centerX: 0, centerY: 0,
      dps: t > 0 && z.enabled ? z.dps * (1 + t * 2) : 0,
    };
  }

  get result() {
    const rows = Array.from(this.combatants.values())
      .sort((a, b) => (b.score - a.score) || (b.kills - a.kills) || (a.deaths - b.deaths));
    return {
      matchId: this.matchId,
      winner: this.winner,
      reason: this.endReason,
      durationMs: this.endedAtMs ? this.endedAtMs - this.phaseStartedAtMs : 0,
      results: rows.filter((c) => !c.isBot).map((c, index) => ({
        userId: c.id,
        placement: this.isElimination && this.endedAtMs ? this.teamPlacement(c.team) : this.scorePlacement(c.team),
        won: this.winner === null ? index === 0 && this.scorePlacement(c.team) === 1 : c.team === this.winner,
        kills: c.kills, deaths: c.deaths, assists: c.assists, score: c.score,
        heroId: c.heroId,
        knockouts: c.kills,
        damageDealt: Math.round(c.damageDealt),
        damageTaken: Math.round(c.damageTaken),
        survivalSeconds: Math.max(0, Math.round((((this.teamOutAt.get(c.team) ?? this.endedAtMs) || this.now()) - this.phaseStartedAtMs) / 1000)),
        durationSeconds: Math.max(0, Math.round(((this.endedAtMs || this.now()) - this.phaseStartedAtMs) / 1000)),
        mode: this.rules.mode,
        humans: Array.from(this.combatants.values()).filter((o) => !o.isBot).length,
        MatchStats: {
          Kills: c.kills, Deaths: c.deaths, Assists: c.assists,
          DamageDone: Math.round(c.damageDealt), DamageTaken: Math.round(c.damageTaken),
        },
      })),
    };
  }

  getSnapshot(): MatchSnapshot {
    const combatants = Array.from(this.combatants.values());
    return {
      matchId: this.matchId,
      phase: this.phaseRaw,
      roundPhase: this.roundPhase,
      roundPhaseCode: ROUND_PHASE_CODE[this.roundPhase],
      gameModeType: this.gameModeTypeCode ?? 0,
      mode: this.rules.mode,
      elapsedMs: this.started ? this.now() - this.phaseStartedAtMs : 0,
      remainingMs: Math.max(0, this.rules.durationMs - (this.started ? this.now() - this.phaseStartedAtMs : 0)),
      countdownMs: Math.max(0, this.startAtMs - this.now()),
      zone: this.currentZone(),
      winner: this.winner,
      endReason: this.endReason,
      combatants,
      leaderboard: combatants
        .slice()
        .sort((a, b) => b.score - a.score || b.kills - a.kills)
        .map((c) => ({ id: c.id, name: c.name, team: c.team, kills: c.kills, deaths: c.deaths, assists: c.assists, score: c.score, alive: c.alive, isBot: c.isBot })),
      playersAlive: combatants.filter((c) => !c.isBot && c.alive).length,
      botsAlive: combatants.filter((c) => c.isBot && c.alive).length,
      ...(this.usesTeamScore ? { teamScores: Object.fromEntries(this.teamScores) } : {}),
      ...(this.objective ? { objective: this.objective.state() } : {}),
      ...(this.rules.roundsToWin ? { round: this.round, roundWins: Object.fromEntries(this.roundWins) } : {}),
    };
  }

  getEvents(limit = 100): MatchEvent[] { return this.events.slice(-limit); }

  // ---- world loot (server/ue/loot.ts) credits. Appended for the loot feature; touches no bot / respawn code.
  private lootGold = new Map<string, number>();
  /** Add looted gold to a combatant's match purse; returns the new total. */
  grantLootGold(id: string, amount: number): number {
    const total = (this.lootGold.get(id) ?? 0) + Math.max(0, Math.floor(amount));
    this.lootGold.set(id, total);
    return total;
  }
  lootGoldOf(id: string): number { return this.lootGold.get(id) ?? 0; }
  /** Equip looted armor: shield capacity becomes at least `shield` and is refilled. Returns the new shield, or null (unknown/dead). */
  grantLootArmor(id: string, shield: number): number | null {
    const c = this.combatants.get(id);
    if (!c || !c.alive) return null;
    c.maxShield = Math.max(c.maxShield, shield);
    c.shield = c.maxShield;
    return c.shield;
  }
  // ---- [interact] shop (server/ue/interact.ts): spend from the same purse, consumable effects.
  /** Spend from the purse; returns what is left, or null when it does not cover the amount. */
  spendLootGold(id: string, amount: number): number | null {
    const have = this.lootGold.get(id) ?? 0, cost = Math.max(0, Math.floor(amount));
    if (have < cost) return null;
    this.lootGold.set(id, have - cost);
    return have - cost;
  }
  /** Heal (bandage) / refill shield (armor repair); returns the new [hp, shield], or null (unknown/dead). */
  lootHeal(id: string, hp: number, refillShield = false): [number, number] | null {
    const c = this.combatants.get(id);
    if (!c || !c.alive) return null;
    c.hp = Math.min(c.maxHp, c.hp + Math.max(0, hp));
    if (refillShield) c.shield = c.maxShield;
    return [c.hp, c.shield];
  }
  // ---- [armory] in-match armory buys (server/ue/armory.ts): sim stand-in for the equipment item we cannot grant on the wire yet.
  /** Raise max HP by `hp` and heal by the same amount; returns the new [hp, maxHp], or null (unknown/dead). Kept across respawns. */
  grantMaxHp(id: string, hp: number): [number, number] | null {
    const c = this.combatants.get(id);
    if (!c || !c.alive) return null;
    const add = Math.max(0, Math.floor(hp));
    c.maxHp += add;
    c.hp = Math.min(c.maxHp, c.hp + add);
    return [c.hp, c.maxHp];
  }
}
