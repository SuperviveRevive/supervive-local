# Matches

Matches run on a **match server on the host PC**: `match/`, a from-scratch implementation of the
Unreal Engine 5 network protocol the 2.0.4 client speaks, written in TypeScript and run with Bun. The
game client is unmodified; it connects to the host PC's address exactly as it connected to the old
servers. Nothing runs anywhere else.

```
host PC:   bun start          (backend, REVIVE_LAN=1 for friends)
           bun run match      (match server, UDP 7777)
everyone:  client\launch.ps1  (each player's game, pointed at the host's backend)
```

Open UDP 7777 (and TCP 24970 for the backend) on the host PC's firewall for LAN play.

## How a match flows

1. The match server registers with the backend (`/api/ds/register`) and heartbeats every 2 s.
2. Parties queue; the backend forms a match, fills empty seats with bots and runs Hero Select.
3. The backend allocates the match to an idle match server. On its next heartbeat the server takes the
   allocation (map, game mode, queue), fetches the roster from `/core-game/matches/:id/details` and
   reports ready.
4. The backend moves the match `InProgress` and hands every player `ConnectionDetails.address =
   <host LAN IP>:7777`. The clients travel there.
5. When the match ends the server posts `/core-game/matches/:id/complete` and everyone returns to the lobby.

## What the match server does

Built from our own protocol work and from **recorded retail match traffic** (the knowledge, not the
recordings — no capture files, packet dumps or replayed recorded bytes are in this repository):

- Stateless handshake, control channel (Hello/Login/Welcome/Join), reliable bunches, acks, NetGUID exports.
- Player controller, player state, hero spawn and possession, client movement with corrections.
- The Breach drop: plane, drop pods, landing.
- Bots, teams, damage, knocks, kills, respawn rules, win conditions; the storm and its phases.
- World loot boxes, shops and wallet, death boxes, basecamps (capture points), objectives for the
  non-Breach modes (Domination, Battlefield, PrismaBank…), mode profiles and round phases.
- Abilities: the server-side ability system wire (grants, activation, prediction keys, kill feed).

## Known limits — read before you play

- **Only FireFox has an ability kit.** Kits are measured from recorded traffic, and every recorded match
  played FireFox. Other hunters spawn and move but have no abilities until their kits are measured.
  `match/data/ability-grants.json` is where new kits go.
- **One set of hunter stats.** Health and movement speed are the same for every hunter unless you add
  `match/data/hero-stats.json` (`{"hp": {"Hero": 1290}, "move": {"Hero": [465, 5400]}}`).
- **No recorded world replay.** Map actors whose initial state was only known from recordings (some
  world props, Airdoos) are not sent.
- **No terrain collision table.** Spawns and landings fall back to the spawn tables and floor points the
  server learns from players walking (`local-data/match/learned-floor.json`).
- **Verification.** The gates below run on Linux without the game. Earlier builds of this server were
  driven with a real 2.0.4 client (lobby → Breach → drop → landing → shop/death boxes worked); this
  exact build, with the items above removed, has **not yet been run against the real client**.

## Gates

`bun run check` runs, among others:

| Gate | What it proves |
|---|---|
| `tools/test/check-match-hosting.ts` | backend + a real `match/run.ts` process: registration, allocation, ready, address hand-out, completion, deregistration |
| `tools/test/match/check-ue-server.ts` | UDP handshake, control login, actor spawn, status endpoint, replication layout handles |
| `tools/test/match/check-ue-protocol.ts` | packet framing and acks |
| `tools/test/match/check-ue-match.ts` | match simulation: bots, teams, movement, abilities, combat, storm, respawn, win conditions, round phases |
| `tools/test/match/check-objectives.ts`, `check-modes.ts` | every objective mode and mode profile |

## Data tables

`match/data/` holds the tables the server needs, each pinned by SHA-256 in `tools/match-tables.json`
(the release gate refuses any other file there). They describe the game's network structure —
replication layouts and function flags from the executable's reflection data, enum values, spawn
locations — plus ability specs decoded from traffic. They contain no recorded packets.
