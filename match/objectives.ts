// Objective systems for the non-Breach modes (2026-11-26). Before this, every one of them scored kills only.
//
// Pure: no sockets, no clock reads — MatchWorld (match.ts) owns one Objective per match and drives it through
// ObjectiveHost. Each objective is the mode's real win condition run server-side, scored into the GameState
// TeamScores the client HUD already reads:
//   capture  — Domination: 3 capture points, held points tick score
//   conquest — Battlefield: 5 points + kill points
//   tug      — Tug of War: one point the majority pushes into the enemy end
//   bank     — Prisma Bank: carry prisma (kills, mines, drops) home and bank it
//   ball     — Soccervive / Grindball: carry the ball into the enemy goal
//   lanes    — Barracuda / Swordfish: outer tower → inner tower → core per team, minion waves
//   waves    — Holdout: escalating PvE waves, respawn between waves, survive N
//
// Evidence: "guess". No retail capture of these modes exists and their maps' level actors (BP_CapturePoint_Domination,
// goals, towers, banks) are in .umap payloads we cannot export, so the layout is ours: team bases sit on a line through
// the map (or a square for 4 teams) and every objective is placed on that line. The layout is anchored on real ground:
// the first human of a team to report Walking moves that team's base onto their feet, and the first anchor also takes
// the human's facing as the axis (arena player starts face the middle). LOKI_OBJ_YAW / LOKI_OBJ_SCALE override.
// Structures, minions and the ball are simulation entities; towers/cores/minions replicate as hero actors (named
// "[TOWER] …" etc.), capture points / the ball / prisma have no actor of their own.

import type { Combatant } from "./match.ts";

export type ObjectiveKind = "capture" | "conquest" | "tug" | "bank" | "ball" | "lanes" | "waves";

export interface ObjectiveSpec {
  kind: ObjectiveKind;
  /** first team to this score wins (capture/conquest/bank/ball); tug and lanes end on their own condition */
  scoreLimit?: number;
  /** distance from the layout centre to each team base (uu) */
  halfLength?: number;
  /** capture/conquest/tug: point radius, seconds for one player to capture, score interval */
  pointRadius?: number;
  captureSec?: number;
  scoreEveryMs?: number;
  /** number of capture points (capture 3, conquest 5) */
  points?: number;
  /** conquest: team points per enemy kill */
  killPoints?: number;
  /** tug: uu/s the point moves with one player of advantage */
  pushSpeed?: number;
  /** bank: mine payout interval / cap of loose prisma at a mine / bank radius */
  mineEveryMs?: number;
  mineCap?: number;
  bankRadius?: number;
  /** ball: goal radius, kickoff delay after a goal */
  goalRadius?: number;
  kickoffMs?: number;
  /** damage a carrier takes before dropping the ball */
  tackleDamage?: number;
  /** waves: allied bots fill the defenders up to this many (solo Holdout gets 3 allies) */
  defenders?: number;
  /** waves: multiplier on wave-enemy damage against defenders */
  enemyDamageScale?: number;
  /** lanes: structure HP, tower range/damage, minion wave cadence and size */
  towerHp?: number;
  coreHp?: number;
  towerRange?: number;
  towerDamage?: number;
  minionEveryMs?: number;
  minionsPerWave?: number;
  minionHp?: number;
  /** waves: waves to survive, intermission, first wave size */
  waves?: number;
  waveIntermissionMs?: number;
  waveBase?: number;
}

export type EntityKind = "hero" | "structure" | "minion";

export interface BotGoal {
  x: number; y: number;
  /** close enough when inside this radius (hold there) */
  radius: number;
  /** attack this combatant (enemy carrier, tower, wave target) */
  targetId?: string;
  /** go even when a fight is near (carrying the ball / prisma home) */
  urgent?: boolean;
  /** fights whose target is farther than this from the goal are dropped (default 2000) */
  leash?: number;
  /** walk, do not sprint (ball carrier) */
  noSprint?: boolean;
}

export interface ObjectiveHost {
  now(): number;
  rng(): number;
  all(): Combatant[];
  teamCount(): number;
  /** add a sim-only entity (structure/minion); `held` = starts dead and is revived by the objective */
  addEntity(id: string, name: string, team: number, kind: EntityKind, heroId: string, hp: number, x: number, y: number, z: number, held?: boolean): Combatant;
  damage(source: Combatant | null, target: Combatant, amount: number, ability: string): void;
  /** respawn now at (x, y, z) (or the objective's spawnPos), full HP times hpScale */
  revive(c: Combatant, hpScale?: number): void;
  /** make a bot fight immediately (wave enemies) */
  provoke(c: Combatant): void;
  getScore(team: number): number;
  setScore(team: number, score: number, reason: string): void;
  finish(winner: number | null, reason: string): void;
  log(what: string, team: number, detail: string): void;
  eyeHeight(): number;
}

interface Point { name: string; t: number; x: number; y: number; z: number; owner: number; progTeam: number; prog: number }
interface Pickup { id: number; x: number; y: number; value: number; mine: number }

const env = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== "" && process.env[k] !== undefined ? v : d; };
const LETTERS = "ABCDEFGH";
const TEAM_NAME = ["Blue", "Red", "Gold", "Green"];

export function isHero(c: Combatant) { return !c.kind || c.kind === "hero"; }

export class Objective {
  readonly spec: Required<Pick<ObjectiveSpec, "kind">> & ObjectiveSpec;
  private h: ObjectiveHost;
  private cx = 0; private cy = 0; private cz = 0;
  private yaw = 0;
  private half: number;
  private anchoredTeams = new Set<number>();
  private bases: Array<[number, number, number]> = [];
  private points: Point[] = [];
  private lastScoreAt = 0;
  private startedAt = 0;
  // tug
  private tugS = 0;
  // bank
  private pickups: Pickup[] = [];
  private pickupSerial = 1;
  private carried = new Map<string, number>();
  private mines: Array<[number, number]> = [];
  private lastMineAt = 0;
  // ball
  private ball = { x: 0, y: 0, carrier: "", readyAt: 0, hits: 0 };
  // lanes
  private structures: Combatant[] = [];
  private minions: Combatant[] = [];
  private lastTowerShot = new Map<string, number>();
  private lastMinionHit = new Map<string, number>();
  private nextWaveAt = 0;
  // waves
  private wave = 0;
  private waveState: "intermission" | "fighting" | "done" = "intermission";
  private waveAt = 0;

  constructor(spec: ObjectiveSpec, host: ObjectiveHost) {
    this.spec = spec as ObjectiveSpec & { kind: ObjectiveKind };
    this.h = host;
    const scale = env("LOKI_OBJ_SCALE", 1);
    this.half = (spec.halfLength ?? ({ capture: 2600, conquest: 3400, tug: 3500, bank: 3000, ball: 2600, lanes: 5200, waves: 2200 } as Record<ObjectiveKind, number>)[spec.kind]) * scale;
    const y = process.env.LOKI_OBJ_YAW;
    if (y !== undefined && y !== "") this.yaw = (Number(y) * Math.PI) / 180;
    this.cz = host.eyeHeight();
    this.layout();
  }

  get kind() { return this.spec.kind; }

  // ------------------------------------------------------------------ layout
  private teams() { return Math.max(1, this.h.teamCount()); }

  /** Team ids in slot order. The backend roster numbers teams from 1, the headless gates from 0, so every base /
   *  structure is indexed by slot and mapped to the real team id here (locked at setup). */
  private slotIds: number[] | null = null;
  private ids(): number[] {
    if (this.slotIds) return this.slotIds;
    const n = this.spec.kind === "waves" ? 1 : this.teams();
    const seen = [...new Set(this.h.all().filter(isHero).map((c) => c.team))].sort((a, b) => a - b);
    const out = seen.slice(0, n);
    for (let t = 0; out.length < n; t++) if (!out.includes(t)) out.push(t);
    return out.sort((a, b) => a - b);
  }
  private slot(team: number) {
    if (this.spec.kind === "waves") return 0;
    const i = this.ids().indexOf(team);
    return i >= 0 ? i : Math.abs(team) % Math.max(1, this.bases.length);
  }
  /** The other team of a two-team mode. */
  private other(team: number) { const ids = this.ids(); return ids[this.slot(team) === 0 ? 1 : 0] ?? team; }

  /** Bases on the axis (2 teams), a square (3–4), or one base at the centre (waves). Then objectives from the bases. */
  private layout() {
    const n = this.spec.kind === "waves" ? 1 : this.teams();
    const fx = Math.cos(this.yaw), fy = Math.sin(this.yaw);
    if (this.bases.length !== n) this.bases = [];
    for (let t = 0; t < n; t++) {
      if (this.anchoredTeams.has(t) && this.bases[t]) continue;
      if (n === 1) this.bases[t] = [this.cx, this.cy, this.cz];
      else if (n === 2) { const s = t === 0 ? -1 : 1; this.bases[t] = [this.cx + fx * this.half * s, this.cy + fy * this.half * s, this.cz]; }
      else { const a = this.yaw + Math.PI + (t * 2 * Math.PI) / n; this.bases[t] = [this.cx + Math.cos(a) * this.half, this.cy + Math.sin(a) * this.half, this.cz]; }
    }
    const [b0, b1] = [this.bases[0]!, this.bases[1] ?? this.bases[0]!];
    const lerp = (t: number): [number, number, number] => [b0[0] + (b1[0] - b0[0]) * t, b0[1] + (b1[1] - b0[1]) * t, b0[2] + (b1[2] - b0[2]) * t];
    const k = this.spec.kind;
    if (k === "capture" || k === "conquest") {
      const n = this.spec.points ?? (k === "conquest" ? 5 : 3);
      const old = this.points;
      this.points = [];
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / (n + 1);
        const [x, y, z] = lerp(t);
        // conquest: alternate points off the axis so five points are not one line
        const off = k === "conquest" && i % 2 === 1 ? this.half * 0.45 * (i % 4 === 1 ? 1 : -1) : 0;
        const p = old[i] || { name: LETTERS[i]!, t, x, y, z, owner: -1, progTeam: -1, prog: 0 };
        p.x = x - Math.sin(this.yaw) * off; p.y = y + Math.cos(this.yaw) * off; p.z = z; p.t = t;
        this.points.push(p);
      }
    } else if (k === "tug") {
      const [x, y, z] = lerp((this.tugS + 1) / 2);
      this.points = [{ ...(this.points[0] || { name: "Tug", t: 0.5, owner: -1, progTeam: -1, prog: 0 }), x, y, z }];
    } else if (k === "bank") {
      this.mines = [[this.cx, this.cy]];
      if (n >= 3) for (let i = 0; i < n; i++) { const a = this.yaw + Math.PI + ((i + 0.5) * 2 * Math.PI) / n; this.mines.push([this.cx + Math.cos(a) * this.half * 0.55, this.cy + Math.sin(a) * this.half * 0.55]); }
    } else if (k === "ball") {
      if (!this.ball.carrier) { const [x, y] = lerp(0.5); this.ball.x = x; this.ball.y = y; }
    } else if (k === "lanes") {
      for (const s of this.structures) {
        const at = this.structurePos(s.team, s.id.endsWith("core") ? 0 : s.id.endsWith("inner") ? 0.4 : 0.75);
        s.x = at[0]; s.y = at[1]; s.z = at[2];
      }
    }
  }

  /** Point `along` (0 = own base, 1 = centre) on team t's half of the lane. */
  private structurePos(team: number, along: number): [number, number, number] {
    const b = this.base(team);
    return [b[0] + (this.cx - b[0]) * along, b[1] + (this.cy - b[1]) * along, b[2]];
  }

  base(team: number): [number, number, number] { return this.bases[this.slot(team)] || [this.cx, this.cy, this.cz]; }

  /** A human of `team` stood on real ground at (x, y, z). The first anchor moves the whole layout so that team's base
   *  is under them (and takes their facing as the axis); a later anchor of another team only moves that team's base. */
  anchor(team: number, x: number, y: number, z: number, yawDeg: number) {
    if (process.env.LOKI_OBJ_ANCHOR === "0") return;
    const t = this.slot(team);
    if (this.anchoredTeams.has(t) || t < 0 || t >= Math.max(1, this.bases.length)) return;
    if (this.startedAt && this.h.now() - this.startedAt > 60_000) return; // layout is fixed once the match is under way
    const old = this.bases.map((b) => [...b] as [number, number, number]);
    if (!this.anchoredTeams.size) {
      // first anchor: new axis from the human's facing, centre placed so base t lands under their feet
      if (process.env.LOKI_OBJ_YAW === undefined || process.env.LOKI_OBJ_YAW === "") this.yaw = this.spec.kind === "waves" ? 0 : ((yawDeg * Math.PI) / 180) + (t === 0 ? 0 : Math.PI);
      this.cz = z;
      this.cx = 0; this.cy = 0; this.bases = [];
      this.layout();
      const b = this.bases[t]!;
      this.cx = x - b[0]; this.cy = y - b[1]; this.bases = [];
      this.layout();
    } else {
      this.bases[t] = [x, y, z];
      this.layout();
    }
    this.anchoredTeams.add(t);
    // carry bots along with their team base so nobody is left standing on the old guess
    for (const c of this.h.all()) {
      if (!c.isBot || !c.alive || c.kind === "structure") continue;
      const bt = this.slot(c.team);
      const o = old[bt], n = this.bases[bt];
      if (!o || !n) continue;
      c.x += n[0] - o[0]; c.y += n[1] - o[1]; c.z = Math.max(c.z, n[2] + 90);
    }
    const after = this.bases[t]!;
    this.h.log("anchor", team, `base=(${Math.round(after[0])},${Math.round(after[1])},${Math.round(after[2])}) yaw=${Math.round((this.yaw * 180) / Math.PI)} ${this.describe()}`);
  }

  // ------------------------------------------------------------------ lifecycle
  /** Match begin: seat every hero on its team base, create structures/minions, start the clocks. */
  setup() {
    const now = this.h.now();
    this.startedAt = now;
    this.slotIds = this.ids();
    this.lastScoreAt = now;
    this.lastMineAt = now;
    for (const c of this.h.all()) {
      if (!isHero(c)) continue;
      if (this.spec.kind === "waves" && this.isWaveEnemy(c)) continue; // wave enemies start held
      if (!c.isBot) continue; // humans stay where the client put them
      const [x, y, z] = this.jitter(this.base(c.team), 380);
      c.x = x; c.y = y; c.z = z + 90;
    }
    if (this.spec.kind === "lanes") this.setupLanes();
    if (this.spec.kind === "waves") {
      // solo / small parties: turn enough bots into allies to make a full defending squad
      const ht = this.humanTeam();
      let defenders = this.h.all().filter((c) => isHero(c) && c.team === ht).length;
      for (const c of this.h.all()) {
        if (defenders >= (this.spec.defenders ?? 4)) break;
        if (this.isWaveEnemy(c)) { c.team = ht; defenders++; const [x, y, z] = this.jitter(this.base(0), 380); c.x = x; c.y = y; c.z = z + 90; }
      }
      for (const c of this.h.all()) if (this.isWaveEnemy(c)) { c.alive = false; c.hp = 0; c.respawnAtMs = Infinity; }
      this.waveState = "intermission";
      this.waveAt = now + (this.spec.waveIntermissionMs ?? 10_000);
    }
    if (this.spec.kind === "ball") this.resetBall(now);
    this.h.log("setup", -1, this.describe());
  }

  private setupLanes() {
    const hp = this.spec.towerHp ?? 6000, core = this.spec.coreHp ?? 10_000;
    for (let slot = 0; slot < Math.min(2, this.teams()); slot++) {
      const t = this.ids()[slot]!;
      const side = TEAM_NAME[slot] || `Team${t}`;
      for (const [suffix, along, label, life] of [["outer", 0.75, "Outer Tower", hp], ["inner", 0.4, "Inner Tower", hp], ["core", 0, "Core", core]] as const) {
        const [x, y, z] = this.structurePos(t, along);
        const s = this.h.addEntity(`obj_t${t}_${suffix}`, `[${suffix === "core" ? "CORE" : "TOWER"}] ${side} ${label}`, t, "structure", suffix === "core" ? "Hero:ShieldBot" : "Hero:Earthtank", life, x, y, z);
        this.structures.push(s);
      }
      for (let i = 0; i < (this.spec.minionsPerWave ?? 3); i++) {
        const [x, y, z] = this.jitter(this.base(t), 250);
        this.minions.push(this.h.addEntity(`obj_t${t}_minion${i}`, `[MINION] ${side} ${i + 1}`, t, "minion", "Hero:Beebo", this.spec.minionHp ?? 550, x, y, z, true));
      }
    }
    this.nextWaveAt = this.h.now() + 15_000;
  }

  describe() {
    const r = (v: number) => Math.round(v);
    const bases = this.bases.map((b, i) => `${this.ids()[i] ?? i}:(${r(b[0])},${r(b[1])})`).join(" ");
    const pts = this.points.map((p) => `${p.name}:(${r(p.x)},${r(p.y)})`).join(" ");
    return `kind=${this.kind} bases=${bases}${pts ? ` points=${pts}` : ""}${this.structures.length ? ` structures=${this.structures.length} minions=${this.minions.length}` : ""}`;
  }

  // ------------------------------------------------------------------ hooks from MatchWorld
  tick(dtSeconds: number) {
    switch (this.spec.kind) {
      case "capture": case "conquest": this.tickCapture(dtSeconds); break;
      case "tug": this.tickTug(dtSeconds); break;
      case "bank": this.tickBank(); break;
      case "ball": this.tickBall(); break;
      case "lanes": this.tickLanes(dtSeconds); break;
      case "waves": this.tickWaves(); break;
    }
  }

  onKill(source: Combatant | null, victim: Combatant) {
    const k = this.spec.kind;
    if (k === "conquest" && source && source.team !== victim.team && isHero(victim)) this.addScore(source.team, this.spec.killPoints ?? 2, "kill");
    if (k === "bank" && isHero(victim)) {
      const value = (this.carried.get(victim.id) || 0) + 1;
      this.carried.delete(victim.id);
      this.pickups.push({ id: this.pickupSerial++, x: victim.x, y: victim.y, value, mine: -1 });
    }
    if (k === "ball" && this.ball.carrier === victim.id) {
      this.ball.carrier = "";
      this.ball.x = victim.x; this.ball.y = victim.y; this.ball.readyAt = this.h.now() + 600;
      this.h.log("ball_drop", victim.team, victim.name);
    }
    if (k === "lanes" && victim.kind === "structure") {
      victim.respawnAtMs = Infinity;
      const attacker = this.other(victim.team);
      this.addScore(attacker, 1, "structure");
      this.h.log("structure_down", attacker, victim.name);
      if (victim.id.endsWith("core")) this.h.finish(attacker, "core_destroyed");
    }
  }

  /** Damage multiplier: Holdout wave enemies hit defenders softer (they come in numbers). */
  damageScale(source: Combatant | null, target: Combatant): number {
    if (this.spec.kind === "waves" && source && this.isWaveEnemy(source) && !this.isWaveEnemy(target)) return this.spec.enemyDamageScale ?? 0.5;
    return 1;
  }

  /** Damage hook: a ball carrier who takes `tackleDamage` since the pickup drops the ball (a tackle). */
  onDamage(source: Combatant | null, target: Combatant, amount: number) {
    if (this.spec.kind !== "ball" || this.ball.carrier !== target.id || !source || source.team === target.team) return;
    this.ball.hits += amount;
    if (this.ball.hits >= (this.spec.tackleDamage ?? 250)) {
      this.ball.carrier = ""; this.ball.hits = 0;
      this.ball.x = target.x; this.ball.y = target.y; this.ball.readyAt = this.h.now() + 500;
      this.h.log("tackle", source.team, `${source.name} knocked the ball off ${target.name}`);
    }
  }

  /** Respawn delay override for the victim: Infinity = held until the objective revives it; undefined = rules.respawnMs. */
  respawnDelay(victim: Combatant): number | undefined {
    if (victim.kind === "structure" || victim.kind === "minion") return Infinity;
    if (this.spec.kind === "waves") return Infinity; // defenders wait for the wave to clear; enemies are revived per wave
    return undefined;
  }

  canDamage(source: Combatant | null, target: Combatant): boolean {
    if (this.spec.kind !== "lanes") return true;
    if (target.kind === "structure") {
      if (source?.kind === "structure") return false;
      // outer → inner → core: a structure is invulnerable while the one in front of it stands
      const order = ["outer", "inner", "core"];
      const idx = order.findIndex((s) => target.id.endsWith(s));
      for (let i = 0; i < idx; i++) {
        const front = this.structures.find((s) => s.team === target.team && s.id.endsWith(order[i]!));
        if (front?.alive) return false;
      }
    }
    return true;
  }

  /** Respawn position: own team base (humans only once their team is anchored on real ground). */
  spawnPos(c: Combatant): [number, number, number] | null {
    if (c.kind === "minion") return this.jitter(this.base(c.team), 250);
    if (c.kind === "structure") return null;
    if (this.spec.kind === "waves" && this.isWaveEnemy(c)) {
      const b = this.base(0), a = this.h.rng() * Math.PI * 2, r = this.half * (0.9 + this.h.rng() * 0.5);
      return [b[0] + Math.cos(a) * r, b[1] + Math.sin(a) * r, b[2] + 90];
    }
    if (!c.isBot && !this.anchoredTeams.has(this.slot(c.team))) return null;
    const [x, y, z] = this.jitter(this.base(c.team), c.isBot ? 380 : 150);
    return [x, y, z + 90];
  }

  /** Where a hero bot should be. null = no opinion (normal roaming/fighting). */
  botGoal(c: Combatant): BotGoal | null {
    if (!isHero(c)) return null;
    const k = this.spec.kind;
    if (k === "capture" || k === "conquest") return this.goalCapture(c);
    if (k === "tug") { const p = this.points[0]!; return { x: p.x, y: p.y, radius: (this.spec.pointRadius ?? 500) * 0.7 }; }
    if (k === "bank") return this.goalBank(c);
    if (k === "ball") return this.goalBall(c);
    if (k === "lanes") return this.goalLanes(c);
    if (k === "waves") return this.goalWaves(c);
    return null;
  }

  // ------------------------------------------------------------------ capture / conquest
  private inside(x: number, y: number, r: number) {
    const counts = new Map<number, number>();
    for (const c of this.h.all()) if (c.alive && isHero(c) && Math.hypot(c.x - x, c.y - y) <= r) counts.set(c.team, (counts.get(c.team) || 0) + 1);
    return counts;
  }

  private tickCapture(dt: number) {
    const r = this.spec.pointRadius ?? 500, sec = this.spec.captureSec ?? 10;
    for (const p of this.points) {
      const counts = this.inside(p.x, p.y, r);
      if (counts.size === 1) {
        const [team, n] = [...counts.entries()][0]!;
        if (team === p.owner) { if (p.prog > 0) p.prog = Math.max(0, p.prog - dt / sec); continue; }
        if (p.progTeam !== team && p.prog > 0) { p.prog = Math.max(0, p.prog - (dt * (1 + (n - 1) / 3)) / sec); if (p.prog === 0) p.progTeam = -1; continue; }
        p.progTeam = team;
        p.prog += (dt * (1 + (n - 1) / 3)) / sec; // retail basecamp rate: n players progress at 1 + (n-1)/3
        if (p.prog >= 1) {
          const prev = p.owner;
          p.owner = team; p.prog = 0; p.progTeam = -1;
          this.h.log("captured", team, `point ${p.name}${prev >= 0 ? ` from team ${prev}` : ""}`);
        }
      } else if (counts.size === 0 && p.prog > 0) {
        p.prog = Math.max(0, p.prog - (dt * 0.5) / sec);
        if (p.prog === 0) p.progTeam = -1;
      }
    }
    const every = this.spec.scoreEveryMs ?? 2000, now = this.h.now();
    if (now - this.lastScoreAt >= every) {
      this.lastScoreAt = now;
      const held = new Map<number, number>();
      for (const p of this.points) if (p.owner >= 0) held.set(p.owner, (held.get(p.owner) || 0) + 1);
      for (const [team, n] of held) this.addScore(team, n, "held");
    }
  }

  private assigned = new Map<string, string>();

  private goalCapture(c: Combatant): BotGoal {
    const r = (this.spec.pointRadius ?? 500) * 0.6;
    const settled = (p: Point) => p.owner === c.team && (p.progTeam < 0 || p.prog === 0);
    // keep the assigned point until it is ours and quiet (no flip-flopping between two equally close points)
    let pick = this.points.find((p) => p.name === this.assigned.get(c.id));
    if (!pick || settled(pick)) {
      const cands = this.points.filter((p) => !settled(p));
      const list = (cands.length ? cands : this.points).slice().sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
      // spread a team: most go to the closest open point, every third bot to the next one
      pick = list[Math.min(list.length - 1, hash(c.id) % 3 === 0 ? 1 : 0)]!;
      this.assigned.set(c.id, pick.name);
    }
    return { x: pick.x, y: pick.y, radius: r };
  }

  // ------------------------------------------------------------------ tug of war
  private tickTug(dt: number) {
    const p = this.points[0]!, r = this.spec.pointRadius ?? 550;
    const counts = this.inside(p.x, p.y, r);
    const [t0, t1] = [this.ids()[0]!, this.ids()[1] ?? -1];
    const a = counts.get(t0) || 0, b = counts.get(t1) || 0;
    const d = a - b;
    if (d !== 0) {
      const n = Math.abs(d);
      const speed = (this.spec.pushSpeed ?? 70) * (1 + (n - 1) / 3);
      this.tugS += Math.sign(d) * (speed * dt) / this.half;
      this.tugS = Math.max(-1, Math.min(1, this.tugS));
      this.layout();
    }
    const s0 = Math.round(Math.max(0, this.tugS) * 100), s1 = Math.round(Math.max(0, -this.tugS) * 100);
    if (s0 !== this.h.getScore(t0)) this.h.setScore(t0, s0, "push");
    if (s1 !== this.h.getScore(t1)) this.h.setScore(t1, s1, "push");
    if (this.tugS >= 1) this.h.finish(t0, "tug_pushed");
    else if (this.tugS <= -1) this.h.finish(t1, "tug_pushed");
  }

  // ------------------------------------------------------------------ prisma bank
  private tickBank() {
    const now = this.h.now(), every = this.spec.mineEveryMs ?? 12_000, cap = this.spec.mineCap ?? 3;
    if (now - this.lastMineAt >= every) {
      this.lastMineAt = now;
      this.mines.forEach(([x, y], i) => {
        const loose = this.pickups.filter((p) => p.mine === i).reduce((s, p) => s + p.value, 0);
        if (loose < cap) this.pickups.push({ id: this.pickupSerial++, x: x + (this.h.rng() - 0.5) * 400, y: y + (this.h.rng() - 0.5) * 400, value: i === 0 ? 2 : 1, mine: i });
      });
    }
    const bankR = this.spec.bankRadius ?? 600;
    for (const c of this.h.all()) {
      if (!c.alive || !isHero(c)) continue;
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const p = this.pickups[i]!;
        if (Math.hypot(p.x - c.x, p.y - c.y) <= 230) { this.carried.set(c.id, (this.carried.get(c.id) || 0) + p.value); this.pickups.splice(i, 1); }
      }
      const have = this.carried.get(c.id) || 0;
      const b = this.base(c.team);
      if (have > 0 && Math.hypot(b[0] - c.x, b[1] - c.y) <= bankR) {
        this.carried.delete(c.id);
        this.addScore(c.team, have, "bank");
        this.h.log("banked", c.team, `${c.name} +${have}`);
      }
    }
    // loose drops expire after 60 s so the map never fills up
    if (this.pickups.length > 60) this.pickups.splice(0, this.pickups.length - 60);
  }

  carriedBy(id: string) { return this.carried.get(id) || 0; }

  private goalBank(c: Combatant): BotGoal {
    const have = this.carried.get(c.id) || 0;
    const b = this.base(c.team);
    if (have >= 3 || (have > 0 && c.hp < c.maxHp * 0.5)) return { x: b[0], y: b[1], radius: (this.spec.bankRadius ?? 600) * 0.5, urgent: true };
    let best: Pickup | undefined, bd = Infinity;
    for (const p of this.pickups) { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < bd) { bd = d; best = p; } }
    if (best && bd < this.half * 2) return { x: best.x, y: best.y, radius: 120 };
    const m = this.mines[hash(c.id) % this.mines.length]!;
    return { x: m[0], y: m[1], radius: 500 };
  }

  // ------------------------------------------------------------------ soccervive
  private resetBall(now: number) {
    this.ball.carrier = "";
    const b0 = this.bases[0] || [this.cx, this.cy, this.cz], b1 = this.bases[1] || b0;
    this.ball.x = (b0[0] + b1[0]) / 2; this.ball.y = (b0[1] + b1[1]) / 2;
    this.ball.readyAt = now + (this.spec.kickoffMs ?? 3000);
  }

  private tickBall() {
    const now = this.h.now();
    let carrier = this.ball.carrier ? this.h.all().find((c) => c.id === this.ball.carrier) : undefined;
    if (carrier && !carrier.alive) { this.ball.carrier = ""; carrier = undefined; }
    if (carrier) {
      this.ball.x = carrier.x; this.ball.y = carrier.y;
      const goal = this.base(this.other(carrier.team));
      if (Math.hypot(goal[0] - carrier.x, goal[1] - carrier.y) <= (this.spec.goalRadius ?? 450)) {
        this.addScore(carrier.team, 1, "goal");
        this.h.log("goal", carrier.team, carrier.name);
        this.resetBall(now);
        // kickoff: everyone back to their own half
        for (const c of this.h.all()) if (c.isBot && c.alive && isHero(c)) { const [x, y, z] = this.jitter(this.base(c.team), 380); c.x = x; c.y = y; c.z = z + 90; }
      }
      return;
    }
    if (now < this.ball.readyAt) return;
    let best: Combatant | undefined, bd = 180;
    for (const c of this.h.all()) {
      if (!c.alive || !isHero(c)) continue;
      const d = Math.hypot(c.x - this.ball.x, c.y - this.ball.y);
      if (d <= bd) { bd = d; best = c; }
    }
    if (best) { this.ball.carrier = best.id; this.ball.hits = 0; this.h.log("ball_pickup", best.team, best.name); }
  }

  ballState() { return { ...this.ball }; }

  private goalBall(c: Combatant): BotGoal {
    const carrier = this.ball.carrier ? this.h.all().find((o) => o.id === this.ball.carrier) : undefined;
    if (carrier?.id === c.id) { const g = this.base(this.other(c.team)); return { x: g[0], y: g[1], radius: 120, urgent: true, noSprint: true }; }
    const k = this.keeper(c);
    if (k) return k;
    if (carrier && carrier.team !== c.team) return { x: carrier.x, y: carrier.y, radius: 150, targetId: carrier.id, urgent: true };
    if (carrier) {
      // escort: run ahead of our carrier toward the goal
      const g = this.base(this.other(c.team));
      return { x: carrier.x + (g[0] - carrier.x) * 0.25, y: carrier.y + (g[1] - carrier.y) * 0.25, radius: 300 };
    }
    return { x: this.ball.x, y: this.ball.y, radius: 60, urgent: hash(c.id) % 3 !== 0 };
  }

  /** One bot per team keeps goal: holds in front of its own goal and only steps out for a carrier in the box. */
  private keeper(c: Combatant): BotGoal | null {
    const mates = this.h.all().filter((o) => o.isBot && isHero(o) && o.team === c.team && o.alive).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (mates.length < 2 || mates[0]!.id !== c.id) return null;
    const own = this.base(c.team), mid = [this.cx, this.cy];
    const carrier = this.ball.carrier ? this.h.all().find((o) => o.id === this.ball.carrier) : undefined;
    if (carrier && carrier.team !== c.team && Math.hypot(carrier.x - own[0], carrier.y - own[1]) < 1800) return { x: carrier.x, y: carrier.y, radius: 120, targetId: carrier.id, urgent: true };
    if (!carrier && Math.hypot(this.ball.x - own[0], this.ball.y - own[1]) < 1200) return { x: this.ball.x, y: this.ball.y, radius: 60, urgent: true };
    const gx = own[0] + (mid[0]! - own[0]) * 0.15, gy = own[1] + (mid[1]! - own[1]) * 0.15;
    return { x: gx, y: gy, radius: 200, leash: 900 };
  }

  // ------------------------------------------------------------------ barracuda lanes
  private tickLanes(dt: number) {
    const now = this.h.now();
    // towers / cores: shoot the nearest enemy in range (minions first, like a MOBA tower)
    const range = this.spec.towerRange ?? 1300, dmg = this.spec.towerDamage ?? 150;
    for (const s of this.structures) {
      if (!s.alive) continue;
      if (now - (this.lastTowerShot.get(s.id) || 0) < 1000) continue;
      const foes = this.h.all().filter((e) => e.alive && e.team !== s.team && e.kind !== "structure" && Math.hypot(e.x - s.x, e.y - s.y) <= range);
      if (!foes.length) continue;
      foes.sort((a, b) => (a.kind === "minion" ? 0 : 1) - (b.kind === "minion" ? 0 : 1) || Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
      this.lastTowerShot.set(s.id, now);
      this.h.damage(s, foes[0]!, dmg, "tower");
    }
    // minion waves
    if (now >= this.nextWaveAt) {
      this.nextWaveAt = now + (this.spec.minionEveryMs ?? 30_000);
      let n = 0;
      for (const m of this.minions) if (!m.alive && this.structures.some((s) => s.team === m.team && s.id.endsWith("core") && s.alive)) { this.h.revive(m); n++; }
      if (n) this.h.log("minion_wave", -1, `${n} minions`);
    }
    // minions march down the lane and hit what is in front of them
    for (const m of this.minions) {
      if (!m.alive) continue;
      const enemy = this.h.all().filter((e) => e.alive && e.team !== m.team && Math.hypot(e.x - m.x, e.y - m.y) <= 650 && this.canDamage(m, e))
        .sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0];
      if (enemy) {
        if (Math.hypot(enemy.x - m.x, enemy.y - m.y) > 260) this.step(m, enemy.x, enemy.y, 330, dt);
        if (now - (this.lastMinionHit.get(m.id) || 0) >= 1000) { this.lastMinionHit.set(m.id, now); this.h.damage(m, enemy, 40, "minion"); }
        continue;
      }
      const target = this.nextEnemyStructure(m.team);
      const g = target ? [target.x, target.y] : this.base(this.other(m.team));
      this.step(m, g[0]!, g[1]!, 330, dt);
    }
  }

  private nextEnemyStructure(team: number) {
    const enemy = this.other(team);
    for (const s of ["outer", "inner", "core"]) {
      const st = this.structures.find((x) => x.team === enemy && x.id.endsWith(s));
      if (st?.alive) return st;
    }
    return undefined;
  }

  private step(c: Combatant, x: number, y: number, speed: number, dt: number) {
    const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy);
    if (d < 1) return;
    const s = Math.min(d, speed * dt);
    c.x += (dx / d) * s; c.y += (dy / d) * s;
    c.vx = (dx / d) * speed; c.vy = (dy / d) * speed;
    c.yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  }

  structureState() { return this.structures.map((s) => ({ id: s.id, team: s.team, alive: s.alive, hp: Math.round(s.hp) })); }

  private goalLanes(c: Combatant): BotGoal {
    const target = this.nextEnemyStructure(c.team);
    const own = this.structures.filter((s) => s.team === c.team && s.alive);
    // defend: an enemy hero near one of our structures
    for (const s of own) {
      const threat = this.h.all().find((e) => e.alive && e.team !== c.team && isHero(e) && Math.hypot(e.x - s.x, e.y - s.y) < 1500);
      if (threat && hash(c.id) % 2 === 0) return { x: threat.x, y: threat.y, radius: 300, targetId: threat.id };
    }
    // push with the wave: only dive the enemy structure when our minions are near it (or late in the match)
    if (target) {
      const backed = this.minions.some((m) => m.alive && m.team === c.team && Math.hypot(m.x - target.x, m.y - target.y) < 1500);
      const late = this.h.now() - this.startedAt > 8 * 60_000;
      if (backed || late) return { x: target.x, y: target.y, radius: 500, targetId: target.id };
      const front = this.minions.filter((m) => m.alive && m.team === c.team).sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y))[0];
      if (front) return { x: front.x, y: front.y, radius: 400 };
    }
    const g = this.structurePos(c.team, 0.85);
    return { x: g[0], y: g[1], radius: 600 };
  }

  // ------------------------------------------------------------------ holdout waves
  /** Holdout defenders = the humans' team (roster decides it); every bot on another team is a wave enemy. */
  private humanTeam() {
    const h = this.h.all().find((c) => !c.isBot && isHero(c));
    return h ? h.team : 0;
  }
  private isWaveEnemy(c: Combatant) { return c.isBot && isHero(c) && c.team !== this.humanTeam(); }

  private tickWaves() {
    const now = this.h.now();
    const ht = this.humanTeam();
    const humans = this.h.all().filter((c) => !c.isBot && isHero(c));
    const defenders = this.h.all().filter((c) => isHero(c) && c.team === ht);
    const enemies = this.h.all().filter((c) => this.isWaveEnemy(c));
    if (this.waveState === "fighting") {
      if (humans.length && defenders.every((c) => !c.alive)) { this.waveState = "done"; this.h.finish(enemies[0]?.team ?? (ht === 0 ? 1 : 0), "holdout_wiped"); return; }
      if (enemies.every((c) => !c.alive)) {
        this.h.setScore(ht, this.wave, "wave");
        this.h.log("wave_cleared", ht, `wave ${this.wave}`);
        if (this.wave >= (this.spec.waves ?? 10)) { this.waveState = "done"; this.h.finish(ht, "holdout_survived"); return; }
        for (const c of defenders) if (!c.alive) this.h.revive(c);
        this.waveState = "intermission";
        this.waveAt = now + (this.spec.waveIntermissionMs ?? 8000);
      }
      return;
    }
    if (this.waveState === "intermission" && now >= this.waveAt) {
      this.wave++;
      const size = Math.min(enemies.length, (this.spec.waveBase ?? 2) + this.wave);
      const hpScale = Math.min(1.6, 0.4 + this.wave * 0.08);
      for (const c of enemies.slice(0, size)) { this.h.revive(c, hpScale); this.h.provoke(c); }
      this.waveState = "fighting";
      this.h.log("wave_start", -1, `wave ${this.wave} enemies=${size} hp=x${hpScale.toFixed(2)}`);
    }
  }

  private goalWaves(c: Combatant): BotGoal | null {
    if (!this.isWaveEnemy(c)) {
      // allied bots guard the base
      const b = this.base(0);
      return Math.hypot(b[0] - c.x, b[1] - c.y) > 900 ? { x: b[0], y: b[1], radius: 500 } : null;
    }
    const ht = this.humanTeam();
    const foes = this.h.all().filter((o) => o.alive && o.team === ht && isHero(o));
    if (!foes.length) return null;
    const t = foes.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0]!;
    return { x: t.x, y: t.y, radius: 400, targetId: t.id };
  }

  // ------------------------------------------------------------------ helpers
  private addScore(team: number, n: number, reason: string) {
    if (team < 0 || n <= 0) return;
    const s = this.h.getScore(team) + n;
    this.h.setScore(team, s, reason);
    const limit = this.spec.scoreLimit;
    if (limit && s >= limit && this.spec.kind !== "lanes") this.h.finish(team, `${this.spec.kind}_score`);
  }

  private jitter(b: [number, number, number], r: number): [number, number, number] {
    const a = this.h.rng() * Math.PI * 2, d = this.h.rng() * r;
    return [b[0] + Math.cos(a) * d, b[1] + Math.sin(a) * d, b[2]];
  }

  /** Read-only state for logs, the snapshot and gates. */
  state() {
    return {
      kind: this.kind,
      teams: this.ids(),
      bases: this.bases.map((b) => b.map(Math.round)),
      anchored: [...this.anchoredTeams],
      points: this.points.map((p) => ({ name: p.name, x: Math.round(p.x), y: Math.round(p.y), owner: p.owner, progTeam: p.progTeam, prog: Number(p.prog.toFixed(2)) })),
      ...(this.kind === "tug" ? { tug: Number(this.tugS.toFixed(3)) } : {}),
      ...(this.kind === "bank" ? { pickups: this.pickups.length, carried: Object.fromEntries(this.carried) } : {}),
      ...(this.kind === "ball" ? { ball: { x: Math.round(this.ball.x), y: Math.round(this.ball.y), carrier: this.ball.carrier } } : {}),
      ...(this.kind === "lanes" ? { structures: this.structureState() } : {}),
      ...(this.kind === "waves" ? { wave: this.wave, waveState: this.waveState } : {}),
    };
  }
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
