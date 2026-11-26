// Local profiles. A profile is a display name plus a random key that stays on the player's own PC;
// nothing here is a password and nothing leaves the machine that runs the backend.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { collection } from "./store.ts";
import { signJwt, verifyJwt } from "./jwt.ts";

export type Profile = { userId: string; displayName: string; keyHash: string; createdAt: number; lastLoginAt: number };

const db = collection("profiles", { byId: {} as Record<string, Profile> });
const authCodes = new Map<string, { userId: string; exp: number }>();
const recentLogins: { userId: string; ip: string; at: number }[] = [];

const hash = (k: string) => createHash("sha256").update(k).digest("hex");
const NAME_RE = /^[\p{L}\p{N} _.-]{2,24}$/u;
const ACCESS_TTL = 12 * 3600;
const REFRESH_TTL = 30 * 86400;

export const profileById = (id: string): Profile | undefined => db.byId[id];
export const allProfiles = () => Object.values(db.byId);
export const profileByName = (name: string) => {
  const n = name.trim().toLowerCase().replace(/#\d+$/, "");
  return allProfiles().find((p) => p.displayName.toLowerCase() === n);
};
export const uniqueName = (p: Profile) => `${p.displayName}#${p.userId.slice(0, 4).toUpperCase()}`;

export type LoginResult = { ok: true; profile: Profile; profileKey: string; authCode: string } | { ok: false; status: number; error: string };

/** Create a profile for a new name, or sign back in to an existing one with its profile key. */
export function login(displayName: unknown, profileKey: unknown, ip: string): LoginResult {
  const name = String(displayName ?? "").trim();
  if (!NAME_RE.test(name)) return { ok: false, status: 400, error: "Display name must be 2–24 letters, digits, spaces, '_', '.' or '-'." };
  let p = profileByName(name);
  let key = String(profileKey ?? "");
  if (p) {
    const a = Buffer.from(hash(key)), b = Buffer.from(p.keyHash);
    if (!key || a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 409, error: "That name is taken on this backend. Pick another name, or sign in from the PC that created it." };
  } else {
    key = randomBytes(24).toString("base64url");
    p = { userId: randomUUID().replace(/-/g, ""), displayName: name, keyHash: hash(key), createdAt: Date.now(), lastLoginAt: 0 };
    db.byId[p.userId] = p;
  }
  p.lastLoginAt = Date.now();
  db.byId = db.byId;
  const authCode = randomBytes(18).toString("base64url");
  authCodes.set(authCode, { userId: p.userId, exp: Date.now() + 10 * 60_000 });
  recentLogins.unshift({ userId: p.userId, ip, at: Date.now() });
  recentLogins.length = Math.min(recentLogins.length, 50);
  return { ok: true, profile: p, profileKey: key, authCode };
}

export function redeemAuthCode(code: unknown): Profile | undefined {
  const e = authCodes.get(String(code ?? ""));
  if (!e) return undefined;
  authCodes.delete(String(code));
  return e.exp > Date.now() ? profileById(e.userId) : undefined;
}

/** The profile that most recently signed in from this address (used for grants that carry no credential). */
export function lastLoginFrom(ip: string): Profile | undefined {
  const r = recentLogins.find((l) => l.ip === ip && Date.now() - l.at < 30 * 60_000);
  return r ? profileById(r.userId) : undefined;
}

export function tokenFor(p: Profile, namespace: string, platformId = "") {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = randomUUID();
  const base = { sub: p.userId, namespace, display_name: p.displayName, unique_display_name: uniqueName(p), session_id: sessionId };
  return {
    access_token: signJwt({ ...base, iat: now, exp: now + ACCESS_TTL, kind: "access" }),
    refresh_token: signJwt({ ...base, iat: now, exp: now + REFRESH_TTL, kind: "refresh" }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_expires_in: REFRESH_TTL,
    user_id: p.userId,
    namespace,
    display_name: p.displayName,
    unique_display_name: uniqueName(p),
    platform_id: platformId,
    platform_user_id: platformId ? p.userId : "",
    simultaneous_platform_id: "",
    simultaneous_platform_user_id: "",
    is_comply: true,
    roles: ["user"],
    namespace_roles: [{ roleId: "user", namespace }],
    permissions: [],
    bans: [],
    session_id: sessionId,
    jti: randomUUID(),
  };
}

export function clientToken(namespace: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: signJwt({ sub: "client", namespace, iat: now, exp: now + 3600, kind: "client" }),
    token_type: "Bearer", expires_in: 3600, namespace, roles: [], namespace_roles: [], permissions: [], bans: [], is_comply: true,
  };
}

export function profileFromToken(token: string | undefined, kind: "access" | "refresh" = "access"): Profile | undefined {
  if (!token) return undefined;
  const c = verifyJwt(token);
  if (!c || c.kind !== kind) return undefined;
  return profileById(String(c.sub));
}
