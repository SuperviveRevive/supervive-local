// Lobby WebSocket. Frames are newline-separated `key: value` lines with `type` and `id`; a request of
// type `fooRequest` is answered with `fooResponse` carrying the same `id` and `code: 0`.
// Friends and presence are implemented here; everything else gets an empty successful response.
import { randomUUID } from "node:crypto";
import { collection, save } from "./store.ts";
import { allProfiles, profileById, profileByName, uniqueName } from "./accounts.ts";

type Sock = { send(s: string): void; data: { userId: string; namespace: string; buf?: string } };

const sockets = new Map<string, Set<Sock>>();
const social = collection("social", {
  friends: {} as Record<string, string[]>,
  incoming: {} as Record<string, string[]>,
  outgoing: {} as Record<string, string[]>,
});
const presence = new Map<string, { availability: string; activity: string }>();

const online = (uid: string) => (sockets.get(uid)?.size || 0) > 0;
const list = (b: Record<string, string[]>, u: string) => (b[u] ||= []);
const add = (b: Record<string, string[]>, u: string, o: string) => { if (!list(b, u).includes(o)) b[u].push(o); };
const del = (b: Record<string, string[]>, u: string, o: string) => { b[u] = list(b, u).filter((x) => x !== o); };
const dirty = () => save("social");

function enc(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(",")}]`;
  if (v && typeof v === "object") return JSON.stringify(v);
  const s = String(v ?? "");
  return s === "" || /[\n"\\]|^[\[{]/.test(s) ? JSON.stringify(s.replace(/\r?\n/g, " ")) : s;
}

export function frame(type: string, fields: Record<string, unknown>, head: Record<string, string> = {}): string {
  const lines = [`type: ${type}`, ...Object.entries(head).map(([k, v]) => `${k}: ${v}`)];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && !(k in head) && k !== "type") lines.push(`${k}: ${enc(v)}`);
  return lines.join("\n");
}

export function parseFrame(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf(": ");
    if (i > 0) {
      let v = line.slice(i + 2).trim();
      if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
      try { v = decodeURIComponent(v); } catch {}
      out[line.slice(0, i).trim()] = v;
    }
  }
  return out;
}

function notify(uid: string, type: string, fields: Record<string, unknown>) {
  const f = frame(type, fields);
  for (const s of sockets.get(uid) || []) { try { s.send(f); } catch {} }
}

function presenceOf(uid: string) {
  const p = presence.get(uid);
  return {
    userID: uid,
    availability: online(uid) ? p?.availability || "online" : "offline",
    activity: online(uid) ? p?.activity || "" : "",
    platform: "",
    lastSeenAt: new Date().toISOString(),
  };
}
const broadcastPresence = (uid: string) => { for (const f of list(social.friends, uid)) notify(f, "userStatusNotif", presenceOf(uid)); };

export function lobbyOpen(ws: Sock) {
  const uid = ws.data.userId;
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid)!.add(ws);
  const sid = randomUUID();
  ws.send(frame("connectNotif", { loginType: "", reconnectFromCode: 0, lobbySessionID: sid, sequenceID: 0, sequenceNumber: 0 }));
  broadcastPresence(uid);
}

export function lobbyClose(ws: Sock) {
  const uid = ws.data.userId;
  const s = sockets.get(uid);
  s?.delete(ws);
  if (s && !s.size) { sockets.delete(uid); broadcastPresence(uid); }
}

function resolve(ref: string): string {
  if (profileById(ref)) return ref;
  return profileByName(ref)?.userId || "";
}

export function lobbyMessage(ws: Sock, raw: string) {
  if (!raw) return;
  let msg = raw;
  if (msg.startsWith("LbS")) { ws.data.buf = (ws.data.buf || "") + msg.slice(3); if (!msg.endsWith("LbE")) return; msg = ws.data.buf.slice(0, -3); ws.data.buf = ""; }
  const f = parseFrame(msg);
  const type = f.type || "";
  const uid = ws.data.userId;
  const reply = (fields: Record<string, unknown> = {}, code = 0) =>
    ws.send(frame(type.replace(/Request$/, "Response"), fields, { id: f.id || "0", code: String(code) }));
  const other = resolve(f.friendId || f.userId || f.publicId || "");
  const friendsWith = (a: string, b: string) => list(social.friends, a).includes(b);

  switch (type) {
    case "heartbeat": case "ping": return ws.send(frame("heartbeat", {}));
    case "setUserStatusRequest":
      presence.set(uid, { availability: String(f.availability || "online"), activity: String(f.activity || "") });
      reply(); return broadcastPresence(uid);
    case "friendsStatusRequest": {
      const ids = list(social.friends, uid);
      const ps = ids.map(presenceOf);
      return reply({ friendsId: ids, availability: ps.map((p) => p.availability), activity: ps.map((p) => p.activity), platform: ps.map(() => ""), lastSeenAt: ps.map((p) => p.lastSeenAt) });
    }
    case "listOfFriendsRequest": case "listOfFriendsWithTimeRequest":
      return reply({ friendsId: list(social.friends, uid), friendIds: list(social.friends, uid) });
    case "listIncomingFriendsRequest": case "listIncomingFriendsWithTimeRequest":
      return reply({ friendsId: list(social.incoming, uid) });
    case "listOutgoingFriendsRequest": case "listOutgoingFriendsWithTimeRequest":
      return reply({ friendsId: list(social.outgoing, uid) });
    case "getFriendshipStatusRequest":
      return reply({ friendshipStatus: friendsWith(uid, other) ? 3 : list(social.outgoing, uid).includes(other) ? 1 : list(social.incoming, uid).includes(other) ? 2 : 0 });
    case "requestFriendsRequest": case "requestFriendsByPublicIDRequest": {
      if (!other || other === uid) return reply({}, 11200);
      if (list(social.incoming, uid).includes(other)) { befriend(uid, other); reply(); notify(other, "acceptFriendsNotif", { friendId: uid }); return; }
      add(social.outgoing, uid, other); add(social.incoming, other, uid); dirty();
      reply(); return notify(other, "requestFriendsNotif", { friendId: uid });
    }
    case "acceptFriendsRequest":
      if (!other || !list(social.incoming, uid).includes(other)) return reply({}, 11200);
      befriend(uid, other); reply(); notify(other, "acceptFriendsNotif", { friendId: uid }); return broadcastPresence(uid);
    case "rejectFriendsRequest":
      del(social.incoming, uid, other); del(social.outgoing, other, uid); dirty(); reply(); return notify(other, "rejectFriendsNotif", { userId: uid });
    case "cancelFriendsRequest":
      del(social.outgoing, uid, other); del(social.incoming, other, uid); dirty(); reply(); return notify(other, "cancelFriendsNotif", { userId: uid });
    case "unfriendRequest":
      del(social.friends, uid, other); del(social.friends, other, uid); dirty(); reply(); return notify(other, "unfriendNotif", { friendId: uid });
    default:
      if (type.endsWith("Request")) return reply();
  }
}

function befriend(a: string, b: string) {
  add(social.friends, a, b); add(social.friends, b, a);
  for (const [x, y] of [[a, b], [b, a]]) { del(social.incoming, x, y); del(social.outgoing, x, y); }
  dirty();
}

export const friendsOf = (uid: string) => list(social.friends, uid);
export const lobbyOnline = online;
export const knownPlayers = () => allProfiles().map((p) => ({ userId: p.userId, displayName: p.displayName, uniqueDisplayName: uniqueName(p), online: online(p.userId) }));
