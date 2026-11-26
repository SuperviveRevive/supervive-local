// Messenger WebSocket (/lobby/notifications…): the client sends "hb" as a keepalive and expects it
// echoed; the server pushes {Resource, Version, Payload} where Payload is the JSON-encoded resource the
// client would otherwise GET from the matching REST path. Versions must only ever rise per resource.
type Sock = { send(s: string): void };

const sockets = new Map<string, Set<Sock>>();
const versions = new Map<string, number>();

export function resourceVersion(resource: string): number {
  let v = versions.get(resource);
  if (v === undefined) { v = Math.floor(Date.now() / 1000); versions.set(resource, v); }
  return v;
}

export function messengerOpen(ws: Sock, userId: string) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId)!.add(ws);
}

export function messengerMessage(ws: Sock, raw: string) {
  const t = raw.trim();
  if (t === "hb" || t === "ping") ws.send(JSON.stringify({ Resource: "hb", Version: 0, Payload: "" }));
}

export function messengerClose(ws: Sock, userId: string) {
  const s = sockets.get(userId);
  s?.delete(ws);
  if (s && !s.size) sockets.delete(userId);
}

export const messengerOnline = (userId: string) => (sockets.get(userId)?.size || 0) > 0;

/** Push a resource. Returns the version used so REST reads can report the same one. */
export function push(userId: string, resource: string, payload: Record<string, unknown>): number {
  const v = resourceVersion(resource) + 1;
  versions.set(resource, v);
  const frame = JSON.stringify({ Resource: resource, Version: v, Payload: JSON.stringify({ ...payload, Version: v }) });
  for (const ws of sockets.get(userId) || []) { try { ws.send(frame); } catch {} }
  return v;
}

export function pushMany(userIds: Iterable<string>, resource: string, payload: Record<string, unknown>) {
  for (const u of new Set(userIds)) push(u, resource, payload);
}
