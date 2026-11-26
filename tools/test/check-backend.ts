// Gate: the backend end to end against a throwaway data dir with a synthetic catalog (no game data).
// Covers login → token grants → identity → config → ownership → lobby + messenger websockets →
// parties/invites → matchmaking with bot fill → Hero Select → the hosting decision, both with hosting
// off and with a real client/agones-sdk.mjs process playing the host PC.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T } from "./t.ts";

const t = new T("backend");
const ROOT = join(import.meta.dir, "..", "..");
const procs: { kill(): void }[] = [];
const dirs: string[] = [];

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "revive-be-"));
  dirs.push(d);
  mkdirSync(join(d, "generated"), { recursive: true });
  const e = (type: string, name: string, extra = {}) => ({ id: `${type}:${name}`, ids: [`${type}:${name}`, `${type}:${name.toLowerCase()}`], type, name, path: `/Game/Test/${name}.${name}`, ...extra });
  writeFileSync(join(d, "generated", "catalog.json"), JSON.stringify({
    generatedAt: "test", source: "synthetic",
    heroes: [e("Hero", "Alpha", { hero: "Alpha" }), e("Hero", "Beta", { hero: "Beta" })],
    heroCosmetics: [e("HeroCosmeticsBundle", "AlphaDefault", { hero: "Alpha" }), e("HeroCosmeticsBundle", "BetaDefault", { hero: "Beta" })],
    emotes: [e("Emote", "Wave")], titles: [], slotCosmetics: [], lobbyPlatforms: [],
    maps: [{ id: "Map:/Game/Test/LVL_Test", ids: [], type: "Map", name: "LVL_Test", path: "/Game/Test/LVL_Test" }],
  }));
  writeFileSync(join(d, "queues.json"), JSON.stringify({ queues: [
    { id: "duo-test", name: "Duo Test", alias: "TestMode", map: "/Game/Test/LVL_Test", teamSize: 2, teams: 2, maxPartySize: 2, botFill: true },
    { id: "solo-test", name: "Solo", alias: "TestMode", map: "/Game/Test/LVL_Test", teamSize: 1, teams: 1, maxPartySize: 1, botFill: true },
  ] }));
  return d;
}

async function backend(port: number, env: Record<string, string>) {
  const p = Bun.spawn(["bun", join(ROOT, "server/main.ts")], { cwd: ROOT, env: { ...process.env, REVIVE_PORT: String(port), REVIVE_BIND: "127.0.0.1", REVIVE_HERO_SELECT_SECONDS: "2", REVIVE_BOT_FILL_SECONDS: "1", REVIVE_HOST_WAIT_SECONDS: "6", ...env }, stdout: "ignore", stderr: "pipe" });
  procs.push(p);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/revive/health`)).ok) return p; } catch {} await Bun.sleep(100); }
  throw new Error("backend did not start");
}

function client(base: string) {
  let token = "";
  const call = async (method: string, path: string, body?: unknown, raw = false) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { "content-type": "application/json" } : {}), ...(raw ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
    });
    const text = await r.text();
    let j: any = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, j, text };
  };
  return { call, set token(v: string) { token = v; }, get token() { return token; } };
}

async function signIn(base: string, name: string, key = "") {
  const c = client(base);
  const l = await c.call("POST", "/revive/login", { displayName: name, profileKey: key });
  const g = await c.call("POST", "/iam/v3/oauth/token", `grant_type=authorization_code&code=${l.j?.authCode}`, true);
  c.token = g.j?.access_token || "";
  return { c, login: l, grant: g, uid: l.j?.userId as string };
}

function ws(url: string, token: string) {
  const sock = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as any);
  const msgs: string[] = [];
  sock.onmessage = (e) => msgs.push(String(e.data));
  const opened = new Promise<boolean>((res) => { sock.onopen = () => res(true); sock.onerror = () => res(false); setTimeout(() => res(false), 3000); });
  return { sock, msgs, opened, wait: async (pred: (m: string) => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = msgs.find(pred); if (m) return m; await Bun.sleep(25); } return undefined; } };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) { await Bun.sleep(150); v = await fn(); }
  return v;
}

try {
  // ================================================================ hosting off
  const P1 = 25981, B1 = `http://127.0.0.1:${P1}`;
  const d1 = dataDir();
  await backend(P1, { REVIVE_DATA_DIR: d1, REVIVE_EXPERIMENTAL_HOSTING: "0" });

  // --- login ---
  const a = await signIn(B1, "Ari");
  t.ok("login creates a profile and returns a profile key + one-time code", a.login.status === 200 && a.login.j.profileKey && a.login.j.authCode);
  t.ok("authorization_code grant issues tokens", a.grant.status === 200 && a.grant.j.access_token && a.grant.j.refresh_token);
  t.eq("token user id", a.grant.j.user_id, a.uid);
  const reuse = await client(B1).call("POST", "/iam/v3/oauth/token", `grant_type=authorization_code&code=${a.login.j.authCode}`, true);
  t.ok("a spent auth code falls back only to the last launcher login from the same address", reuse.status === 200 && reuse.j.user_id === a.uid);
  const taken = await client(B1).call("POST", "/revive/login", { displayName: "ari" });
  t.eq("name taken without the profile key → 409", taken.status, 409);
  const back = await client(B1).call("POST", "/revive/login", { displayName: "Ari", profileKey: a.login.j.profileKey });
  t.ok("same name + profile key signs back in as the same user", back.status === 200 && back.j.userId === a.uid);
  t.eq("bad display name → 400", (await client(B1).call("POST", "/revive/login", { displayName: "x" })).status, 400);
  const refresh = await client(B1).call("POST", "/iam/v3/oauth/token", `grant_type=refresh_token&refresh_token=${a.grant.j.refresh_token}`, true);
  t.ok("refresh_token grant", refresh.status === 200 && refresh.j.user_id === a.uid);
  const cc = await client(B1).call("POST", "/iam/v3/oauth/token", "grant_type=client_credentials", true);
  t.ok("client_credentials grant", cc.status === 200 && cc.j.access_token);
  const plat = await client(B1).call("POST", "/iam/v3/oauth/platforms/steam/token", "platform_token=x", true);
  t.ok("platform grant resolves to the launcher login from the same address", plat.status === 200 && plat.j.user_id === a.uid);
  const jw = await client(B1).call("GET", "/iam/v3/oauth/jwks");
  t.ok("JWKS has an RS256 key", jw.j?.keys?.[0]?.alg === "RS256" && jw.j.keys[0].n);
  t.eq("refresh token is not accepted as an access token", (await (() => { const x = client(B1); x.token = a.grant.j.refresh_token; return x.call("GET", "/iam/v3/public/users/me"); })()).status, 401);

  // --- identity ---
  const me = await a.c.call("GET", "/iam/v3/public/users/me");
  t.ok("users/me", me.status === 200 && me.j.userId === a.uid && me.j.displayName === "Ari");
  const b = await signIn(B1, "Bo");
  const bulk = await a.c.call("POST", "/iam/v3/public/namespaces/test/users/bulk/basic", { userIds: [b.uid, "nope"] });
  t.ok("bulk basic resolves known users only", bulk.j?.data?.length === 1 && bulk.j.data[0].displayName === "Bo");
  const search = await a.c.call("GET", "/iam/v3/public/namespaces/test/users?query=bo");
  t.ok("search by display name", search.j?.data?.some((u: any) => u.userId === b.uid));
  t.eq("availability: taken name → 204", (await a.c.call("GET", "/iam/v3/public/namespaces/test/users/availability?query=Bo")).status, 204);
  t.eq("availability: free name → 404", (await a.c.call("GET", "/iam/v3/public/namespaces/test/users/availability?query=Nobody")).status, 404);

  // --- config / ownership ---
  const conf = await a.c.call("GET", "/configuration/public");
  t.ok("client config points every service at the local TLS endpoint", conf.j?.ServiceHostnames?.coregame?.startsWith("https://127.0.0.1:") && conf.j.ServiceHostnames.messaging.startsWith("wss://127.0.0.1:"));
  const man = await a.c.call("GET", "/content-service/manifest");
  t.ok("content manifest lists every catalog spelling enabled", man.j?.Heroes?.["Hero:Alpha"]?.Status === "Enabled" && man.j.Heroes["Hero:alpha"]);
  const dis = await a.c.call("GET", "/content-service/manifest?nonEnabledOnly=true");
  t.ok("nothing is disabled", Object.keys(dis.j?.Heroes || { x: 1 }).length === 0);
  const inv = await a.c.call("GET", `/inventory/players/${a.uid}`);
  t.ok("inventory owns all assets", inv.j?.AssetEntries?.length === 10 && inv.j.AssetEntries.every((e: any) => e.IsOwned));
  const heroes = await a.c.call("GET", "/storefront/heroes");
  t.ok("all hunters unlocked", heroes.j?.UnlockedHeroes?.length === 4);
  t.eq("no shop", (await a.c.call("POST", "/order/x", {})).status, 400);
  const per = await a.c.call("PUT", `/personalization/players/${a.uid}/cosmeticsbundle/Hero:Alpha`, { CosmeticsBundle: "HeroCosmeticsBundle:AlphaDefault" });
  t.eq("personalization stores a skin choice", per.j?.HeroCosmeticsBundlePreferences?.["Hero:Alpha"], "HeroCosmeticsBundle:AlphaDefault");
  const unauth = await client(B1).call("GET", "/inventory/players/x");
  t.ok("anonymous calls get an empty answer, never another player's data", unauth.status === 200 && !unauth.j?.AssetEntries);

  // --- websockets ---
  const lobA = ws(`ws://127.0.0.1:${P1}/lobby`, a.c.token);
  const lobB = ws(`ws://127.0.0.1:${P1}/lobby`, b.c.token);
  t.ok("lobby websocket opens with a token", await lobA.opened && await lobB.opened);
  t.ok("lobby sends connectNotif", !!(await lobA.wait((m) => m.startsWith("type: connectNotif"))));
  const noTok = await fetch(`http://127.0.0.1:${P1}/lobby`);
  t.eq("lobby without a token → 401", noTok.status, 401);
  lobA.sock.send(`type: requestFriendsRequest\nid: 7\nfriendId: ${b.uid}`);
  t.ok("friend request is answered with the same id and code 0", !!(await lobA.wait((m) => m.includes("type: requestFriendsResponse") && m.includes("id: 7") && m.includes("code: 0"))));
  t.ok("friend gets requestFriendsNotif", !!(await lobB.wait((m) => m.includes("requestFriendsNotif") && m.includes(a.uid))));
  lobB.sock.send(`type: acceptFriendsRequest\nid: 3\nfriendId: ${a.uid}`);
  t.ok("accept notifies the requester", !!(await lobA.wait((m) => m.includes("acceptFriendsNotif"))));
  lobA.sock.send("type: listOfFriendsRequest\nid: 9");
  t.ok("friends list contains the friend", !!(await lobA.wait((m) => m.includes("listOfFriendsResponse") && m.includes(b.uid))));
  lobA.sock.send("type: someUnknownRequest\nid: 11");
  t.ok("unknown requests get an empty success", !!(await lobA.wait((m) => m.includes("someUnknownResponse") && m.includes("id: 11"))));
  const msgA = ws(`ws://127.0.0.1:${P1}/lobby/notifications/players/${a.uid}`, a.c.token);
  const msgB = ws(`ws://127.0.0.1:${P1}/lobby/notifications/players/${b.uid}`, b.c.token);
  t.ok("messenger websocket opens", await msgA.opened && await msgB.opened);
  msgA.sock.send("hb");
  t.ok("messenger echoes hb", !!(await msgA.wait((m) => m.includes('"Resource":"hb"'))));

  // --- parties ---
  const pa = await a.c.call("GET", "/party/parties");
  t.ok("every player has a party", pa.status === 200 && pa.j.ID && pa.j.OwnerID === a.uid && pa.j.Members.length === 1);
  t.eq("default hero is the first catalog hero", pa.j.Members[0].HeroAssetID, "Hero:Alpha");
  const info = await a.c.call("GET", "/party/matchmaking/info");
  t.ok("queue info comes from queues.json with valid sizes", info.j?.Queues?.length === 2 && info.j.Queues.every((q: any) => q.Config.MaxPartySize > 0 && q.Config.MaxTeamSize > 0));
  const hero = await a.c.call("PUT", `/party/parties/${pa.j.ID}/members/${a.uid}`, { heroAssetID: "Hero:Beta", isReady: true });
  t.ok("camelCase member update sets hero + ready, and picks that hero's skin", hero.j?.Members?.[0]?.HeroAssetID === "Hero:Beta" && hero.j.Members[0].IsReady && hero.j.Members[0].CosmeticsAssetID === "HeroCosmeticsBundle:BetaDefault");
  t.ok("party change is pushed on the messenger", !!(await msgA.wait((m) => m.includes(`/party/parties/${pa.j.ID}`))));
  const again = await a.c.call("GET", "/party/parties");
  t.eq("hero choice persists across reads", again.j.Members[0].HeroAssetID, "Hero:Beta");
  const other = await b.c.call("PUT", `/party/parties/${pa.j.ID}/members/${a.uid}`, { heroAssetID: "Hero:Alpha" });
  t.eq("a non-member cannot edit someone else's party", other.status, 404);
  await a.c.call("POST", `/party/parties/${pa.j.ID}/sendInvite/${b.uid}`);
  const bp = await b.c.call("GET", `/party/players/${b.uid}`);
  t.ok("invite shows on the invitee's PartyPlayer", bp.j?.Invites?.some((i: any) => i.PartyId === pa.j.ID && i.FromID === a.uid));
  t.ok("invite is pushed to the invitee", !!(await msgB.wait((m) => m.includes(`/party/players/${b.uid}`) && m.includes(pa.j.ID))));
  const joined = await b.c.call("POST", `/party/parties/${pa.j.ID}/join`);
  t.ok("invitee joins the party", joined.status === 200 && joined.j.Members.length === 2);
  t.eq("a non-owner cannot queue", (await b.c.call("POST", `/party/parties/${pa.j.ID}/joinQueue`, {})).status, 403);
  const tq = await a.c.call("POST", `/party/parties/${pa.j.ID}/setTargetQueues`, { queueIDs: ["duo-test-ranked"] });
  t.eq("ranked suffix maps back to the local queue", tq.j?.TargetQueueIDs, ["duo-test"]);

  // --- matchmaking: party of 2 in a 2x2 queue → bot fill after 1 s ---
  const q = await a.c.call("POST", `/party/parties/${pa.j.ID}/joinQueue`, { QueueID: "duo-test" });
  t.eq("queueing sets the party Matchmaking", q.j?.State, "Matchmaking");
  const cp = await waitFor(() => a.c.call("GET", `/core-game/players/${a.uid}`), (r) => !!r.j?.MatchID, 6000);
  t.ok("bot fill forms a match", !!cp.j.MatchID);
  const mid = cp.j.MatchID;
  const m1 = await a.c.call("GET", `/core-game/matches/${mid}`);
  t.ok("match has 2 humans on one team + 2 bots", m1.j?.Participants?.length === 4 && m1.j.Participants.filter((p: any) => p.IsBot).length === 2 && m1.j.Participants.filter((p: any) => !p.IsBot).every((p: any) => p.TeamID === 1));
  t.eq("match starts in HeroSelect", m1.j.State, "HeroSelect");
  t.ok("party hero carries into the match", m1.j.Participants.find((p: any) => p.ID === a.uid)?.HeroAssetID === "Hero:Beta");
  t.ok("match is pushed to both players", !!(await msgA.wait((m) => m.includes(`/core-game/matches/${mid}`))) && !!(await msgB.wait((m) => m.includes(`/core-game/matches/${mid}`))));
  t.eq("cannot pick for another player", (await a.c.call("PUT", `/core-game/matches/${mid}/player/${b.uid}`, { HeroAssetID: "Hero:Alpha" })).status, 403);
  const pk = await a.c.call("PUT", `/core-game/matches/${mid}/player/${a.uid}`, { HeroAssetID: "Hero:Alpha", LockedIn: true });
  t.ok("hero pick + lock", pk.j?.PlayerInfo?.HeroAssetID === "Hero:Alpha" && pk.j.PlayerInfo.LockedIn === true);
  const tp = await a.c.call("GET", `/core-game/players/${a.uid}/travel-plan`);
  t.ok("travel plan carries the queue's map and mode", tp.j?.TravelPlan?.MapName === "/Game/Test/LVL_Test" && tp.j.TravelPlan.GameMode === "TestMode");
  const ended = await waitFor(() => a.c.call("GET", `/core-game/matches/${mid}`), (r) => r.j?.State === "Complete", 8000);
  t.ok("with hosting off the match ends after Hero Select, saying why", ended.j.State === "Complete" && ended.j.EndReason === "hosting_disabled");
  t.ok("no connection address is ever handed out without a host", ended.j.ConnectionDetails.address === "");
  const after = await a.c.call("GET", `/core-game/players/${a.uid}`);
  t.eq("players are back in the lobby", after.j.MatchID, "");
  const pAfter = await a.c.call("GET", "/party/parties");
  t.ok("party survives the match", pAfter.j.Members.length === 2 && pAfter.j.State === "Default");
  for (const s of [lobA, lobB, msgA, msgB]) s.sock.close();

  // ================================================================ hosting on, with a real SDK stand-in
  const P2 = 25982, B2 = `http://127.0.0.1:${P2}`, SDK = 25983;
  const d2 = dataDir();
  await backend(P2, { REVIVE_DATA_DIR: d2, REVIVE_EXPERIMENTAL_HOSTING: "1" });
  const solo = await signIn(B2, "Cy");
  const noHost = await solo.c.call("POST", `/party/parties/${(await solo.c.call("GET", "/party/parties")).j.ID}/joinQueue`, { QueueID: "solo-test" });
  t.eq("solo queue matches instantly", noHost.status, 200);
  const nh = await waitFor(() => solo.c.call("GET", `/core-game/players/${solo.uid}`), (r) => !!r.j?.MatchID, 3000);
  const nhEnd = await waitFor(() => solo.c.call("GET", `/core-game/matches/${nh.j.MatchID}`), (r) => r.j?.State === "Complete", 12000);
  t.eq("with hosting on but no host registered the match ends: no_host_available", nhEnd.j?.EndReason, "no_host_available");

  const sdk = Bun.spawn(["bun", join(ROOT, "client/agones-sdk.mjs"), "--backend", B2, "--port", String(SDK), "--match-port", "7777", "--public-host", "10.9.8.7", "--data", d2], { stdout: "ignore", stderr: "ignore" });
  procs.push(sdk);
  const hostList = await waitFor(() => client(B2).call("GET", "/revive/hosts"), (r) => r.j?.hosts?.length === 1, 5000);
  t.ok("the SDK stand-in registers this PC as a host", hostList.j.hosts[0]?.address === "10.9.8.7" && hostList.j.hosts[0].port === 7777);
  const gs0 = await fetch(`http://127.0.0.1:${SDK}/gameserver`).then((r) => r.json());
  t.ok("SDK serves the Agones GameServer object", gs0?.status?.address === "10.9.8.7" && gs0.status.ports?.[0]?.port === 7777);
  // the game server announces readiness through the SDK, exactly as the engine's Agones plugin would
  t.eq("SDK /ready", (await fetch(`http://127.0.0.1:${SDK}/ready`, { method: "POST", body: "{}" })).status, 200);
  const watch = new WebSocket(`ws://127.0.0.1:${SDK}/watch/gameserver`);
  const watched: any[] = [];
  watch.onmessage = (e) => { try { watched.push(JSON.parse(String(e.data))); } catch {} };
  await Bun.sleep(300);
  t.ok("watch websocket sends {result: GameServer}", watched.some((w) => w.result?.status?.state === "Ready"));
  await waitFor(() => client(B2).call("GET", "/revive/hosts"), (r) => r.j?.hosts?.[0]?.state === "Ready", 5000);

  const pc = (await solo.c.call("GET", "/party/parties")).j.ID;
  await solo.c.call("POST", `/party/parties/${pc}/joinQueue`, { QueueID: "solo-test" });
  const hm = await waitFor(() => solo.c.call("GET", `/core-game/players/${solo.uid}`), (r) => !!r.j?.MatchID && r.j.MatchID !== nh.j.MatchID, 3000);
  const hmid = hm.j.MatchID;
  const assigned = await waitFor(() => solo.c.call("GET", `/core-game/matches/${hmid}`), (r) => ["AwaitingReady", "InProgress"].includes(r.j?.State), 8000);
  t.ok("after Hero Select the match is assigned to the registered host", ["AwaitingReady", "InProgress"].includes(assigned.j.State));
  const gs1 = await waitFor(() => fetch(`http://127.0.0.1:${SDK}/gameserver`).then((r) => r.json()), (g: any) => g?.status?.state === "Allocated", 6000);
  t.ok("SDK flips to Allocated and publishes the match id", gs1.status.state === "Allocated" && gs1.object_meta.labels.matchId === hmid);
  t.ok("watchers are told about the allocation", watched.some((w) => w.result?.status?.state === "Allocated"));
  const live = await waitFor(() => solo.c.call("GET", `/core-game/matches/${hmid}`), (r) => r.j?.State === "InProgress", 6000);
  t.eq("host acknowledgement moves the match InProgress", live.j.State, "InProgress");
  t.eq("players get the host's LAN address", live.j.ConnectionDetails.address, "10.9.8.7:7777");
  const det = await client(B2).call("GET", `/core-game/matches/${hmid}/details`);
  t.ok("match server can fetch match details without a player token", det.status === 200 && det.j.ID === hmid && det.j.Participants.length === 1);
  const fin = await client(B2).call("POST", `/core-game/matches/${hmid}/complete`, {});
  t.ok("match server completes the match", fin.j?.State === "Complete");
  const released = await waitFor(() => fetch(`http://127.0.0.1:${SDK}/revive/state`).then((r) => r.json()), (s: any) => !s.matchId, 6000);
  t.ok("host is released for the next match", !released.matchId);
  watch.close();
  const bad = await client(B2).call("POST", `/revive/hosts/${hostList.j.hosts[0].hostId}/heartbeat`, { state: "Ready" });
  t.eq("heartbeat without the host key is rejected", bad.status, 404);
} catch (e) {
  t.ok("gate crashed", false, (e as Error).stack || String(e));
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
t.done();
