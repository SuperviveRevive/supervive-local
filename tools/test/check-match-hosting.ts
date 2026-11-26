// Gate: backend + the real match server process (match/run.ts) on loopback. Registration, allocation after
// Hero Select, the match server's own heartbeat + ready, players receiving the server address, the roster the
// match server fetches, completion, and deregistration. (Wire-level handshake: tools/test/match/check-ue-server.ts.)
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T } from "./t.ts";

const t = new T("match hosting");
const ROOT = join(import.meta.dir, "..", "..");
const BP = 25961, UDP = 27791, STATUS = 25962, B = `http://127.0.0.1:${BP}`;
const d = mkdtempSync(join(tmpdir(), "revive-mh-"));
mkdirSync(join(d, "generated"), { recursive: true });
writeFileSync(join(d, "generated", "catalog.json"), JSON.stringify({ generatedAt: "t", source: "synthetic", heroes: [{ id: "Hero:FireFox", ids: ["Hero:FireFox"], type: "Hero", name: "FireFox", path: "/Game/T/F.F", hero: "FireFox" }], heroCosmetics: [], emotes: [], titles: [], slotCosmetics: [], lobbyPlatforms: [], maps: [] }));
writeFileSync(join(d, "queues.json"), JSON.stringify({ queues: [{ id: "solo", alias: "SkylandsBreachBRGameMode", map: "/Game/Loki/Maps/SkylandsBreach/LVL_SkylandsBreach", teamSize: 1, teams: 4, maxPartySize: 1, botFill: true }] }));
const procs: any[] = [];
const get = async (p: string, tok = "") => { const r = await fetch(B + p, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }); return { status: r.status, j: await r.json().catch(() => null) }; };
const post = async (p: string, body: unknown, tok = "") => { const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => null) }; };
const until = async <X>(f: () => Promise<X>, ok: (x: X) => boolean, ms: number) => { const end = Date.now() + ms; let v = await f(); while (!ok(v) && Date.now() < end) { await Bun.sleep(200); v = await f(); } return v; };
try {
  procs.push(Bun.spawn(["bun", join(ROOT, "server/main.ts")], { env: { ...process.env, REVIVE_PORT: String(BP), REVIVE_DATA_DIR: d, REVIVE_HERO_SELECT_SECONDS: "1", REVIVE_BOT_FILL_SECONDS: "0", REVIVE_HOST_WAIT_SECONDS: "20" }, stdout: "ignore", stderr: "ignore" }));
  await until(() => fetch(`${B}/revive/health`).then((r) => r.ok).catch(() => false), (x) => x, 8000);
  procs.push(Bun.spawn(["bun", join(ROOT, "match/run.ts")], { env: { ...process.env, REVIVE_PORT: String(BP), REVIVE_MATCH_PORT: String(UDP), REVIVE_MATCH_STATUS_PORT: String(STATUS), REVIVE_DATA_DIR: d }, stdout: "ignore", stderr: "ignore" }));
  const reg = await until(() => get("/api/ds/servers"), (r) => r.j?.servers?.length === 1, 15000);
  t.ok("match server registers itself with the backend", reg.j?.servers?.[0]?.port === UDP && reg.j.servers[0].address === "127.0.0.1", JSON.stringify(reg.j));
  const status = await until(() => fetch(`http://127.0.0.1:${STATUS}/status`).then((r) => r.json()).catch(() => null), (x) => !!x, 5000);
  t.ok("match server status endpoint answers", !!status);

  const login = await post("/revive/login", { displayName: "Host" });
  const tok = (await fetch(`${B}/iam/v3/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=authorization_code&code=${login.j.authCode}` }).then((r) => r.json())).access_token;
  const party = (await get("/party/parties", tok)).j;
  await post(`/party/parties/${party.ID}/joinQueue`, { QueueID: "solo" }, tok);
  const mid = (await until(() => get(`/core-game/players/${login.j.userId}`, tok), (r) => !!r.j?.MatchID, 5000)).j.MatchID;
  t.ok("queue forms a match (1 human + 3 bots)", !!mid);
  const det = await get(`/core-game/matches/${mid}/details`);
  t.ok("details carry the Teams roster the match server reads", det.j?.Teams?.length === 4 && det.j.Teams.flatMap((x: any) => x.Members).some((m: any) => m.UserId === login.j.userId && m.HeroId === "Hero:FireFox"));
  const live = await until(() => get(`/core-game/matches/${mid}`, tok), (r) => r.j?.State === "InProgress", 20000);
  t.eq("the match server picks the allocation up from its heartbeat and reports ready", live.j?.State, "InProgress");
  t.eq("players get the match server address", live.j?.ConnectionDetails?.address, `127.0.0.1:${UDP}`);
  const st2 = await until(() => fetch(`http://127.0.0.1:${STATUS}/status`).then((r) => r.json()).catch(() => null), (x: any) => JSON.stringify(x || {}).includes(mid), 8000);
  t.ok("match server is now running that match", JSON.stringify(st2 || {}).includes(mid));
  const done = await post(`/core-game/matches/${mid}/complete`, { Results: [] });
  t.eq("completion ends the match", done.j?.State, "Complete");
  const back = await get(`/core-game/players/${login.j.userId}`, tok);
  t.eq("player back in the lobby", back.j?.MatchID, "");
  procs[1].kill("SIGTERM");
  const gone = await until(() => get("/api/ds/servers"), (r) => (r.j?.servers?.length ?? 1) === 0, 6000);
  t.ok("match server deregisters on shutdown", gone.j?.servers?.length === 0);
} catch (e) {
  t.ok("gate crashed", false, String((e as Error).stack || e));
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  rmSync(d, { recursive: true, force: true });
}
t.done();
