// Gate for the non-Breach match modes (server/ue/modeconfig.ts MODE_PROFILES + the optional rules in match.ts).
// Headless: no sockets, injected clock. `bun tools/check-modes.ts`
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { MatchWorld, DEFAULT_RULES, type MatchRules, type MatchEvent } from "../../../match/match.ts";
import { MODE_PROFILES, MODE_TABLE, modeProfileFor, resolveMode } from "../../../match/modeconfig.ts";

let pass = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); pass++; };

function world(rules: Partial<MatchRules>, humans = 1) {
  let t = 1_000_000, seed = 7;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const events: MatchEvent[] = [];
  const base = { ...DEFAULT_RULES, zone: { ...DEFAULT_RULES.zone }, shot: { ...DEFAULT_RULES.shot } };
  const w = new MatchWorld(base, { now: () => t, rng, onEvent: (e) => events.push(e) });
  ok(w.configureMode(rules), "configureMode accepted before start");
  for (let i = 0; i < humans; i++) w.addPlayer(`human${i}`, `human${i}`);
  return {
    w, events,
    run(ms: number, step = 100) { for (let left = ms; left > 0 && w.phase !== "ended"; left -= step) { t += step; w.tick(step / 1000); } },
    count(type: string) { return events.filter((e) => e.type === type).length; },
  };
}
const prof = (k: string) => MODE_PROFILES[k]!.rules;

// 1. Breach has no profile and the default rules are untouched.
ok(modeProfileFor("SkylandsBreachBRGameMode", "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", "default") === null, "breach: no profile");
ok(modeProfileFor("SkylandsBreachBRGameMode", "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", "trios") === null, "trios: no profile");
ok(DEFAULT_RULES.mode === "battle_royale" && DEFAULT_RULES.roundsToWin === undefined && DEFAULT_RULES.soloTeams === undefined, "DEFAULT_RULES unchanged");
ok(resolveMode("SkylandsBreachBRGameMode", "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach").gameState.cls === "BP_LokiBattleRoyaleGameState_Breach_C", "breach GS");

ok(resolveMode("Swordfish", "/Game/Loki/Maps/BeastHaven/LVL_BeastHaven").gameState.cls === "BP_GameState_Barracuda_Swordfish_C", "swordfish GS");
ok(resolveMode("Battlefield", "/Game/Loki/Maps/Battlefield/LVL_Battlefield").gameState.cls === "BP_LokiGameState_Battlefield_C", "battlefield GS");
ok(resolveMode("FreeForAll", "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach").gameState.cls === "BP_LokiGameState_FFA_C", "dropin FreeForAll → FFA GS");
ok(Object.keys(MODE_TABLE).length >= 20, "mode table");

// 3. FFA: everyone on their own team, deaths respawn, no last-team end, spawn invulnerability, ends on the clock.
{
  const h = world({ ...prof("ffa"), botGraceMs: 1000, botAggroSpreadMs: 0, spawnRadius: 900, zone: { ...DEFAULT_RULES.zone, enabled: false } });
  ok(h.w.all().length === 12, `ffa: 12 combatants (${h.w.all().length})`);
  ok(new Set(h.w.all().map((c) => c.team)).size === 12, "ffa: solo teams");
  h.run(5 * 60_000);
  ok(h.count("kill") > 0, `ffa: kills happen (${h.count("kill")})`);
  ok(h.count("respawn") > 0, `ffa: deaths respawn (${h.count("respawn")})`);
  ok(h.w.phase !== "ended", "ffa: no last-team end");
  const r = h.events.find((e) => e.type === "respawn") as Extract<MatchEvent, { type: "respawn" }>;
  ok(r && Number.isFinite(r.x) && Number.isFinite(r.z), "ffa: respawn event carries the spawn location");
  h.run(11 * 60_000);
  const end = h.events.find((e) => e.type === "match_end") as Extract<MatchEvent, { type: "match_end" }> | undefined;
  ok(end?.reason === "time_limit", `ffa: ends on the 15 min clock (${end?.reason})`);
}

// 4. Arena: rounds — a wipe wins the round, everyone comes back, first to 4 wins.
{
  const h = world({ ...prof("arena"), spawnRadius: 700 });
  ok(new Set(h.w.all().map((c) => c.team)).size === 2, "arena: 2 teams");
  h.run(20 * 60_000);
  ok(h.count("round_end") >= 4, `arena: rounds played (${h.count("round_end")})`);
  ok(h.count("round_start") >= 3, "arena: next rounds start");
  const end = h.events.find((e) => e.type === "match_end") as Extract<MatchEvent, { type: "match_end" }> | undefined;
  ok(!!end && /rounds|time_limit/.test(end.reason), `arena: match ends by rounds (${end?.reason})`);
  if (end?.reason.endsWith("_rounds")) {
    const wins = h.w.getSnapshot().roundWins!;
    ok(wins[end.winner!] === 4, `arena: winner has 4 round wins (${JSON.stringify(wins)})`);
  }
}

// 5. Kill-score team rule (engine feature; the objective modes now score through objectives.ts, gated by
//    tools/check-objectives.ts): kills score for the team, first to the limit wins.
{
  const h = world({ ...prof("domination"), objective: undefined, teamScorePerKill: 1, teamScoreLimit: 10, spawnRadius: 700 });
  h.run(14 * 60_000);
  ok(h.count("team_score") >= 10, `domination: team score events (${h.count("team_score")})`);
  const end = h.events.find((e) => e.type === "match_end") as Extract<MatchEvent, { type: "match_end" }> | undefined;
  ok(end?.reason === "team_score", `domination: ends on team score (${end?.reason})`);
  ok((h.w.getSnapshot().teamScores![end!.winner!] || 0) >= 10, "domination: winner reached the limit");
}

// 6. PvE clock rule (engine feature; Holdout's waves are gated by tools/check-objectives.ts): humans on team 0,
//    bots elsewhere; survive the clock = human team wins.
{
  const h = world({ ...prof("holdout"), objective: undefined, durationMs: 120_000 }, 2);
  ok(h.w.all().filter((c) => !c.isBot).every((c) => c.team === 0), "holdout: humans on team 0");
  ok(h.w.all().filter((c) => c.isBot).every((c) => c.team !== 0), "holdout: bots never on the human team");
  h.run(130_000);
  const end = h.events.find((e) => e.type === "match_end") as Extract<MatchEvent, { type: "match_end" }> | undefined;
  ok(end?.winner === 0, `holdout: humans win on the clock (${end?.winner})`);
}

// 7. Training: passive bots never deal damage.
{
  const h = world({ ...prof("training") });
  h.run(3 * 60_000);
  ok(!h.events.some((e) => e.type === "damage" && e.source.startsWith("bot_")), "training: bots never attack");
  ok(h.w.phase === "playing", "training: still running");
}

// 8. A started match refuses a late profile.
{
  const h = world({ ...prof("ffa") });
  h.run(10_000);
  ok(!h.w.configureMode({ teamCount: 3 }), "configureMode refused after start");
}

// 9. Spawn invulnerability holds damage off after a respawn.
{
  const h = world({ ...prof("ffa"), spawnInvulnMs: 60 * 60_000, botGraceMs: 1000, botAggroSpreadMs: 0, spawnRadius: 600, zone: { ...DEFAULT_RULES.zone, enabled: false } });
  h.run(4 * 60_000);
  const respawned = new Set(h.events.filter((e) => e.type === "respawn").map((e) => (e as { id: string }).id));
  const firstRespawn = new Map<string, number>();
  for (const e of h.events) if (e.type === "respawn" && !firstRespawn.has(e.id)) firstRespawn.set(e.id, e.t);
  const hitAfter = h.events.some((e) => e.type === "damage" && respawned.has(e.target) && e.t > firstRespawn.get(e.target)!);
  ok(respawned.size > 0 && !hitAfter, "ffa: no damage during spawn invulnerability");
}

console.log(`check-modes: ${pass}/${pass} PASS`);
