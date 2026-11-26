// Host-run match server for the Local Edition:  bun run match   (on the host PC, next to `bun start`)
//
// Starts the clean-room SUPERVIVE 2.0.4 match server on UDP REVIVE_MATCH_PORT (default 7777), registers this
// PC with the local backend as a match host, and takes the matches the backend allocates to it.
import { networkInterfaces } from "node:os";

const env = process.env;
function lanIp() {
  for (const list of Object.values(networkInterfaces())) for (const i of list || []) {
    if (i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
  }
  return "127.0.0.1";
}
const set = (k: string, v: string) => { if (env[k] === undefined || env[k] === "") env[k] = v; };
set("LOKI_BACKEND_URL", env.REVIVE_BACKEND || `http://127.0.0.1:${env.REVIVE_PORT || 24970}`);
set("LOKI_UE_PORT", env.REVIVE_MATCH_PORT || "7777");
set("LOKI_DS_PUBLIC_HOST", env.REVIVE_PUBLIC_HOST || (env.REVIVE_LAN === "1" ? lanIp() : "127.0.0.1"));
set("LOKI_DS_PUBLIC_PORT", env.REVIVE_MATCH_PORT || "7777");
set("LOKI_DS_HTTP_PORT", env.REVIVE_MATCH_STATUS_PORT || "24977");
set("LOKI_DS_REGION", "local");
set("LOKI_DS_HEARTBEAT_MS", "2000");

const { startUEGameServer } = await import("./server.ts");
const server = startUEGameServer();
console.log(`match server: UDP ${env.LOKI_DS_PUBLIC_HOST}:${env.LOKI_UE_PORT}, backend ${env.LOKI_BACKEND_URL}, status http://127.0.0.1:${env.LOKI_DS_HTTP_PORT}/status`);
const bye = async () => {
  await Promise.race([
    fetch(`${env.LOKI_BACKEND_URL}/api/ds/servers/${encodeURIComponent((server as any).serverId)}`, { method: "DELETE" }).catch(() => {}),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  process.exit(0);
};
process.once("SIGTERM", bye);
process.once("SIGINT", bye);
