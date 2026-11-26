// Gate for server/ue/objectives.ts: every objective mode plays its objective, not a kill count.
// Headless (no sockets, injected clock). `bun tools/check-objectives.ts`
import { strict as assert } from "node:assert";
import { MatchWorld, DEFAULT_RULES, type MatchRules, type MatchEvent } from "../../../match/match.ts";
import { MODE_PROFILES } from "../../../match/modeconfig.ts";

let pass = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); pass++; };

const OBJECTIVE_MODES = ["domination", "battlefield", "tugofwar", "prisma_bank", "soccervive", "barracuda", "swordfish", "holdout"];

function world(key: string, opts: { seed?: number; roster?: boolean; active?: boolean; rules?: Partial<MatchRules> } = {}) {
  let t = 1_000_000, seed = opts.seed ?? 7;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const events: MatchEvent[] = [];
  const base = { ...DEFAULT_RULES, zone: { ...DEFAULT_RULES.zone }, shot: { ...DEFAULT_RULES.shot } };
  const w = new MatchWorld(base, { now: () => t, rng, onEvent: (e) => events.push(e) });
  const p = MODE_PROFILES[key]!;
  ok(w.configureMode({ ...p.rules, zone: { ...base.zone, ...(p.rules.zone || {}) }, ...(opts.rules || {}) }), `${key}: configureMode`);
  if (opts.roster) {
    // backend matchmaker roster: teams numbered from 1 (server/lib/matchmaker.ts)
    const teams = p.rules.teamCount ?? 2, per = Math.ceil((p.rules.maxPlayers ?? 8) / teams);
    const members: Array<{ id: string; name: string; team: number; isBot: boolean }> = [];
    for (let tm = 1; tm <= teams; tm++) for (let i = 0; i < per; i++) members.push({ id: tm === 1 && i === 0 ? "human0" : `rb_${tm}_${i}`, name: `r${tm}${i}`, team: tm, isBot: !(tm === 1 && i === 0) });
    w.applyRoster(members);
    w.addPlayer("human0", "human0", { team: 1 });
  } else w.addPlayer("human0", "human0");
  const h = w.get("human0")!;
  const pos = { x: 1200, y: -800 };
  const stand = () => { if (h.alive) w.setClientState("human0", { x: pos.x, y: pos.y, z: 300, vx: 0, vy: 0, vz: 0, yaw: 30, pitch: 0, grounded: true }); };
  return {
    w, events, h, pos,
    get t() { return t; },
    run(ms: number, step = 100) {
      for (let left = ms; left > 0 && w.phase !== "ended"; left -= step) {
        t += step; w.tick(step / 1000); stand();
        if (opts.active && h.alive && (t / step) % 4 === 0) w.requestAbility("human0", (t / step) % 40 === 0 ? "bolt" : "primary");
      }
    },
    obj(what: string) { return events.filter((e) => e.type === "objective" && e.what === what); },
  };
}

// 1. Every objective mode has an objective profile and no kill-count scoring; Breach / kill / round modes have none.
for (const k of OBJECTIVE_MODES) {
  const r = MODE_PROFILES[k]!.rules;
  ok(r.objective?.kind, `${k}: objective set (${r.objective?.kind})`);
  ok(!r.teamScorePerKill, `${k}: no kill-count team score`);
  ok(MODE_PROFILES[k]!.teamScoreToWin, `${k}: HUD TeamScoreToWin set`);
}
for (const k of ["ffa", "solos", "duos", "turbobr", "arena", "tournament", "training"]) ok(!MODE_PROFILES[k]!.rules.objective, `${k}: no objective`);
ok(DEFAULT_RULES.objective === undefined, "Breach default rules: no objective");
{
  const b = new MatchWorld({ ...DEFAULT_RULES, zone: { ...DEFAULT_RULES.zone }, shot: { ...DEFAULT_RULES.shot } }, { now: () => 1, rng: () => 0.5 });
  ok(b.objectiveState() === null && b.getSnapshot().objective === undefined && b.getSnapshot().teamScores === undefined, "Breach: no objective / team scores in the snapshot");
}

// 2. Anchoring: the first human to stand on ground moves its team base under its feet.
{
  const g = world("domination");
  g.run(500);
  const st = g.w.objectiveState()!;
  ok(st.anchored.length === 1, "domination: anchored once");
  const b0 = st.bases[st.teams.indexOf(g.h.team)]!;
  ok(Math.hypot(b0[0]! - 1200, b0[1]! + 800) < 1, `domination: human base on its feet (${b0})`);
  ok(st.points.length === 3, "domination: three points");
}

// 3. Domination / Battlefield: points get captured and the match ends on score, not the clock.
for (const [k, kind] of [["domination", "capture"], ["battlefield", "conquest"]] as const) {
  for (const seed of [7, 99]) {
    const g = world(k, { seed });
    g.run(MODE_PROFILES[k]!.rules.durationMs! + 5000);
    const s = g.w.getSnapshot();
    ok(g.obj("captured").length >= 3, `${k}/${seed}: points captured (${g.obj("captured").length})`);
    ok(s.endReason === `${kind}_score`, `${k}/${seed}: ends on score (${s.endReason})`);
    ok(Math.max(...Object.values(s.teamScores || {})) >= MODE_PROFILES[k]!.rules.objective!.scoreLimit!, `${k}/${seed}: winner reached the limit`);
    ok(s.elapsedMs > 3 * 60_000, `${k}/${seed}: lasts more than 3 min (${(s.elapsedMs / 60000).toFixed(1)})`);
  }
}
{
  // capture rules: a lone player on an empty point captures it in captureSec (8 s), not before
  const g = world("domination", { rules: { botCount: 0, fillBots: false, countdownMs: 0, maxPlayers: 1 } });
  g.run(300);
  const p = g.w.objectiveState()!.points[1]!;
  g.pos.x = p.x; g.pos.y = p.y;
  g.run(7000);
  ok(g.w.objectiveState()!.points[1]!.owner === -1, "capture: still neutral after 7 s");
  g.run(1500);
  ok(g.w.objectiveState()!.points[1]!.owner === g.h.team, "capture: owned after 8.5 s");
}

// 4. Tug of war: the point moves and the score is the % pushed.
{
  let moved = false;
  for (const seed of [7, 99]) {
    const g = world("tugofwar", { seed });
    g.run(5 * 60_000);
    const s = g.w.getSnapshot();
    const v = Math.max(...Object.values(s.teamScores || { 0: 0 }));
    if (v > 0) moved = true;
    ok(Math.abs(g.w.objectiveState()!.tug as number) <= 1, `tug/${seed}: point stays in the lane`);
  }
  ok(moved, "tug: the point was pushed");
}

// 5. Prisma bank: prisma is banked into team scores and the match ends on the bank limit.
{
  const g = world("prisma_bank");
  g.run(MODE_PROFILES.prisma_bank!.rules.durationMs! + 5000);
  const s = g.w.getSnapshot();
  ok(g.obj("banked").length > 10, `bank: banked ${g.obj("banked").length} times`);
  ok(s.endReason === "bank_score", `bank: ends on bank score (${s.endReason})`);
  ok(Object.keys(s.teamScores || {}).length === 4, "bank: four teams scored");
}

// 6. Soccervive: pickups, tackles, goals; ends on goals.
{
  const g = world("soccervive");
  g.run(MODE_PROFILES.soccervive!.rules.durationMs! + 5000);
  const s = g.w.getSnapshot();
  ok(g.obj("ball_pickup").length > 5, "ball: picked up");
  ok(g.obj("tackle").length > 0, "ball: tackled loose");
  ok(g.obj("goal").length >= 5, "ball: goals scored");
  ok(s.endReason === "ball_score", `ball: ends on goals (${s.endReason})`);
}

// 7. Barracuda / Swordfish: structures fall outer → inner → core, the core ends it.
for (const k of ["barracuda", "swordfish"]) {
  const g = world(k);
  g.run(16_000);
  const st0 = g.w.objectiveState()!.structures as Array<{ id: string; team: number; alive: boolean; hp: number }>;
  ok(st0.length === 6, `${k}: 6 structures`);
  // invulnerability order: hit an inner tower while its outer stands → no damage
  const all = g.w.all();
  const inner = all.find((c) => c.id.endsWith("_inner"))!;
  const hp0 = inner.hp;
  const enemyHero = all.find((c) => c.team !== inner.team && (!c.kind || c.kind === "hero"))!;
  (g.w as any).applyDamage(enemyHero, inner, 500, "test");
  ok(inner.hp === hp0, `${k}: inner tower invulnerable behind its outer tower`);
  const down: string[] = [];
  g.run(MODE_PROFILES[k]!.rules.durationMs! + 5000);
  for (const e of g.obj("structure_down")) down.push((e as any).detail);
  const s = g.w.getSnapshot();
  ok(g.obj("minion_wave").length > 5, `${k}: minion waves`);
  ok(s.endReason === "core_destroyed", `${k}: ends on a core (${s.endReason})`);
  // per team, the order of destruction is outer, inner, core
  for (const side of ["Blue", "Red"]) {
    const seq = down.filter((d) => d.includes(side)).map((d) => (d.includes("Outer") ? 0 : d.includes("Inner") ? 1 : 2));
    ok(seq.every((v, i) => v === i), `${k}: ${side} structures fell in order (${seq})`);
  }
  ok(s.combatants.filter((c) => c.kind === "structure" || c.kind === "minion").every((c) => c.isBot), `${k}: entities are bots`);
  ok(g.w.result.results.length === 1, `${k}: results list humans only`);
}

// 8. Holdout: allies fill the defenders, waves escalate and clear, the human waits for the wave to end.
{
  const g = world("holdout", { active: true });
  g.run(16_000);
  const ht = g.h.team;
  const defenders = g.w.all().filter((c) => (!c.kind || c.kind === "hero") && c.team === ht);
  ok(defenders.length === 4, `holdout: 4 defenders (${defenders.length})`);
  g.run(MODE_PROFILES.holdout!.rules.durationMs! + 5000);
  const starts = g.obj("wave_start").map((e) => Number((e as any).detail.match(/enemies=(\d+)/)[1]));
  ok(g.obj("wave_cleared").length >= 3, `holdout: cleared ${g.obj("wave_cleared").length} waves`);
  ok(starts.every((n, i) => i === 0 || n >= starts[i - 1]!), `holdout: waves grow (${starts})`);
  ok(["holdout_wiped", "holdout_survived"].includes(g.w.getSnapshot().endReason), `holdout: ends on the waves (${g.w.getSnapshot().endReason})`);
  const humanRespawns = g.events.filter((e) => e.type === "respawn" && e.id === "human0").length;
  const humanDeaths = g.events.filter((e) => e.type === "kill" && e.victim === "human0").length;
  ok(humanRespawns <= humanDeaths, "holdout: the human only comes back between waves");
}

// 9. Backend rosters number teams from 1: bases, structures and scores follow the roster ids.
{
  const g = world("barracuda", { roster: true });
  g.run(16_000);
  const st = g.w.objectiveState()!;
  ok(JSON.stringify(st.teams) === "[1,2]", `roster lanes: teams ${JSON.stringify(st.teams)}`);
  const sts = st.structures as Array<{ team: number }>;
  ok(sts.filter((x) => x.team === 1).length === 3 && sts.filter((x) => x.team === 2).length === 3, "roster lanes: 3 structures per roster team");
  g.run(MODE_PROFILES.barracuda!.rules.durationMs! + 5000);
  const s = g.w.getSnapshot();
  ok(s.endReason === "core_destroyed" && [1, 2].includes(s.winner!), `roster lanes: core ends it, winner ${s.winner}`);
  ok(Object.keys(s.teamScores || {}).every((t) => t === "1" || t === "2"), "roster lanes: scores keyed by roster ids");
}
{
  const g = world("domination", { roster: true });
  g.run(MODE_PROFILES.domination!.rules.durationMs! + 5000);
  const s = g.w.getSnapshot();
  ok(s.endReason === "capture_score" && [1, 2].includes(s.winner!), `roster domination: ends on score, winner ${s.winner}`);
  ok(Object.keys(s.teamScores || {}).every((t) => t === "1" || t === "2"), "roster domination: scores keyed by roster ids");
}
{
  const g = world("soccervive", { roster: true });
  g.run(MODE_PROFILES.soccervive!.rules.durationMs! + 5000);
  ok(g.obj("goal").length >= 1, "roster soccervive: goals into the roster teams' goals");
}

// 10. Kill switch.
{
  process.env.LOKI_OBJECTIVES = "0";
  const g = world("domination");
  g.run(10_000);
  ok(g.w.objectiveState() === null, "LOKI_OBJECTIVES=0: no objective");
  delete process.env.LOKI_OBJECTIVES;
}

console.log(`check-objectives: ${pass}/${pass} passed`);
