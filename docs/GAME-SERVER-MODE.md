# Using the game's own server mode  —  EXPERIMENTAL, secondary

The normal way to host matches is the built-in match server (docs/MATCHES.md). This page describes an
alternative that uses the game's own server mode instead. **It has not been seen to complete a match.**

## The idea

There is no dedicated server to download. The game client contains its own server mode. One player —
the host — runs a second, headless copy of their own, unmodified game in that mode on their PC. The
backend hands that PC's LAN address to everyone in the match. It is a listen-server architecture in
the practical sense: the match runs on a player's machine, nothing runs anywhere else.

No in-game mods are used. Earlier experiments that relied on a Lua mod loader do not work on this build
without defeating the game's protection, which this project will not do.

## Running it

On the host PC:

```powershell
# .env: REVIVE_LAN=1  (do not also run `bun run match`)
bun start
powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Name Host          # once, writes the overrides
powershell -ExecutionPolicy Bypass -File client\host.ps1                       # starts the match server
powershell -ExecutionPolicy Bypass -File client\host.ps1 -Stop
```

`host.ps1` starts `client/agones-sdk.mjs` (a stand-in for the Agones SDK sidecar the game's server mode
talks to on `localhost:9358`), then the game with the server standby map from your catalog,
`?listen`, `-port`, `-nullrhi -nosound`, and the same service overrides as the client. It then reports
whether the process stayed up, whether UDP 7777 opened, what the SDK saw, and the interesting lines of
the server log.

## What is implemented and tested (on Linux, without the game)

- The SDK stand-in serves the public Agones SDK REST surface (`/ready`, `/health`, `/gameserver`,
  `/metadata/label|annotation`, `/allocate`, `/reserve`, `/shutdown`) and both watch styles
  (`ws://…/watch/gameserver` with `{"result": GameServer}` messages, and the chunked HTTP stream).
- It registers the PC with the backend, heartbeats, and flips to `Allocated` with the match id in its
  labels and annotations when the backend assigns a match.
- The backend assigns matches to idle hosts, moves them `InProgress` on acknowledgement, gives
  players the host address, serves `/core-game/matches/:id/details` without a player token, and
  completes the match on `/complete`, host loss or abandonment.

`bun tools/test/check-backend.ts` drives all of this with a real `agones-sdk.mjs` process.

## What is not known

- Whether the game's server mode starts from the standby map with these arguments and opens its port.
- **Which label or annotation key** the server reads the match id from after allocation. The stand-in
  publishes it under `matchId`, `sessionId` and `session-id`; set `REVIVE_AGONES_KEYS` to try others.
- Which backend calls the server makes after allocation and what it needs from them. Unknown calls are
  logged to `local-data/logs/unknown.jsonl` — that file is the to-do list.
- Whether clients accept `ConnectionDetails.address` and connect, and what the server expects of them.

If you get further, please contribute the log lines (see CONTRIBUTING).
