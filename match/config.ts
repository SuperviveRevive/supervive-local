import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES, type MatchRules } from "./match.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export interface ServerConfig {
  rules: MatchRules;
  guidPaths: Record<string, string>;
  adminToken: string;
  autoComplete: boolean;
  inputTimeoutMs: number;
  heartbeatMs: number;
  tickHz: number;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value) &&
        out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out as T;
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function boolEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return undefined;
}

export function loadMatchRules(): MatchRules {
  let rules: MatchRules = {
    ...DEFAULT_RULES,
    shot: { ...DEFAULT_RULES.shot },
    zone: { ...DEFAULT_RULES.zone },
    abilities: DEFAULT_RULES.abilities.map((a) => ({ ...a })),
  };

  const builtIn = `${HERE}data/match-config.json`;
  const path = process.env.LOKI_MATCH_CONFIG || builtIn;
  if (existsSync(path)) {
    try { rules = deepMerge(rules, JSON.parse(readFileSync(path, "utf8"))); }
    catch (err) { console.error(`[config] could not parse ${path}:`, err); }
  }

  const overrides: Record<string, unknown> = {};
  const scalarEnv: Array<[string, keyof MatchRules]> = [
    ["LOKI_MATCH_MODE", "mode"],
    ["LOKI_MATCH_MAX_PLAYERS", "maxPlayers"],
    ["LOKI_MATCH_MIN_PLAYERS", "minPlayers"],
    ["LOKI_MATCH_TEAMS", "teamCount"],
    ["LOKI_MATCH_BOTS", "botCount"],
    ["LOKI_MATCH_DURATION_MS", "durationMs"],
    ["LOKI_MATCH_RESPAWN_MS", "respawnMs"],
    ["LOKI_MATCH_SCORE_LIMIT", "scoreLimit"],
    ["LOKI_MATCH_COUNTDOWN_MS", "countdownMs"],
  ];
  for (const [env, key] of scalarEnv) {
    const raw = process.env[env];
    if (raw === undefined || raw === "") continue;
    overrides[key] = key === "mode" ? raw : Number(raw);
  }
  const fill = boolEnv("LOKI_MATCH_FILL_BOTS");
  if (fill !== undefined) overrides.fillBots = fill;

  const zone: Record<string, unknown> = {};
  const zoneEnv: Array<[string, string]> = [
    ["LOKI_ZONE_ENABLED", "enabled"],
    ["LOKI_ZONE_START_RADIUS", "startRadius"],
    ["LOKI_ZONE_END_RADIUS", "endRadius"],
    ["LOKI_ZONE_DPS", "dps"],
  ];
  for (const [env, key] of zoneEnv) {
    const raw = process.env[env];
    if (raw === undefined || raw === "") continue;
    zone[key] = key === "enabled" ? raw === "1" || raw.toLowerCase() === "true" : Number(raw);
  }
  if (Object.keys(zone).length) overrides.zone = zone;

  if (Object.keys(overrides).length) rules = deepMerge(rules, overrides);
  return rules;
}

export function loadGuidPaths(): Record<string, string> {
  const path = `${HERE}data/netguid-map.json`;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { paths?: Record<string, string> };
    return data.paths || {};
  } catch { return {}; }
}

export function loadServerConfig(): ServerConfig {
  return {
    rules: loadMatchRules(),
    guidPaths: loadGuidPaths(),
    adminToken: process.env.LOKI_ADMIN_TOKEN || "",
    autoComplete: process.env.LOKI_DS_AUTO_COMPLETE !== "0",
    inputTimeoutMs: numberEnv("LOKI_MATCH_INPUT_TIMEOUT_MS") ?? 15_000,
    heartbeatMs: numberEnv("LOKI_DS_HEARTBEAT_MS") ?? 15_000,
    tickHz: numberEnv("LOKI_MATCH_TICK_HZ") ?? 20,
  };
}
