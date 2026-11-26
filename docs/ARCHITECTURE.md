# Architecture

```
            this PC (or each friend's PC)                          host PC (one per group)
 ┌──────────────────────────────────────────────┐        ┌───────────────────────────────────────────────┐
 │ SUPERVIVE (unmodified)                        │        │ backend  bun start  :24970  (REVIVE_LAN=1)     │
 │   │  HTTPS / WSS to its usual service names   │        │   login · IAM · lobby WS · messenger WS        │
 │   ▼  and to https://127.0.0.1:24973           │  HTTP  │   parties · queues · Hero Select · hosts       │
 │ client/proxy.mjs  :24972 proxy / :24973 TLS ──┼───────►│                                                │
 │   per-install CA, terminates TLS, forwards    │        │ client/agones-sdk.mjs :9358  ◄── game server   │
 └──────────────────────────────────────────────┘        │ headless SUPERVIVE in server mode  UDP :7777   │
                                                          └───────────────────────────────────────────────┘
```

## Pieces

| Path | Role |
|---|---|
| `server/main.ts` | Bun HTTP + WebSocket server, address gate (loopback; private ranges in LAN mode), routing |
| `server/lib/accounts.ts` | Local profiles (name + key hash), one-time launcher auth codes, token issuing |
| `server/lib/jwt.ts` | RS256 key generated per install, JWT sign/verify, JWKS |
| `server/lib/services.ts` | IAM grants and user lookups, client config, content manifest, inventory, personalization, empty-but-valid answers for unused services, unknown-call log |
| `server/lib/play.ts` | Parties, invites, queues, bot fill, Hero Select, match lifecycle, host registry |
| `server/lib/lobby.ts` | Lobby WebSocket (`key: value` frames): friends, presence |
| `server/lib/messenger.ts` | Messenger WebSocket: `hb` keepalive, `{Resource, Version, Payload}` pushes |
| `server/lib/catalog.ts`, `players.ts` | Generated catalog + editable queues; loadouts and "everything owned" |
| `server/lib/store.ts`, `config.ts` | JSON persistence in `local-data/`, `.env` settings |
| `client/proxy.mjs` | TLS redirect: CONNECT interception of the game's service hostnames + a direct TLS endpoint; CA install/uninstall |
| `client/launch.ps1` | Writes reversible config overrides, signs in, launches the game with a one-time auth code |
| `match/` | Match server (UE5 network protocol, match rules, bots, storm, loot, shops, objectives, abilities); see docs/MATCHES.md |
| `client/host.ps1`, `client/agones-sdk.mjs` | Alternative, experimental: the game's own server mode (docs/GAME-SERVER-MODE.md) |
| `tools/setup.ts`, `tools/gen/` | Version check and generators that read the user's own install |
| `tools/check-oss.ts` | Release gate |
| `tools/test/` | Gates |

## Sign-in flow

1. `launch.ps1` posts the chosen name (and the stored profile key, if any) to `/revive/login`.
2. The backend answers with the profile key (kept in `local-data/profile.json`) and a one-time code.
3. The game is launched with that code; it exchanges it at the IAM token endpoint for an access and a
   refresh token signed by the per-install key.
4. Grants that carry no credential the backend issued (e.g. a platform token) resolve to the last
   launcher sign-in from the same address within 30 minutes.

## Match flow

`HeroSelect` (`REVIVE_HERO_SELECT_SECONDS`, or until every human locks in) → `Allocating` →
with hosting off: `Complete` (`hosting_disabled`); otherwise the first idle registered match server is
assigned → `AwaitingReady` → the server reports ready (`/api/ds/matches/:id/ready`, or the SDK stand-in
reports `Allocated`) → `InProgress`, and every player receives `ConnectionDetails.address = <host LAN IP>:<port>` →
`Complete` when the match server posts `/core-game/matches/:id/complete`, the host disappears, or
nobody is left. No host within `REVIVE_HOST_WAIT_SECONDS` → `Complete` (`no_host_available`).

## Data

All state is in `REVIVE_DATA_DIR` (default `local-data/`): `profiles.json`, `players.json`,
`social.json`, `signing-key.json`, `certs/`, `generated/`, `queues.json`, `logs/`. Parties and matches
are memory-only and end with the process.
