// Runtime configuration from the environment / `.env` (Bun loads `.env` automatically).
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
const flag = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
    }
  }
  return "127.0.0.1";
}

export const LAN = flag(env.REVIVE_LAN);
export const BIND = env.REVIVE_BIND || (LAN ? "0.0.0.0" : "127.0.0.1");
export const PORT = num(env.REVIVE_PORT, 24970);
export const DATA_DIR = resolve(env.REVIVE_DATA_DIR || "./local-data");
export const PUBLIC_HOST = env.REVIVE_PUBLIC_HOST || (LAN ? lanAddress() : "127.0.0.1");
export const MATCH_PORT = num(env.REVIVE_MATCH_PORT, 7777);
export const BOT_FILL_MS = num(env.REVIVE_BOT_FILL_SECONDS, 20) * 1000;
export const EXPERIMENTAL_HOSTING = env.REVIVE_EXPERIMENTAL_HOSTING === undefined || env.REVIVE_EXPERIMENTAL_HOSTING === "" ? true : flag(env.REVIVE_EXPERIMENTAL_HOSTING);
export const HERO_SELECT_MS = num(env.REVIVE_HERO_SELECT_SECONDS, 30) * 1000;
export const HOST_WAIT_MS = num(env.REVIVE_HOST_WAIT_SECONDS, 90) * 1000;
export const VERSION = "0.1.0";

/** Loopback is always allowed; in LAN mode private ranges are allowed too; nothing else ever is. */
export function addressAllowed(ip: string | undefined): boolean {
  const a = String(ip || "").replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1" || a === "") return true;
  if (!LAN) return false;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fd|fc)/i.test(a);
}
