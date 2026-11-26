// Parties, matchmaking, Hero Select, match lifecycle and the listen-server host registry.
//
// Match lifecycle (state names are the ones the client reads):
//   HeroSelect → Allocating → AwaitingReady → InProgress → Complete
// After Hero Select the match is handed to a match server registered by a host PC: match/ (docs/MATCHES.md), or
// the game's own server mode (docs/GAME-SERVER-MODE.md). With no host — or with REVIVE_EXPERIMENTAL_HOSTING=0 —
// the match completes straight away and everyone returns to the lobby; it never pretends a server exists.

import { randomBytes, randomUUID } from "node:crypto";
import { BOT_FILL_MS, EXPERIMENTAL_HOSTING, HERO_SELECT_MS, HOST_WAIT_MS, MATCH_PORT, PUBLIC_HOST } from "./config.ts";
import { assetId, error, json, noContent, nowIso, pick, type Ctx } from "./http.ts";
import { profileById, type Profile } from "./accounts.ts";
import { CLIENT_BUILD, catalog, defaultHero, defaultSkinFor, queueById, queues, type QueueDef } from "./catalog.ts";
import { push, pushMany, resourceVersion } from "./messenger.ts";
import { loadoutOf, rememberHero, personalization } from "./players.ts";

export const REGION = "local";
const id = () => randomUUID().replace(/-/g, "");

// ---------------------------------------------------------------------------------------------
// state (in memory: parties and matches do not survive a backend restart, by design)

type Member = { id: string; name: string; hero: string; skin: string; chroma: string; ready: boolean; team: number };
type Party = {
  id: string; version: number; ownerId: string; members: Member[]; state: "Default" | "Matchmaking" | "CustomGame";
  queues: string[]; isOpen: boolean; fill: "Fill" | "NoFill"; joinSecret: string;
  ticket: { queue: string; at: number } | null; matchId: string; createdAt: string;
};
type Participant = { id: string; name: string; team: number; slot: number; hero: string; skin: string; chroma: string; locked: boolean; bot: boolean; partyId: string; connected: boolean };
export type Match = {
  id: string; version: number; queue: QueueDef; state: "HeroSelect" | "Allocating" | "AwaitingReady" | "InProgress" | "Complete";
  participants: Participant[]; created: string; heroSelectEnds: number; allocatingSince: number;
  hostId: string; address: string; secret: string; endReason: string; completedAt: string;
};
type Invite = { partyId: string; from: string; to: string; exp: number };
type Host = { hostId: string; key: string; address: string; port: number; name: string; state: string; matchId: string; seenAt: number };

const parties = new Map<string, Party>();
const partyOf = new Map<string, string>();
const matches = new Map<string, Match>();
const matchOf = new Map<string, string>();
const invites: Invite[] = [];
const hosts = new Map<string, Host>();

const HOST_TIMEOUT = 45_000;
const STATE_ENUM: Record<Match["state"], number> = { HeroSelect: 1, Allocating: 3, AwaitingReady: 4, InProgress: 5, Complete: 7 };

// ---------------------------------------------------------------------------------------------
// serialisation

function memberOut(p: Party, m: Member, idx: number) {
  return {
    ID: m.id, DisplayName: m.name, Tag: `#${m.id.slice(0, 4).toUpperCase()}`,
    HeroAssetID: m.hero, CosmeticsAssetID: m.skin, LuxeSkinChroma: m.chroma, OwnedCosmeticsFeatures: [],
    IsReady: m.ready, PremadeRestrictions: {}, PremadeRestrictionKey: "", PremadeRestrictionContext: 0,
    PersonalizationLoadout: personalization(m.id), CustomGameTeamID: m.team || idx + 1,
    Rating: 0, Rank: "Unranked", Ante: 0, IsRankedEligible: false, AccountLevel: 1, MasteryLevel: 1,
    Latencies: [{ Host: PUBLIC_HOST, Region: REGION, Route: "default", AvgLatency: 1 }],
    ReferralCode: "", XPBoosts: { Boosts: [] }, DiscordUserID: "", RestrictionBreakPenalty: 0,
    IsLeader: m.id === p.ownerId,
  };
}

export function partyOut(p: Party) {
  const q = queueById(p.queues[0]);
  return {
    ID: p.id,
    Version: Math.max(p.version, resourceVersion(`/party/parties/${p.id}`)),
    State: p.state,
    ClientVersion: CLIENT_BUILD,
    IsOpen: p.isOpen,
    FillTeam: p.fill,
    OwnerID: p.ownerId,
    DiscordJoinSecret: p.joinSecret,
    TargetQueueIDs: p.queues,
    TargetQueueID: p.queues[0] || "",
    IsRanked: false,
    ExcludedRegions: [],
    Requests: [],
    CustomGameDetails: {
      Region: REGION, MaxTeamCount: q?.teams || 1, TeamNames: {}, Description: "", Password: "", InProgress: false,
      ShuffleTeamIndexes: false, DisabledHeroes: [], DisabledEquipment: [], DisabledPowers: [], DisabledItems: [],
      GameConfig: gameConfig(q), Restrictions: { MaxTeamSize: 4, MaxTeamCount: 20, MaxSpectatorCount: 0, MaxPlayerCount: 40, MinPlayerCount: 1 },
    },
    MillisInQueue: p.ticket ? Date.now() - p.ticket.at : 0,
    QueueJoinTime: p.ticket ? nowIso(p.ticket.at) : "0001-01-01T00:00:00.000Z",
    Members: p.members.map((m, i) => memberOut(p, m, i)),
    CreatedAt: p.createdAt,
  };
}

function gameConfig(q?: QueueDef) {
  return {
    MapName: q?.map || "", GameMode: q?.alias || "", ServerCulture: "en", CanAlwaysDisassociate: true,
    MaxHeroDuplicates: 0, RequiresDropLeader: false, MaxTeamSize: q?.teamSize || 1, CVars: {}, RandomSeed: 0, SoloModeStartLocation: 0,
  };
}

function partyPlayerOut(uid: string) {
  const p = ensureParty(uid);
  return {
    ID: uid, Version: resourceVersion(`/party/players/${uid}`), ClientVersion: CLIENT_BUILD, PartyID: p.id, DiscordUserID: "",
    Invites: invites.filter((i) => i.to === uid && i.exp > Date.now()).map((i) => ({ PartyId: i.partyId, FromID: i.from, Expiration: nowIso(i.exp) })),
  };
}

function participantOut(m: Match, p: Participant, order: number) {
  return {
    ID: p.id, TeamID: p.team, PartyId: p.partyId, PickOrder: order, DisplayName: p.name, Tag: p.bot ? "BOT" : p.id.slice(0, 4).toUpperCase(),
    HeroAssetID: p.hero, CosmeticsAssetID: p.skin, LuxeSkinChromaAssetID: p.chroma, OwnedCosmeticsFeatures: [],
    LockedIn: p.locked, IsDropLeader: p.slot === 0, IsBot: p.bot, IsRanked: false, Rank: 0, AccountLevel: 1,
    Mastery: [{ HeroAssetID: p.hero, Level: 1, XP: 0 }], MasteryLevel: 1, Region: REGION, Roles: [p.bot ? "bot" : "player"],
    PersonalizationLoadout: p.bot ? { ID: p.id, Version: 1, EmoteIDs: [], TitleIDs: [], SlotCosmeticsEntries: [], IsAnonymous: false, Token: "", HeroCosmeticsBundlePreferences: { [p.hero]: p.skin }, LuxeSkinChromaPreferences: {}, LobbyPlatformPreference: "" } : personalization(p.id),
    ConnectionSecret: m.secret, XPBoosts: { Boosts: [] }, IsPremiumSession: false, RestrictionBreakPenalty: 0,
  };
}

function connection(m: Match, forUser?: string) {
  const live = m.state === "InProgress" && m.address;
  return {
    address: live ? m.address : "",
    ServerID: m.hostId, MachineID: m.hostId, RegionID: REGION, FleetID: "local", RoutingToken: "", ConnectionSecret: m.secret, Routes: {},
  };
}

export function matchOut(m: Match, forUser?: string) {
  const self = m.participants.find((p) => p.id === forUser) || m.participants.find((p) => !p.bot);
  const remaining = Math.max(0, m.heroSelectEnds - Date.now());
  return {
    ID: m.id, Version: m.version, Created: m.created, State: m.state, StateEnum: STATE_ENUM[m.state],
    GameVersion: CLIENT_BUILD, QueueID: m.queue.id, Region: REGION, OwnerID: m.hostId || self?.id || "",
    GameConfig: gameConfig(m.queue),
    PlayerInfo: self ? participantOut(m, self, self.slot) : undefined,
    TeamInfo: self ? m.participants.filter((p) => p.team === self.team && p !== self).map((p, i) => participantOut(m, p, i)) : [],
    Participants: m.participants.map((p, i) => participantOut(m, p, i)),
    ConnectionDetails: connection(m, forUser),
    HeroSelectSecondsLeft: Number((remaining / 1000).toFixed(2)),
    HeroSelectDurationSeconds: Math.round(HERO_SELECT_MS / 1000),
    HeroSelectFirstPickTransitionPeriodSeconds: 1,
    HeroSelectLockedInPeriodSeconds: 3,
    HeroSelectStartTime: nowIso(m.heroSelectEnds - HERO_SELECT_MS),
    MatchStartTime: m.created,
    ProgressionEnabled: false,
    SpectatorConnectionSecret: "",
    CustomGameDetails: { TeamNames: {} },
    EndReason: m.endReason,
    ArmoryEnabled: true,
    Teams: [...new Set(m.participants.map((p) => p.team))].sort((a, b) => a - b).map((t) => ({
      TeamId: t,
      Members: m.participants.filter((p) => p.team === t).map((p) => ({ UserId: p.id, DisplayName: p.name, TeamId: t, HeroId: p.hero, IsBot: p.bot, Cosmetics: p.skin })),
    })),
  };
}

function travelPlan(m: Match, uid: string) {
  return {
    MatchId: m.id, QueueId: m.queue.id, State: m.state, IsHost: false, HostId: m.hostId, UserId: uid,
    MapName: m.queue.map, GameMode: m.queue.alias, ConnectAddress: m.state === "InProgress" ? m.address : "",
    ConnectionSecret: m.secret, EndReason: m.endReason,
  };
}

function corePlayerOut(uid: string) {
  const m = activeMatch(uid);
  return {
    ID: uid, Version: resourceVersion(`/core-game/players/${uid}`), MatchID: m?.id || "", QueueID: m?.queue.id || "",
    CanDisassociate: !!m, MatchRegion: m ? REGION : "", GameVersion: CLIENT_BUILD,
  };
}

// ---------------------------------------------------------------------------------------------
// pushes

function touchParty(p: Party) {
  p.version++;
  const out = partyOut(p);
  pushMany(p.members.map((m) => m.id), `/party/parties/${p.id}`, out);
  for (const m of p.members) push(m.id, `/party/players/${m.id}`, partyPlayerOut(m.id));
}

function touchMatch(m: Match) {
  m.version++;
  for (const p of m.participants) {
    if (p.bot) continue;
    push(p.id, `/core-game/matches/${m.id}`, matchOut(m, p.id));
    push(p.id, `/core-game/players/${p.id}`, corePlayerOut(p.id));
    push(p.id, `/matchmaking/players/${p.id}`, { State: m.state, MatchId: m.state === "Complete" ? "" : m.id, QueueId: m.queue.id });
  }
}

// ---------------------------------------------------------------------------------------------
// parties

function newMember(u: Profile): Member {
  const lo = loadoutOf(u.userId);
  const hero = lo.hero || defaultHero();
  return { id: u.userId, name: u.displayName, hero, skin: lo.skins[hero] || defaultSkinFor(hero), chroma: "", ready: false, team: 0 };
}

export function ensureParty(uid: string): Party {
  const existing = parties.get(partyOf.get(uid) || "");
  if (existing?.members.some((m) => m.id === uid)) return existing;
  const u = profileById(uid);
  const p: Party = {
    id: id(), version: 1, ownerId: uid, members: u ? [newMember(u)] : [], state: "Default",
    queues: queues()[0] ? [queues()[0].id] : [], isOpen: true, fill: "Fill", joinSecret: randomBytes(9).toString("base64url"),
    ticket: null, matchId: "", createdAt: nowIso(),
  };
  parties.set(p.id, p);
  partyOf.set(uid, p.id);
  return p;
}

function leave(uid: string): Party {
  const cur = parties.get(partyOf.get(uid) || "");
  if (cur) {
    cancelQueue(cur);
    cur.members = cur.members.filter((m) => m.id !== uid);
    if (!cur.members.length) parties.delete(cur.id);
    else { if (cur.ownerId === uid) cur.ownerId = cur.members[0].id; touchParty(cur); }
  }
  partyOf.delete(uid);
  return ensureParty(uid);
}

function join(uid: string, partyId: string, secret: string): Party | { status: number; error: string } {
  const target = parties.get(partyId);
  if (!target) return { status: 404, error: "party_not_found" };
  if (target.members.some((m) => m.id === uid)) return target;
  const invited = invites.some((i) => i.partyId === partyId && i.to === uid && i.exp > Date.now());
  if (!invited && !(target.isOpen && (secret === target.joinSecret || !secret))) return { status: 403, error: "party_closed" };
  const max = queueById(target.queues[0])?.maxPartySize || 4;
  if (target.members.length >= Math.max(max, 1)) return { status: 409, error: "party_full" };
  if (target.state === "Matchmaking") return { status: 409, error: "party_in_queue" };
  leave(uid);
  const fresh = parties.get(partyOf.get(uid) || "");
  if (fresh && fresh.members.length === 1) parties.delete(fresh.id);
  const u = profileById(uid);
  if (!u) return { status: 404, error: "user_not_found" };
  target.members.push(newMember(u));
  partyOf.set(uid, target.id);
  for (let i = invites.length - 1; i >= 0; i--) if (invites[i].to === uid) invites.splice(i, 1);
  touchParty(target);
  return target;
}

// ---------------------------------------------------------------------------------------------
// matchmaking

function capacity(q: QueueDef) { return q.teamSize * q.teams; }

function startQueue(p: Party, queueId?: unknown): Party | { status: number; error: string } {
  if (p.state === "Matchmaking") return p;
  const q = queueById(queueId ?? p.queues[0]);
  if (!q) return { status: 400, error: queues().length ? "unknown_queue" : "no_queues_configured" };
  const live = activeMatch(p.ownerId);
  if (live) return { status: 409, error: "already_in_match" };
  p.queues = [q.id];
  p.state = "Matchmaking";
  p.ticket = { queue: q.id, at: Date.now() };
  touchParty(p);
  for (const m of p.members) push(m.id, `/matchmaking/players/${m.id}`, { Status: "Queued", QueueId: q.id, Region: REGION });
  tick();
  return p;
}

function cancelQueue(p: Party) {
  if (p.state !== "Matchmaking") return;
  p.state = "Default";
  p.ticket = null;
  touchParty(p);
  for (const m of p.members) push(m.id, `/matchmaking/players/${m.id}`, { Status: "Cancelled", QueueId: p.queues[0] || "" });
}

function formMatch(q: QueueDef, group: Party[], fillBots: boolean) {
  const cap = capacity(q);
  const participants: Participant[] = [];
  for (const p of group) {
    for (const m of p.members) {
      const t = Math.floor(participants.length / q.teamSize) + 1;
      participants.push({ id: m.id, name: m.name, team: t, slot: participants.filter((x) => x.team === t).length, hero: m.hero, skin: m.skin, chroma: m.chroma, locked: false, bot: false, partyId: p.id, connected: true });
    }
  }
  const heroes = catalog().heroes;
  if (fillBots) {
    for (let n = 0; participants.length < cap; n++) {
      const t = Math.floor(participants.length / q.teamSize) + 1;
      const h = heroes.length ? heroes[(participants.length * 7 + n) % heroes.length].id : defaultHero();
      participants.push({ id: `bot-${id().slice(0, 12)}`, name: `Bot ${participants.length + 1}`, team: t, slot: participants.filter((x) => x.team === t).length, hero: h, skin: defaultSkinFor(h), chroma: "", locked: true, bot: true, partyId: "", connected: true });
    }
  }
  const m: Match = {
    id: id(), version: 1, queue: q, state: "HeroSelect", participants, created: nowIso(),
    heroSelectEnds: Date.now() + HERO_SELECT_MS, allocatingSince: 0, hostId: "", address: "",
    secret: randomBytes(12).toString("hex"), endReason: "", completedAt: "",
  };
  matches.set(m.id, m);
  for (const p of group) {
    p.state = "Default"; p.ticket = null; p.matchId = m.id;
    for (const mem of p.members) matchOf.set(mem.id, m.id);
    touchParty(p);
  }
  touchMatch(m);
  console.log(`[match] ${m.id} ${q.id}: ${participants.filter((p) => !p.bot).length} players, ${participants.filter((p) => p.bot).length} bots`);
  return m;
}

function completeMatch(m: Match, reason: string) {
  if (m.state === "Complete") return;
  m.state = "Complete";
  m.endReason = reason;
  m.completedAt = nowIso();
  const h = hosts.get(m.hostId);
  if (h && h.matchId === m.id) h.matchId = "";
  touchMatch(m);
  for (const p of m.participants) if (!p.bot && matchOf.get(p.id) === m.id) {
    matchOf.delete(p.id);
    const party = parties.get(partyOf.get(p.id) || "");
    if (party && party.matchId === m.id) { party.matchId = ""; touchParty(party); }
  }
  console.log(`[match] ${m.id} complete: ${reason}`);
}

export function activeMatch(uid: string): Match | undefined {
  const m = matches.get(matchOf.get(uid) || "");
  return m && m.state !== "Complete" ? m : undefined;
}

function freeHost(): Host | undefined {
  return [...hosts.values()].find((h) => !h.matchId && Date.now() - h.seenAt < HOST_TIMEOUT && /Ready|Scheduled|RequestReady/.test(h.state));
}

/** One scheduler step; runs every 500 ms and after every queue change. */
export function tick() {
  const now = Date.now();
  for (const q of queues()) {
    const waiting = [...parties.values()].filter((p) => p.state === "Matchmaking" && p.ticket?.queue === q.id).sort((a, b) => a.ticket!.at - b.ticket!.at);
    while (waiting.length) {
      const group: Party[] = [];
      let size = 0;
      for (const p of [...waiting]) {
        if (size + p.members.length <= capacity(q)) { group.push(p); size += p.members.length; waiting.splice(waiting.indexOf(p), 1); }
      }
      if (!group.length) break;
      const oldest = group[0].ticket!.at;
      const full = size >= capacity(q);
      const fill = q.botFill && BOT_FILL_MS >= 0 && now - oldest >= BOT_FILL_MS;
      if (full || fill || capacity(q) === 1) formMatch(q, group, !full);
      else break;
    }
  }
  for (const m of matches.values()) {
    if (m.state === "HeroSelect") {
      const humans = m.participants.filter((p) => !p.bot);
      if (now >= m.heroSelectEnds || humans.every((p) => p.locked)) {
        for (const p of m.participants) p.locked = true;
        m.state = "Allocating";
        m.allocatingSince = now;
        touchMatch(m);
      }
    } else if (m.state === "Allocating") {
      if (!EXPERIMENTAL_HOSTING) { completeMatch(m, "hosting_disabled"); continue; }
      const h = freeHost();
      if (h) {
        h.matchId = m.id;
        m.hostId = h.hostId;
        m.address = `${h.address}:${h.port}`;
        m.state = "AwaitingReady";
        touchMatch(m);
        console.log(`[match] ${m.id} assigned to host ${h.name} ${m.address}`);
      } else if (now - m.allocatingSince > HOST_WAIT_MS) completeMatch(m, "no_host_available");
    } else if (m.state === "AwaitingReady") {
      const h = hosts.get(m.hostId);
      if (!h || now - h.seenAt > HOST_TIMEOUT) completeMatch(m, "host_lost");
      else if (now - m.allocatingSince > HOST_WAIT_MS * 2) completeMatch(m, "host_never_ready");
    } else if (m.state === "InProgress") {
      const h = hosts.get(m.hostId);
      if (!h || now - h.seenAt > HOST_TIMEOUT * 2) completeMatch(m, "host_lost");
      else if (h.state === "Shutdown") completeMatch(m, "host_shutdown");
    } else if (m.state === "Complete" && now - Date.parse(m.completedAt) > 10 * 60_000) matches.delete(m.id);
  }
  for (let i = invites.length - 1; i >= 0; i--) if (invites[i].exp < now) invites.splice(i, 1);
}

setInterval(tick, 500).unref?.();

function markInProgress(m: Match) {
  if (m.state !== "AwaitingReady") return;
  m.state = "InProgress";
  touchMatch(m);
  console.log(`[match] ${m.id} in progress on ${m.address}`);
}

// ---------------------------------------------------------------------------------------------
// HTTP

export function handlePlay(c: Ctx): Response | null {
  const { path, method, body } = c;

  // ---- match-server API (called by match/run.ts on the host PC) ----
  if (path === "/api/ds/register" && method === "POST") {
    const sid = String(body.serverId || id()).slice(0, 64);
    const h: Host = {
      hostId: sid, key: "", address: String(body.host || c.ip || PUBLIC_HOST), port: Number(body.port) || MATCH_PORT,
      name: `match-server ${sid}`, state: "Ready", matchId: hosts.get(sid)?.matchId || "", seenAt: Date.now(),
    };
    hosts.set(sid, h);
    console.log(`[host] match server ${sid} at ${h.address}:${h.port}`);
    return json({ ok: true, serverId: sid }, 201);
  }
  const dsHb = path.match(/^\/api\/ds\/servers\/([^/]+)\/heartbeat$/);
  if (dsHb && method === "POST") {
    const h = hosts.get(decodeURIComponent(dsHb[1]));
    if (!h || h.key) return error(404, "unknown server");
    h.seenAt = Date.now();
    h.state = "Ready";
    const m = matches.get(h.matchId);
    if (!m || m.state === "Complete") return json({ ok: true, allocation: null });
    return json({ ok: true, allocation: { MatchId: m.id, MapName: m.queue.map, GameMode: m.queue.alias, QueueID: m.queue.id } });
  }
  const dsReady = path.match(/^\/api\/ds\/matches\/([^/]+)\/ready$/);
  if (dsReady && method === "POST") {
    const m = matches.get(decodeURIComponent(dsReady[1]));
    if (!m) return error(404, "match not found");
    markInProgress(m);
    return json({ ok: true, State: m.state });
  }
  const dsDel = path.match(/^\/api\/ds\/servers\/([^/]+)$/);
  if (dsDel && method === "DELETE") {
    const sid = decodeURIComponent(dsDel[1]);
    const h = hosts.get(sid);
    if (h && !h.key) { hosts.delete(sid); const m = matches.get(h.matchId); if (m) completeMatch(m, "host_shutdown"); }
    return noContent();
  }
  if (path === "/api/ds/servers" && method === "GET") return json({ servers: [...hosts.values()].map(({ key, ...h }) => h) });

  // ---- host registry (called by client/agones-sdk.mjs on the host PC) ----
  if (path === "/revive/hosts" && method === "POST") {
    const h: Host = {
      hostId: id(), key: randomBytes(18).toString("base64url"),
      address: String(body.address || c.ip || PUBLIC_HOST), port: Number(body.port) || MATCH_PORT,
      name: String(body.name || "host").slice(0, 40), state: "Scheduled", matchId: "", seenAt: Date.now(),
    };
    hosts.set(h.hostId, h);
    console.log(`[host] registered ${h.name} at ${h.address}:${h.port}`);
    return json({ hostId: h.hostId, hostKey: h.key });
  }
  if (path === "/revive/hosts" && method === "GET") {
    return json({ hosts: [...hosts.values()].map(({ key, ...h }) => h), experimentalHosting: EXPERIMENTAL_HOSTING });
  }
  const hb = path.match(/^\/revive\/hosts\/([^/]+)\/heartbeat$/);
  if (hb) {
    const h = hosts.get(hb[1]);
    if (!h || c.req.headers.get("x-revive-host-key") !== h.key) return error(404, "unknown host");
    h.seenAt = Date.now();
    h.state = String(body.state || h.state);
    const m = matches.get(h.matchId);
    if (m && m.state === "AwaitingReady" && body.matchId === m.id && h.state === "Allocated") markInProgress(m);
    return json({ assignment: m && m.state !== "Complete" ? { matchId: m.id, queue: m.queue.id, map: m.queue.map, mode: m.queue.alias } : null });
  }

  if (path === "/regions") return json({ Regions: [{ Name: REGION, Addr: PUBLIC_HOST, Port: MATCH_PORT, CanExclude: false, Routes: {} }] });

  const u = c.user;
  const isParty = path.startsWith("/party/");
  const isCore = path.startsWith("/core-game/") || path.startsWith("/eog/");
  const isMm = path.startsWith("/matchmaking/") && !/^\/matchmaking\/v\d/.test(path);
  if (!isParty && !isCore && !isMm) return null;

  if (path === "/party/matchmaking/info" || path === "/matchmaking/queues") {
    return json({
      ETag: `local-${queues().length}`,
      Queues: queues().map((q, i) => ({
        ID: q.id, IsRanked: false, IsSpecial: false,
        Config: { MaxTeamSize: q.teamSize, MaxPartySize: q.maxPartySize, MaxHeroDuplicates: 0, FillParties: true, RegionOverride: "", Priority: i + 1, RankedSchedule: null, RankedRestrictionsSchedule: null, AllowNoFill: true },
      })),
      LastUpdated: nowIso(),
    });
  }
  if (path === "/party/matchmaking/customGameModes") return json({ Modes: [], LastUpdated: nowIso(), ETag: "local" });
  if (path === "/party/custom/list") return json({ Entries: [], Total: 0 });
  if (path.includes("/voice")) return json({ Token: "", ChannelURI: "", ServerURI: "", Issuer: "", Domain: "" });

  // ---- match-server facing (no player token) ----
  const details = path.match(/^\/core-game\/(?:s2s\/)?matches\/([^/]+)\/details$/);
  if (details) {
    const m = matches.get(details[1]);
    return m ? json(matchOut(m)) : error(404, "match not found");
  }
  const ready = path.match(/^\/core-game\/(?:s2s\/)?matches\/([^/]+)\/(?:host-ready|ready)$/);
  if (ready && method === "POST") {
    const m = matches.get(ready[1]);
    if (!m) return error(404, "match not found");
    markInProgress(m);
    return json(matchOut(m));
  }
  const done = path.match(/^\/core-game\/(?:s2s\/)?matches\/([^/]+)\/(?:complete|results|finish|shutdown)$/);
  if (done && method === "POST") {
    const m = matches.get(done[1]);
    if (!m) return error(404, "match not found");
    completeMatch(m, "finished");
    return json(matchOut(m));
  }
  if (path.startsWith("/eog/")) return json({ ok: true });

  if (!u) return error(401, "not signed in");
  const uid = u.userId;
  const p = ensureParty(uid);
  const fail = (r: { status: number; error: string }) => error(r.status, r.error);

  // ---- core-game, player facing ----
  const corePlayer = path.match(/^\/core-game\/(?:s2s\/)?players\/([^/]+)(\/disassociate(?:\/([^/]+))?|\/travel-plan)?$/);
  if (corePlayer) {
    const who = decodeURIComponent(corePlayer[1]);
    if (corePlayer[2] === "/travel-plan") {
      const m = activeMatch(who);
      return json({ Active: !!m, TravelPlan: m ? travelPlan(m, who) : null });
    }
    if (corePlayer[2]?.startsWith("/disassociate") || method === "DELETE") {
      const m = activeMatch(who);
      if (m) {
        const part = m.participants.find((x) => x.id === who);
        if (part) part.connected = false;
        matchOf.delete(who);
        if (!m.participants.some((x) => !x.bot && matchOf.get(x.id) === m.id)) completeMatch(m, "everyone_left");
      }
      push(who, `/core-game/players/${who}`, corePlayerOut(who));
      return json(corePlayerOut(who));
    }
    return json(corePlayerOut(who));
  }
  if (path === "/core-game/me") { const m = activeMatch(uid); return json({ ActiveMatch: m ? matchOut(m, uid) : null }); }
  const pers = path.match(/^\/core-game\/matches\/([^/]+)\/player\/([^/]+)\/personalization$/);
  if (pers) return json(personalization(decodeURIComponent(pers[2])));
  const pickRoute = path.match(/^\/core-game\/matches\/([^/]+)\/player\/([^/]+)$/);
  if (pickRoute && (method === "PUT" || method === "POST" || method === "PATCH")) {
    const m = matches.get(pickRoute[1]);
    const who = decodeURIComponent(pickRoute[2]);
    if (!m) return error(404, "match not found");
    if (who !== uid) return error(403, "can only pick for yourself");
    const part = m.participants.find((x) => x.id === who);
    if (!part) return error(404, "not in this match");
    if (m.state === "HeroSelect" && !part.locked) {
      const hero = assetId(pick(body, "HeroAssetID", "HeroId"));
      if (hero) { part.hero = hero; part.skin = loadoutOf(who).skins[hero] || defaultSkinFor(hero); }
      const skin = assetId(pick(body, "CosmeticsAssetID"));
      if (skin) part.skin = skin;
      const chroma = assetId(pick(body, "LuxeSkinChromaAssetID", "LuxeSkinChroma"));
      if (chroma) part.chroma = chroma;
      if (pick(body, "LockedIn", "Locked") === true) part.locked = true;
      rememberHero(who, part.hero, part.skin);
      touchMatch(m);
    }
    return json(matchOut(m, who));
  }
  const getMatch = path.match(/^\/core-game\/matches\/([^/]+)$/);
  if (getMatch) {
    const m = matches.get(getMatch[1]);
    return m ? json(matchOut(m, uid)) : error(404, "match not found");
  }
  if (isCore) return json({});

  // ---- matchmaking status ----
  if (isMm) {
    if (/cancel/.test(path) || method === "DELETE") { cancelQueue(p); return json(partyOut(p)); }
    if (method === "POST") { const r = startQueue(p, pick(body, "QueueID", "QueueId")); return "error" in r ? fail(r) : json(partyOut(r)); }
    const m = activeMatch(uid);
    return json({ State: m ? m.state : p.state === "Matchmaking" ? "Queued" : "Idle", MatchId: m?.id || "", QueueId: p.queues[0] || "" });
  }

  // ---- parties ----
  if (path === "/party/parties" || path === "/party/parties/" || path === "/party/me" || path === "/party") {
    if (method === "POST") return json(partyOut(leave(uid)), 201);
    return json(partyOut(p));
  }
  const player = path.match(/^\/party\/players\/([^/]+)$/);
  if (player) {
    const who = decodeURIComponent(player[1]);
    if (method === "DELETE") { if (who !== uid) return error(403, "forbidden"); leave(uid); return noContent(); }
    return json({ ...partyPlayerOut(who), status: ensureParty(who).state === "Matchmaking" ? "MATCHMAKING" : "IDLE" });
  }
  if (/^\/party\/players\/[^/]+\/setDiscordUserID\//.test(path)) return json(partyPlayerOut(uid));

  const byId = path.match(/^\/party\/parties\/([^/]+)$/);
  if (byId) {
    const target = parties.get(decodeURIComponent(byId[1]));
    if (method === "DELETE") return json(partyOut(leave(uid)));
    return target ? json(partyOut(target)) : json(partyOut(p));
  }

  const sub = path.match(/^\/party\/parties\/([^/]+)\/(.+)$/);
  if (sub) {
    const pid = decodeURIComponent(sub[1]);
    const action = sub[2];
    const target = parties.get(pid);
    const mine = target && target.members.some((m) => m.id === uid) ? target : null;
    const isOwner = mine?.ownerId === uid;

    if (action === "join") {
      const r = join(uid, pid, c.url.searchParams.get("joinSecret") || String(pick(body, "JoinSecret") || ""));
      return "error" in r ? fail(r) : json(partyOut(r));
    }
    if (action === "declineInvite") {
      for (let i = invites.length - 1; i >= 0; i--) if (invites[i].to === uid && invites[i].partyId === pid) invites.splice(i, 1);
      push(uid, `/party/players/${uid}`, partyPlayerOut(uid));
      return json(partyPlayerOut(uid));
    }
    if (!mine) return error(404, "party_not_found");

    const memberRoute = action.match(/^members\/([^/]+)$/);
    if (memberRoute) {
      const who = decodeURIComponent(memberRoute[1]);
      if (method === "DELETE") {
        if (who !== uid && !isOwner) return error(403, "not_owner");
        if (who === uid) return json(partyOut(leave(uid)));
        mine.members = mine.members.filter((m) => m.id !== who);
        partyOf.delete(who);
        touchParty(mine);
        push(who, `/party/parties/${ensureParty(who).id}`, partyOut(ensureParty(who)));
        return json(partyOut(mine));
      }
      if (who !== uid) return error(403, "can only edit yourself");
      const me = mine.members.find((m) => m.id === uid)!;
      const hero = assetId(pick(body, "HeroAssetID", "HeroId", "SelectedHeroId"));
      const skin = assetId(pick(body, "CosmeticsAssetID", "CosmeticsId"));
      const chroma = assetId(pick(body, "LuxeSkinChroma", "LuxeSkinChromaAssetID"));
      if (hero && hero !== me.hero) { me.hero = hero; me.skin = loadoutOf(uid).skins[hero] || defaultSkinFor(hero); me.chroma = ""; }
      if (skin) me.skin = skin;
      if (chroma) me.chroma = chroma;
      const r = pick(body, "IsReady", "Ready");
      if (typeof r === "boolean") me.ready = r;
      const team = pick(body, "CustomGameTeamID");
      if (typeof team === "number") me.team = team;
      rememberHero(uid, me.hero, me.skin);
      touchParty(mine);
      return json(partyOut(mine));
    }
    if (action === "setTargetQueues") {
      if (!isOwner) return error(403, "not_owner");
      const ids = pick(body, "QueueIDs", "TargetQueueIDs", "Queues");
      const list = (Array.isArray(ids) ? ids : [ids ?? c.url.searchParams.get("queueIds")]).map((x) => queueById(x)?.id).filter(Boolean) as string[];
      if (list.length) { mine.queues = [...new Set(list)]; touchParty(mine); }
      return json(partyOut(mine));
    }
    if (action === "joinQueue") {
      if (!isOwner) return error(403, "not_owner");
      const r = startQueue(mine, pick(body, "QueueID", "QueueId") ?? mine.queues[0]);
      return "error" in r ? fail(r) : json(partyOut(r));
    }
    if (action === "leaveQueue") { cancelQueue(mine); return json(partyOut(mine)); }
    if (action.startsWith("sendInvite/")) {
      const to = decodeURIComponent(action.slice("sendInvite/".length));
      if (!profileById(to)) return error(404, "user_not_found");
      invites.push({ partyId: mine.id, from: uid, to, exp: Date.now() + 5 * 60_000 });
      push(to, `/party/players/${to}`, partyPlayerOut(to));
      return json(partyOut(mine));
    }
    const owner = action.match(/^(?:setOwner|setPartyOwner|promote|setLeader)\/([^/]+)$/);
    if (owner) {
      if (!isOwner) return error(403, "not_owner");
      const to = decodeURIComponent(owner[1]);
      if (!mine.members.some((m) => m.id === to)) return error(404, "not a member");
      mine.ownerId = to; touchParty(mine);
      return json(partyOut(mine));
    }
    if (action.startsWith("setIsOpen")) {
      const v = action.split("/")[1] ?? String(pick(body, "IsOpen") ?? "true");
      if (isOwner) { mine.isOpen = v !== "false"; touchParty(mine); }
      return json(partyOut(mine));
    }
    if (action.startsWith("setFillTeam")) {
      const v = action.split("/")[1] ?? String(pick(body, "FillTeam") ?? "Fill");
      if (isOwner) { mine.fill = /^no/i.test(v) ? "NoFill" : "Fill"; touchParty(mine); }
      return json(partyOut(mine));
    }
    if (action.startsWith("startSoloMode")) return json(partyOut(mine));
    return json(partyOut(mine));
  }
  return json(partyOut(p));
}

/** For the status page and the gates. */
export function playStats() {
  return {
    parties: parties.size,
    queued: [...parties.values()].filter((p) => p.state === "Matchmaking").length,
    matches: [...matches.values()].map((m) => ({ id: m.id, queue: m.queue.id, state: m.state, host: m.hostId, address: m.address, endReason: m.endReason, humans: m.participants.filter((p) => !p.bot).length })),
    hosts: [...hosts.values()].map(({ key, ...h }) => h),
  };
}
