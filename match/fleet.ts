#!/usr/bin/env bun
/**
 * Fleet supervisor: runs N independent game-server instances on consecutive
 * UDP ports and gives each its own HTTP status endpoint and serverId.
 *
 * Usage:
 *   bun server/ue/fleet.ts                       # uses LOKI_FLEET_PORTS
 *   LOKI_FLEET_PORTS=7777-7780 bun server/ue/fleet.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = `${HERE}server.ts`;

export function parsePorts(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]), to = Number(range[2]);
      if (from > 0 && to >= from) for (let p = from; p <= to; p++) out.add(p);
      continue;
    }
    const port = Number(token);
    if (Number.isInteger(port) && port > 0 && port < 65536) out.add(port);
  }
  return Array.from(out).sort((a, b) => a - b);
}

interface Instance { port: number; httpPort: number; child: ChildProcess; startedAt: number; }

async function main() {
  const ports = parsePorts(process.env.LOKI_FLEET_PORTS || "7777-7780");
  if (!ports.length) throw new Error("no fleet ports configured");
  const baseHttp = Number(process.env.LOKI_FLEET_HTTP_BASE || 24980);
  const controlPort = Number(process.env.LOKI_FLEET_CONTROL_PORT || 24990);
  const instances: Instance[] = [];

  function startInstance(port: number, httpPort: number) {
    const child = spawn(process.execPath, [SERVER], {
      cwd: HERE,
      env: {
        ...process.env,
        LOKI_UE_PORT: String(port),
        LOKI_DS_HTTP_PORT: String(httpPort),
        LOKI_DS_SERVER_ID: process.env.LOKI_DS_SERVER_ID
          ? `${process.env.LOKI_DS_SERVER_ID}-${port}` : `loki-ue-${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => process.stdout.write(`[fleet:${port}] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[fleet:${port}] ${d}`));
    instances.push({ port, httpPort, child, startedAt: Date.now() });
    child.on("exit", (code) => {
      console.log(`[fleet] instance ${port} exited (${code}); restarting in 2s`);
      setTimeout(() => startInstance(port, httpPort), 2000);
    });
  }

  ports.forEach((port, i) => startInstance(port, baseHttp + i));

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      ports,
      instances: instances.map((i) => ({
        udpPort: i.port, httpPort: i.httpPort, pid: i.child.pid,
        alive: i.child.exitCode === null, uptimeSeconds: Math.floor((Date.now() - i.startedAt) / 1000),
        statusUrl: `http://127.0.0.1:${i.httpPort}/status`,
      })),
    }));
  });
  server.listen(controlPort, "0.0.0.0", () => console.log(`[fleet] control http://0.0.0.0:${controlPort}`));

  const shutdown = () => {
    server.close();
    for (const i of instances) i.child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) void main();
