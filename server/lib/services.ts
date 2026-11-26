// Account, identity and "everything else" endpoints: local login, the IAM token grants, user lookups,
// client configuration, content manifest, inventory and personalization. Anything the client asks
// for that is not implemented gets an empty success and is logged to <data>/logs/unknown.jsonl so it
// can be filled in later.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, EXPERIMENTAL_HOSTING, LAN, PUBLIC_HOST, VERSION } from "./config.ts";
import { assetId, error, json, noContent, nowIso, page, pick, type Ctx } from "./http.ts";
import { allProfiles, clientToken, lastLoginFrom, login, profileById, profileByName, profileFromToken, redeemAuthCode, tokenFor, uniqueName, type Profile } from "./accounts.ts";
import { jwks } from "./jwt.ts";
import { catalog, CLIENT_BUILD, queues } from "./catalog.ts";
import { changed, contentManifest, heroesOut, inventory, loadoutOf, personalization } from "./players.ts";
import { push } from "./messenger.ts";
import { playStats } from "./play.ts";

const TLS_PORT = Number(process.env.REVIVE_TLS_PORT || 24973);

function publicUser(p: Profile, namespace: string) {
  return { userId: p.userId, namespace, displayName: p.displayName, uniqueDisplayName: uniqueName(p), avatarUrl: "", publicId: p.userId, createdAt: nowIso(p.createdAt), enabled: true, bans: [] };
}

function grant(c: Ctx): Response {
  const b = c.body || {};
  const gt = String(b.grant_type || "");
  if (gt === "client_credentials") return json(clientToken(c.namespace));
  let p: Profile | undefined;
  if (gt === "authorization_code") p = redeemAuthCode(b.code);
  else if (gt === "refresh_token") p = profileFromToken(b.refresh_token, "refresh");
  p ||= profileFromToken(b.access_token) || profileFromToken(b.refresh_token, "refresh") || c.user || undefined;
  // Grants with no credential of ours (platform tokens, exchange codes) resolve to whoever signed in
  // from this same address through the launcher in the last 30 minutes.
  p ||= lastLoginFrom(c.ip);
  if (!p) return json({ error: "invalid_grant", error_description: "Sign in through the launcher first.", errorCode: 10131, errorMessage: "invalid grant" }, 400);
  const platform = c.path.match(/\/platforms\/([^/]+)\/token/)?.[1] || "";
  return json(tokenFor(p, c.namespace, platform));
}

function userMe(c: Ctx, p: Profile) {
  return {
    userId: p.userId, namespace: c.namespace, displayName: p.displayName, uniqueDisplayName: uniqueName(p), userName: p.displayName,
    emailAddress: "", emailVerified: true, country: "", dateOfBirth: "", createdAt: nowIso(p.createdAt), enabled: true,
    platformId: "", platformUserId: "", platformInfos: [], authType: "EMAILPASSWD", roles: ["user"],
    namespaceRoles: [{ roleId: "user", namespace: c.namespace }], permissions: [], bans: [], avatarUrl: "",
  };
}

function clientConfig() {
  const base = `https://127.0.0.1:${TLS_PORT}`;
  const names = [
    "coregame", "core-game", "contentservice", "content-service", "party", "mmr", "storefront", "inventory", "platforminventory",
    "playerstats", "player-stats", "matchhistory", "match-history", "progression", "battlepass", "referral", "armory", "mailbox",
    "behavior", "personalization", "postauth", "usermeta", "user-meta", "wallet", "order", "endofgame", "eog-service", "eog",
    "entitlement", "redemption", "clientconfig", "matchdetails",
  ];
  const ServiceHostnames: Record<string, string> = Object.fromEntries(names.map((n) => [n, base]));
  // libwebsockets verifies DNS SANs only: an IP SAN is rejected with X509_V_ERR_HOSTNAME_MISMATCH.
  ServiceHostnames.messaging = `wss://localhost:${TLS_PORT}/lobby/notifications`;
  let toggles: Record<string, unknown> = {};
  try { toggles = JSON.parse(readFileSync(join(DATA_DIR, "feature-toggles.json"), "utf8")); } catch {}
  const etag = `local-${Bun.hash(JSON.stringify(toggles)).toString(16)}`;
  return json({
    ClientVersions: [CLIENT_BUILD, "*"], ServiceHostnames, FeatureToggles: toggles, PlaytestEnabled: false, PlaytestWindows: [],
    InventoryFreeVersion: 1, StatusMessages: null, VendorConfigs: {}, CohortConfigs: {}, BannerConfigs: { configs: [] },
    ETag: etag, LastUpdated: nowIso(),
  }, 200, { etag: `"${etag}"` });
}

function logUnknown(c: Ctx) {
  try {
    mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
    appendFileSync(join(DATA_DIR, "logs", "unknown.jsonl"), JSON.stringify({ at: nowIso(), method: c.method, path: c.path, query: c.url.search }) + "\n");
  } catch {}
}

export function handleServices(c: Ctx): Response | null {
  const { path, method, body } = c;
  const u = c.user;

  // ---- Local Edition endpoints ----
  if (path === "/revive/login" && method === "POST") {
    const r = login(body.displayName, body.profileKey, c.ip);
    if (!r.ok) return error(r.status, r.error);
    return json({ userId: r.profile.userId, displayName: r.profile.displayName, uniqueDisplayName: uniqueName(r.profile), profileKey: r.profileKey, authCode: r.authCode });
  }
  if (path === "/revive/status" || path === "/revive/health") {
    const cat = catalog();
    return json({
      ok: true, version: VERSION, lan: LAN, publicHost: PUBLIC_HOST, experimentalHosting: EXPERIMENTAL_HOSTING, uptime: Math.round(process.uptime()),
      profiles: allProfiles().length, catalog: { generatedAt: cat.generatedAt, heroes: cat.heroes.length, maps: cat.maps.length }, queues: queues().map((q) => q.id),
      play: playStats(),
    });
  }

  // ---- IAM ----
  if (/\/oauth\/(?:platforms\/[^/]+\/)?token(?:\/exchange)?$/.test(path) && method === "POST") return grant(c);
  if (/\/oauth\/(jwks|certs)$/.test(path)) return json(jwks());
  if (/\/oauth\/(revoke|logout)|\/logout$/.test(path)) return noContent();
  if (path.includes("/oauth/verify")) return json({ active: !!u, exp: Math.floor(Date.now() / 1000) + 3600, namespace: c.namespace });
  if (/^\/iam\//.test(path)) {
    if (/\/users\/me(\/.*)?$/.test(path)) {
      if (!u) return error(401, "unauthorized", 20001);
      if (path.endsWith("/platforms")) return page([]);
      return json(userMe(c, u));
    }
    if (path.includes("/users/availability")) {
      const q = String(c.url.searchParams.get("query") || "");
      return new Response(null, { status: q && profileByName(q) ? 204 : 404 });
    }
    if (path.includes("/users/bulk/basic") && method === "POST") {
      const ids: string[] = Array.isArray(body?.userIds) ? body.userIds.map(String) : [];
      return json({ data: ids.map(profileById).filter(Boolean).map((p) => publicUser(p!, c.namespace)) });
    }
    if (/\/namespaces\/[^/]+\/users(\/search)?$/.test(path) && method === "GET") {
      const q = String(c.url.searchParams.get("query") || "").toLowerCase().replace(/#.*$/, "");
      const hits = allProfiles().filter((p) => q && p.displayName.toLowerCase().includes(q)).slice(0, 20);
      return page(hits.map((p) => publicUser(p, c.namespace)));
    }
    const one = path.match(/\/users\/([0-9a-f]{32})(?:\/(information|platforms|bans))?$/);
    if (one) {
      const p = profileById(one[1]);
      if (!p) return error(404, "user not found", 20008);
      if (one[2] === "platforms" || one[2] === "bans") return page([]);
      return json(publicUser(p, c.namespace));
    }
    if (path.includes("/inputValidations")) return json({ data: [], version: 1 });
    return method === "GET" ? page([]) : json({});
  }

  // ---- agreements / eligibility (nothing to accept locally) ----
  if (path.startsWith("/agreement/")) {
    if (path.includes("eligibilities")) return json([]);
    if (method === "GET") return json([]);
    return json({ proceed: true, comply: true });
  }

  // ---- client configuration & content ----
  if (path === "/configuration/public" || path === "/configuration/client" || path.startsWith("/client-config/")) return clientConfig();
  if (path.startsWith("/content-service/") || path === "/content/manifest" || path === "/content-manifest") {
    // The client always asks for nonEnabledOnly=true, and LokiAssetManager bypasses the AssetManager
    // directory scan, so this manifest is the client's only roster source. Never send an empty one.
    return json(contentManifest());
  }
  if (path.startsWith("/postauth/")) return json({ NeedsJWTRefresh: false });
  if (path.startsWith("/behavior/")) return json({ allowed: true, banned: false, bans: [], PenaltyRemainingSeconds: 0 });

  if (!u) return null;
  const uid = u.userId;

  // ---- ownership: everything in your own catalog is unlocked ----
  if (path.startsWith("/inventory/") || path.startsWith("/platforminventory/")) return json(inventory(uid));
  if (path === "/storefront/heroes" || path.startsWith("/storefront/heroes/")) return json(heroesOut(uid));
  if (path.startsWith("/storefront/")) return json({ PlayerID: uid, Offers: [], Entitlements: [], Version: 1 });
  if (path.startsWith("/wallet/")) return json({ PlayerID: uid, Balances: {}, Currencies: [], Version: 1 });
  if (path.startsWith("/order/")) return error(400, "the Local Edition has no shop");

  if (path.startsWith("/personalization/")) {
    const l = loadoutOf(uid);
    if (path.includes("/clientprofile")) {
      if (method !== "GET") { const d = pick(body, "Data"); if (d && typeof d === "object") Object.assign(l.clientProfile, d); changed(uid); }
      return json({ ID: uid, Version: l.version, Data: l.clientProfile });
    }
    if (method === "PUT" || method === "POST" || method === "PATCH") {
      const bundle = path.match(/\/cosmeticsbundle\/([^/]+)/);
      const chroma = path.match(/\/luxechromas\/([^/]+)/);
      if (bundle) { const v = assetId(pick(body, "CosmeticsBundle", "CosmeticsAssetID", "Asset", "Value")); if (v) l.skins[decodeURIComponent(bundle[1])] = v; }
      else if (chroma) { const v = assetId(pick(body, "LuxeSkinChroma", "Asset", "Value")); if (v) l.chromas[decodeURIComponent(chroma[1])] = v; }
      else {
        const em = pick(body, "EmoteIDs"); if (Array.isArray(em)) l.emotes = em.map(assetId).filter(Boolean);
        const ti = pick(body, "TitleIDs"); if (Array.isArray(ti)) l.titles = ti.map(assetId).filter(Boolean);
        const sl = pick(body, "SlotCosmeticsEntries", "Entries");
        if (Array.isArray(sl)) for (const e of sl) {
          const slot = String(pick(e, "Slot") || ""), asset = assetId(pick(e, "Asset", "AssetId"));
          if (!slot) continue;
          l.slots = l.slots.filter((x) => x.Slot !== slot);
          if (asset) l.slots.push({ Slot: slot, Asset: asset });
        }
        const lp = assetId(pick(body, "LobbyPlatformPreference")); if (lp) l.lobbyPlatform = lp;
      }
      changed(uid);
      push(uid, `/personalization/players/${uid}`, personalization(uid));
    }
    return json(personalization(uid));
  }

  // ---- progression-type services: a fresh, empty, valid answer ----
  if (/^\/(progression|battlepass|armory|mailbox|mmr|player-stats|playerstats|match-history|matchhistory|referral|user-meta|usermeta|entitlement|redemption|redeem|discord-api)\//.test(path)) {
    logUnknown(c);
    if (path.startsWith("/discord-api/")) return json({ token_type: "Bearer", access_token: "", expires_in: 0, scope: "" });
    if (path.startsWith("/mailbox/")) return json({ PlayerID: uid, Messages: [], Version: 1 });
    return json({ PlayerID: uid, ID: uid, Version: 1 });
  }
  return null;
}

/** Last resort for anything no module claimed. */
export function fallback(c: Ctx): Response {
  logUnknown(c);
  if (/\/(telemetry|game-telemetry|analytics|gdpr|ams|qosm)\//.test(c.path)) return c.method === "GET" ? json({ servers: [] }) : noContent();
  if (c.method === "GET") return /\/v\d\//.test(c.path) ? page([]) : json({});
  return c.method === "DELETE" ? noContent() : json({});
}
