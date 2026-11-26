import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
// the zone tests below damage a human; that is opt-in since 2026-11-25 (sim-only storm), so opt in before match.ts loads
process.env.LOKI_ZONE_HITS_HUMANS ??= "1";
const { MatchWorld, DEFAULT_RULES } = await import("../../../match/match.ts");

function harness(rules: Record<string, unknown> = {}) {
  let t = 1_000_000;
  let seed = 42;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const events: any[] = [];
  const w = new MatchWorld({
    minPlayers: 2, botCount: 5, maxPlayers: 6, fillBots: true,
    countdownMs: 1000, durationMs: 120_000, zone: { enabled: false },
    ...rules,
  }, { now: () => t, rng, onEvent: (e) => events.push(e) });
  return {
    w, events,
    advance(ms: number, step = 50) {
      for (let left = ms; left > 0; left -= step) { t += Math.min(step, left); w.tick(Math.min(step, left) / 1000); }
    },
    setTime(v: number) { t = v; },
  };
}

// 1. player + bot fill, unique BR teams, deterministic spawn
{
  const h = harness();
  const a = h.w.addPlayer("p1", "player1");
  assert.equal(a.team, 0);
  assert.ok(a.hp >= 1100 && a.hp <= 1510, "retail per-hero MaxHealth");
  assert.equal(h.w.botCount(), 5);
  assert.equal(h.w.all().length, 6);
  assert.equal(new Set(h.w.all().map((c) => c.team)).size, 6, "BR teams must be unique");
  assert.equal(h.w.phase, "countdown");
  assert.ok(h.events.some((e) => e.type === "bot_fill"));
}

// 2. no countdown recursion and transition to playing
{
  const h = harness();
  h.w.addPlayer("p1", "one");
  assert.equal(h.w.phase, "countdown");
  h.advance(1100);
  assert.equal(h.w.phase, "playing");
  assert.ok(h.events.some((e) => e.type === "match_start"));
}

// 3. movement integrates input and respects speed cap
{
  const h = harness({ countdownMs: 0, mode: "deathmatch", teamCount: 2 });
  const p = h.w.addPlayer("p1", "one", { team: 0 });
  const x0 = p.x;
  h.w.setInput("p1", { my: 1, yaw: 0 });
  h.advance(1000);
  assert.ok(p.x > x0 + 100, `expected forward movement, got ${p.x - x0}`);
  assert.ok(Math.hypot(p.vx, p.vy) <= DEFAULT_RULES.moveSpeed * DEFAULT_RULES.sprintMultiplier + 1);
  h.w.setInput("p1", { my: 0, mx: 0 });
  h.advance(1000);
  assert.ok(Math.hypot(p.vx, p.vy) < 50, "friction should stop movement");
}

// 4. ability cooldown + mana + damage + ability event
{
  const h = harness({ countdownMs: 0, mode: "deathmatch", teamCount: 2, botCount: 1, maxPlayers: 2 });
  const p = h.w.addPlayer("p1", "one", { team: 0 });
  const bot = h.w.all().find((c) => c.isBot)!;
  bot.team = 1;
  bot.x = p.x + 300; bot.y = p.y;
  p.yaw = 0;
  const hp0 = bot.hp + bot.shield;
  assert.equal(h.w.requestAbility("p1", "bolt").ok, true);
  assert.ok(bot.hp + bot.shield < hp0, "bolt should damage the target (shield first)");
  const mana = p.mana;
  assert.equal(h.w.requestAbility("p1", "bolt").ok, false, "cooldown must block second cast");
  assert.equal(p.mana, mana, "blocked cast must not spend mana");
  h.advance(6000);
  assert.ok(p.mana > mana - 30, "mana regenerates");
}

// 5. kill scoring + killfeed + forced finish
{
  const h = harness({ countdownMs: 0, mode: "deathmatch", teamCount: 2, botCount: 1, maxPlayers: 2, respawnMs: -1 });
  const p = h.w.addPlayer("p1", "one", { team: 0 });
  const bot = h.w.all().find((c) => c.isBot)!;
  bot.team = 1;
  bot.hp = 1; bot.shield = 0;
  bot.x = p.x + 200; bot.y = p.y;
  p.yaw = 0;
  h.w.requestAbility("p1", "bolt");
  assert.equal(p.kills, 1);
  assert.equal(p.score, 350, "100 kill + 250 win bonus");
  assert.ok(h.events.some((e) => e.type === "kill" && e.killer === "p1" && e.victim === bot.id));
  assert.equal(h.w.phase, "ended", "last team alive should end the match");
  assert.equal(h.w.result.winner, 0);
  assert.equal(h.w.result.results.length, 1);
  assert.equal(h.w.result.results[0]!.kills, 1);
}

// 6. zone shrinks and damages out-of-zone combatants
{
  const h = harness({
    countdownMs: 0, mode: "battle_royale", minPlayers: 2, botCount: 1, maxPlayers: 2,
    zone: { enabled: true, startRadius: 500, endRadius: 100, shrinkStartMs: 0, shrinkEndMs: 1000, dps: 20 },
  });
  const p = h.w.addPlayer("p1", "one");
  const before = p.hp + p.shield;
  h.advance(1000);
  h.advance(1000);
  assert.ok(p.hp + p.shield < before, "outside zone should damage shield/hp");
  assert.ok(h.w.currentZone().radius < 500, "zone should shrink");
}

// 7. respawn path
{
  const h = harness({
    countdownMs: 0, mode: "deathmatch", teamCount: 2, botCount: 1, maxPlayers: 2,
    respawnMs: 500, scoreLimit: 0,
  });
  const p = h.w.addPlayer("p1", "one", { team: 0 });
  const bot = h.w.all().find((c) => c.isBot)!;
  bot.team = 1; bot.hp = 1; bot.shield = 0; bot.x = p.x + 200; bot.y = p.y; p.yaw = 0;
  h.w.requestAbility("p1", "bolt");
  assert.equal(p.alive, true);
  assert.equal(bot.alive, false);
  h.advance(600);
  assert.equal(bot.alive, true, "bot should respawn");
  assert.equal(bot.hp, bot.maxHp);
  assert.ok(h.events.some((e) => e.type === "respawn"));
}

// 8. time limit ends match with highest score
{
  const h = harness({ countdownMs: 0, mode: "deathmatch", teamCount: 2, botCount: 1, maxPlayers: 2, durationMs: 2000, scoreLimit: 0 });
  const p = h.w.addPlayer("p1", "one", { team: 0 });
  p.score = 500;
  h.advance(2100);
  assert.equal(h.w.phase, "ended");
  assert.equal(h.w.result.winner, 0);
  assert.equal(h.w.result.reason, "time_limit");
}

console.log("UE match simulation: bot fill, teams, movement, abilities, combat, zone, respawn, win conditions pass");

// 9. usmap-derived mode tables (ELokiGameModeType / ERoundPhase + registry-verified classes)
{
  const enums = JSON.parse(readFileSync("match/data/usmap-enums-204.json","utf8")).enums as Record<string, Record<string, number>>;
  assert.equal(enums.ELokiGameModeType.BattleRoyale, 1);
  assert.equal(enums.ELokiGameModeType.LastMan, 2);
  assert.equal(enums.ELokiGameModeType.Barracuda, 3);
  assert.equal(enums.ELokiGameModeType.Tournament, 4);
  assert.equal(enums.ELokiGameModeType.Domination, 5);
  assert.equal(enums.ELokiGameModeType.PrismaBank, 6);
  assert.equal(enums.ERoundPhase.EGP_SpawnSelect, 4);
  assert.equal(enums.ERoundPhase.EGP_SpawnReveal, 5);
  assert.equal(enums.ERoundPhase.EGP_Lineup, 6);
  assert.equal(enums.ERoundPhase.EGP_Combat, 7);
  assert.equal(enums.ERoundPhase.EGP_Post, 8);

  const { resolveMode, MODE_TABLE, ELOKI_GAME_MODE_TYPE, E_ROUND_PHASE } = await import("../../../match/modeconfig.ts");
  assert.equal(ELOKI_GAME_MODE_TYPE === enums.ELokiGameModeType, false, "modeconfig must deep-verify, not alias");
  assert.equal(E_ROUND_PHASE.EGP_Combat, 7);
  assert.ok(Object.keys(MODE_TABLE).length >= 10);

  const breach = resolveMode("SkylandsBreachBRGameMode", "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach");
  assert.equal(breach.gameModeType, 1);
  assert.equal(breach.gameState?.cls, "BP_LokiBattleRoyaleGameState_Breach_C");
  const dom = resolveMode("Domination", "/Game/Loki/Maps/Domination/LVL_Domination_V2");
  assert.equal(dom.gameModeType, 5);
  assert.equal(dom.gameState?.cls, "BP_DominationGameState_C");
  const arena = resolveMode("LastManGameMode", "/Game/Loki/Maps/LVL_Lastman/LVL_Lastman");
  assert.equal(arena.gameState?.cls, "BP_LokiGameStateLastMan_C");
  const barracuda = resolveMode("BarracudaGameMode", "/Game/Loki/Maps/BeastHaven/LVL_BeastHaven");
  assert.equal(barracuda.gameState?.cls, "BP_GameState_Barracuda_C");
  const swordfish = resolveMode("SwordfishGameMode", "/Game/Loki/Maps/BeastHaven/LVL_BeastHaven");
  assert.equal(swordfish.gameState?.cls, "BP_GameState_Barracuda_Swordfish_C");
  const prisma = resolveMode("PrismaBankGameMode", "/Game/Loki/Maps/PrismaBank/LVL_PrismaBank_01");
  assert.equal(prisma.gameState?.cls, "BP_PrismaBankGameState_C");
  const tourney = resolveMode("Tournament", "/Game/Loki/Maps/Bracket/LVL_Bracket_01");
  assert.equal(tourney.gameState?.cls, "BP_TournamentGameState_C");
  const soccervive = resolveMode("SoccerviveGameMode", "/Game/Loki/Maps/GrindBall/LVL_GrindBallArena_01");
  assert.equal(soccervive.gameState?.cls, "BP_SoccerviveGameState_C");

}

// 10. round-phase lifecycle on the snapshot (EGP codes)
{
  const h = harness();
  h.w.addPlayer("p1", "player1");
  assert.ok([4, 5, 6].includes(h.w.getSnapshot().roundPhaseCode), "pre-combat = SpawnSelect/SpawnReveal/Lineup (bot fill starts the countdown at once)");
  h.advance(1100);
  assert.ok([5, 6, 7].includes(h.w.getSnapshot().roundPhaseCode), "countdown = SpawnReveal/Lineup, or already Combat");
  h.advance(1000);
  assert.equal(h.w.getSnapshot().roundPhaseCode, 7, "playing = Combat");
}

console.log("UE match usmap tables + round lifecycle pass");
