// SUPERVIVE Revive — Local Edition: local stand-in for the Agones SDK sidecar.  [EXPERIMENTAL]
//
// The game's server mode talks to an Agones SDK sidecar on http://localhost:9358 (the public Agones
// SDK REST surface: /ready, /health, /gameserver, ws://.../watch/gameserver, /metadata/*, /allocate,
// /reserve, /shutdown). On the host PC this process plays that role and links it to the local backend:
//
//   - registers this PC as a match host with the backend (LAN address + UDP port),
//   - reports Ready/Shutdown when the server process says so,
//   - flips to Allocated (and pushes a watch update) when the backend assigns a match to this host.
//
//   bun client/agones-sdk.mjs --backend http://127.0.0.1:24970 [--port 9358] [--match-port 7777] [--public-host <lan ip>]
//
// Which label/annotation keys the game reads after allocation is not known; the match id is published
// under the keys in REVIVE_AGONES_KEYS (comma separated). See docs/GAME-SERVER-MODE.md.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = new URL(opt("backend", process.env.REVIVE_BACKEND || "http://127.0.0.1:24970"));
const SDK_PORT = Number(opt("port", process.env.AGONES_SDK_HTTP_PORT || 9358));
const MATCH_PORT = Number(opt("match-port", process.env.REVIVE_MATCH_PORT || 7777));
const DATA = path.resolve(opt("data", process.env.REVIVE_DATA_DIR || path.join(HERE, "..", "local-data")));
const KEYS = (process.env.REVIVE_AGONES_KEYS || "matchId,sessionId,session-id").split(",").map((s) => s.trim()).filter(Boolean);
const LOG_FILE = path.join(DATA, "logs", "agones-sdk.log");

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    if (i.family === "IPv4" && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address;
  }
  return "127.0.0.1";
}
const PUBLIC_HOST = opt("public-host", process.env.REVIVE_PUBLIC_HOST || lanIp());

function log(m) {
  const line = `${new Date().toISOString()} [agones-sdk] ${m}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

const gs = {
  state: "Scheduled",
  labels: {},
  annotations: {},
  matchId: null,
  hostId: null,
  hostKey: null,
  lastHealth: 0,
};

function gameServer() {
  return {
    object_meta: {
      name: "revive-local-host", namespace: "default", uid: gs.hostId || "pending",
      resource_version: String(Date.now()), generation: "1",
      creation_timestamp: String(Math.floor(Date.now() / 1000)), deletion_timestamp: "0",
      annotations: gs.annotations, labels: gs.labels,
    },
    spec: { health: { disabled: false, period_seconds: 5, failure_threshold: 3, initial_delay_seconds: 0 } },
    status: { state: gs.state, address: PUBLIC_HOST, ports: [{ name: "default", port: MATCH_PORT }], players: null },
  };
}

// ---- watch subscribers: WebSocket (current Agones UE plugin) and chunked HTTP (REST gateway) ------
const wsClients = new Set();
const streamClients = new Set();

function wsFrame(text) {
  const p = Buffer.from(text);
  const h = p.length < 126 ? Buffer.from([0x81, p.length])
    : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p.length)); return b; })()]);
  return Buffer.concat([h, p]);
}

function broadcast() {
  const msg = JSON.stringify({ result: gameServer() });
  for (const s of wsClients) { try { s.write(wsFrame(msg)); } catch { wsClients.delete(s); } }
  for (const r of streamClients) { try { r.write(msg + "\n"); } catch { streamClients.delete(r); } }
}

function setState(state) {
  if (gs.state === state) return;
  log(`state ${gs.state} -> ${state}`);
  gs.state = state;
  broadcast();
  report().catch(() => {});
}

// ---- backend link ------------------------------------------------------------------------------
async function backend(method, p, body) {
  const r = await fetch(new URL(p, BACKEND), {
    method,
    headers: { "content-type": "application/json", accept: "application/json", ...(gs.hostKey ? { "x-revive-host-key": gs.hostKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}

async function register() {
  const r = await backend("POST", "/revive/hosts", { address: PUBLIC_HOST, port: MATCH_PORT, name: os.hostname() });
  if (r.status !== 200 || !r.json?.hostId) throw new Error(`register failed: HTTP ${r.status}`);
  gs.hostId = r.json.hostId;
  gs.hostKey = r.json.hostKey;
  log(`registered as host ${gs.hostId} at ${PUBLIC_HOST}:${MATCH_PORT}`);
}

async function report() {
  if (!gs.hostId) return;
  const r = await backend("POST", `/revive/hosts/${gs.hostId}/heartbeat`, { state: gs.state, matchId: gs.matchId, healthyAt: gs.lastHealth });
  if (r.status === 404) { gs.hostId = null; return; }
  const a = r.json?.assignment;
  if (a?.matchId && a.matchId !== gs.matchId) {
    gs.matchId = a.matchId;
    for (const k of KEYS) { gs.labels[k] = a.matchId; gs.annotations[k] = a.matchId; }
    if (a.coreGameUrl) gs.annotations.coreGameUrl = a.coreGameUrl;
    log(`assigned match ${a.matchId}`);
    if (gs.state === "Ready" || gs.state === "Scheduled" || gs.state === "RequestReady") setState("Allocated"); else broadcast();
  } else if (!a && gs.matchId) {
    log(`match ${gs.matchId} released`);
    gs.matchId = null;
    for (const k of KEYS) { delete gs.labels[k]; delete gs.annotations[k]; }
    broadcast();
  }
}

async function loop() {
  try { if (!gs.hostId) await register(); await report(); }
  catch (e) { log(`backend: ${e.message}`); }
  setTimeout(loop, 2000);
}

// ---- SDK HTTP surface ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
  req.on("end", () => {
    const p = u.pathname.replace(/\/+$/, "") || "/";
    let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch {}
    const ok = (obj = {}) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (p !== "/health") log(`${req.method} ${p}${body ? ` ${body.slice(0, 200)}` : ""}`);
    switch (p) {
      case "/ready": setState(gs.matchId ? "Allocated" : "Ready"); return ok();
      case "/health": gs.lastHealth = Date.now(); return ok();
      case "/allocate": setState("Allocated"); return ok();
      case "/reserve": setState("Reserved"); return ok();
      case "/shutdown": setState("Shutdown"); return ok();
      case "/gameserver": return ok(gameServer());
      case "/metadata/label": if (parsed.key) gs.labels[parsed.key] = String(parsed.value ?? ""); broadcast(); return ok();
      case "/metadata/annotation": if (parsed.key) gs.annotations[parsed.key] = String(parsed.value ?? ""); broadcast(); return ok();
      case "/watch/gameserver":
        res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
        res.write(JSON.stringify({ result: gameServer() }) + "\n");
        streamClients.add(res);
        req.on("close", () => streamClients.delete(res));
        return;
      case "/revive/state": return ok({ ...gs, hostKey: undefined, address: PUBLIC_HOST, port: MATCH_PORT, watchers: wsClients.size + streamClients.size });
      default:
        if (p.startsWith("/alpha/") || p.startsWith("/v1beta1/")) return ok({});
        res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
    }
  });
});

server.on("upgrade", (req, sock) => {
  const u = new URL(req.url, "http://localhost");
  const key = req.headers["sec-websocket-key"];
  if (u.pathname !== "/watch/gameserver" || !key) return sock.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  wsClients.add(sock);
  sock.write(wsFrame(JSON.stringify({ result: gameServer() })));
  sock.on("data", (d) => {
    const op = d[0] & 0x0f;
    if (op === 0x9) sock.write(Buffer.from([0x8a, 0x00]));
    if (op === 0x8) { wsClients.delete(sock); sock.end(); }
  });
  sock.on("close", () => wsClients.delete(sock));
  sock.on("error", () => wsClients.delete(sock));
  log("watch websocket connected");
});

server.listen(SDK_PORT, "127.0.0.1", () => log(`Agones SDK stand-in on 127.0.0.1:${SDK_PORT}, backend ${BACKEND.origin}, match ${PUBLIC_HOST}:${MATCH_PORT}`));
loop();
