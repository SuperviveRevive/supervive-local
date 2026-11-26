// SUPERVIVE Revive — Local Edition backend.   bun start
import { addressAllowed, BIND, DATA_DIR, EXPERIMENTAL_HOSTING, LAN, PORT, PUBLIC_HOST, VERSION } from "./lib/config.ts";
import { profileFromToken } from "./lib/accounts.ts";
import { error, nsFromPath, type Ctx } from "./lib/http.ts";
import { handlePlay } from "./lib/play.ts";
import { fallback, handleServices } from "./lib/services.ts";
import { lobbyClose, lobbyMessage, lobbyOpen } from "./lib/lobby.ts";
import { messengerClose, messengerMessage, messengerOpen } from "./lib/messenger.ts";
import { catalog, queues } from "./lib/catalog.ts";

type WsData = { kind: "lobby" | "messenger"; userId: string; namespace: string; buf?: string };
let NAMESPACE = process.env.REVIVE_NAMESPACE || "";

const bearer = (req: Request, url: URL) =>
  req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || url.searchParams.get("token") || url.searchParams.get("access_token") || "";

const server = Bun.serve<WsData, undefined>({
  hostname: BIND,
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const ip = srv.requestIP(req)?.address || "";
    if (!addressAllowed(ip)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/{2,}/g, "/");
    const ns = nsFromPath(path);
    if (ns && !NAMESPACE) NAMESPACE = ns;

    const token = bearer(req, url);
    const user = profileFromToken(token) || null;

    if (path === "/lobby" || path === "/lobby/" || path.startsWith("/lobby/notifications") || path.startsWith("/messenger")) {
      if (!user) return error(401, "unauthorized");
      const kind = path.startsWith("/lobby/notifications") || path.startsWith("/messenger") ? "messenger" : "lobby";
      if (srv.upgrade(req, { data: { kind, userId: user.userId, namespace: NAMESPACE || ns || "" } })) return undefined as unknown as Response;
      return error(400, "websocket upgrade required");
    }

    let bodyText = "";
    let body: any = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      bodyText = await req.text();
      if (bodyText) {
        try { body = JSON.parse(bodyText); }
        catch { body = Object.fromEntries(new URLSearchParams(bodyText)); }
      }
    }
    const c: Ctx = { req, url, path, method: req.method, body: body && typeof body === "object" ? body : {}, bodyText, namespace: ns || NAMESPACE || "", user, ip };
    try {
      return handleServices(c) || handlePlay(c) || fallback(c);
    } catch (e) {
      console.error(`[error] ${req.method} ${path}:`, e);
      return error(500, "internal error");
    }
  },
  websocket: {
    open(ws) { ws.data.kind === "lobby" ? lobbyOpen(ws as any) : messengerOpen(ws, ws.data.userId); },
    message(ws, msg) {
      const text = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8");
      ws.data.kind === "lobby" ? lobbyMessage(ws as any, text) : messengerMessage(ws, text);
    },
    close(ws) { ws.data.kind === "lobby" ? lobbyClose(ws as any) : messengerClose(ws, ws.data.userId); },
  },
});

const cat = catalog();
console.log(`SUPERVIVE Revive — Local Edition ${VERSION}`);
console.log(`  backend   http://${server.hostname}:${server.port}  (${LAN ? `LAN mode, friends connect to http://${PUBLIC_HOST}:${server.port}` : "this PC only"})`);
console.log(`  data      ${DATA_DIR}`);
console.log(`  catalog   ${cat.generatedAt ? `${cat.heroes.length} hunters, ${cat.maps.length} maps` : "none — run: bun run setup -- --game \"<install>\" --listing <file>"}`);
console.log(`  queues    ${queues().length ? queues().map((q) => q.id).join(", ") : "none — see docs/SETUP.md (queues.json)"}`);
console.log(`  hosting   ${EXPERIMENTAL_HOSTING ? "EXPERIMENTAL host-run match servers enabled" : "off — matches end after Hero Select (REVIVE_EXPERIMENTAL_HOSTING=1 to try hosting)"}`);
