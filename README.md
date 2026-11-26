# SUPERVIVE Revive — Local Edition

Play your own copy of **SUPERVIVE 2.0.4** (Steam build `release2.4.live-156430-shipping`) again on your
PC or with friends on the same network. The game's online services were shut down; this project is a
small backend that you run yourself and that stands in for them.

- **No central server.** Nobody hosts anything for you. One player runs the backend; friends on the same
  LAN point their launcher at that PC.
- **No accounts on anyone's server.** You pick a display name; a random key stays on your PC.
- **No game files.** Nothing from the game is in this repository. On first setup the tools read *your*
  install (read-only) and generate the data they need into `local-data/`, which is never committed.
- **The game runs unmodified.** No patched executables, no extra paks, no injected DLLs, no mods.
- **No recordings.** The match server was built using what recorded retail matches showed, but no capture
  files, packet dumps or replayed recorded bytes are included.

> Not affiliated with, endorsed by or connected to Theorycraft Games or AccelByte. No game files are
> included or distributed. You need your own copy of the game.

## Status — read this first

| Part | State |
|---|---|
| Local login, tokens, profile | Implemented and tested against the backend gate |
| Lobby and Messenger websockets, friends, presence | Implemented and tested |
| Parties, invites, hunter selection, queues, bot fill, Hero Select | Implemented and tested |
| Everything unlocked (from the catalog your setup generates) | Implemented; asset names are inferred (see *Known limits*) |
| TLS redirect proxy with a per-install CA | Implemented and tested |
| Windows launcher (`client/launch.ps1`) | Written and syntax-checked; **not yet run against the real game** |
| **Matches** — `bun run match` on the host PC | Match server built in; allocation tested end to end with the backend. **This build has not yet been run against the real client.** Every hunter has a kit; only FireFox's is measured on the wire. See [docs/MATCHES.md](docs/MATCHES.md) |

If no match server is running, a match ends after Hero Select with the reason `no_host_available` and
everyone returns to the lobby. The backend never pretends a server exists.

## Requirements

- Windows 10/11 with SUPERVIVE 2.0.4 installed (Steam build above)
- [Bun](https://bun.sh) 1.1 or newer
- For LAN play: every PC on the same network, the host PC reachable on TCP 24970 (backend) and UDP 7777 (match)

## Install

```powershell
git clone https://github.com/SuperviveRevive/supervive-local
cd supervive-local
copy .env.example .env
```

## First-time setup (once per install)

```powershell
bun run setup -- --game "C:\Program Files (x86)\Steam\steamapps\common\SUPERVIVE"
```

This checks the build is 2.0.4. To unlock hunters and cosmetics and to get a queue list, give setup a
package listing of your own install and your install's `DefaultEngine.ini`, exported with any UE asset
browser you trust:

```powershell
bun run setup -- --game "<install>" --listing "<packages.txt or export folder>" --ini "<DefaultEngine.ini>"
```

Details, accepted formats and how to edit the queue list: [docs/SETUP.md](docs/SETUP.md).

## Play on this PC

```powershell
bun start                                                        # terminal 1: the backend
bun run match                                                    # terminal 2: the match server (UDP 7777)
powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Name "YourName"   # terminal 3
```

The launcher starts the TLS proxy, asks once whether to trust the CA it generated (see *What it changes*),
writes the service overrides into your user config, signs you in and starts the game.

## Play with friends on a LAN

On the host PC set `REVIVE_LAN=1` in `.env` (optionally `REVIVE_BIND` / `REVIVE_PUBLIC_HOST`), then
`bun start` and `bun run match`, and allow TCP 24970 and UDP 7777 through the firewall. The backend prints
the address friends should use. Each friend runs:

```powershell
powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Name "TheirName" -Backend http://<host-ip>:24970
```

In LAN mode the backend only accepts private-range addresses; it is not meant to be exposed to the internet.

## What it changes, and how to undo it

1. **Your user config** — a marked block is appended to
   `%LOCALAPPDATA%\SUPERVIVE\Saved\Config\WindowsClient\Engine.ini` and `Game.ini`, after a backup.
2. **The game's trust bundle** — only after you answer `y`, the CA generated on your PC is appended to
   `Loki\Content\Certificates\cacert.pem`; a byte-exact backup is kept next to it.

Undo both: `powershell -ExecutionPolicy Bypass -File client\launch.ps1 -Uninstall`.
Delete `local-data\` to forget profiles, keys and generated data.

## Known limits

- **Asset names are inferred.** A cosmetic's primary-asset name is stored inside the asset, not in its
  file name. Setup grants every plausible spelling; in testing against one install this matched all
  hunters and roughly 90% of cosmetics. Items it misses simply show as locked.
- **No queue list ships.** Queues come from your install's game-mode table, auto-paired to maps by name,
  and can be edited by hand in `local-data/queues.json`.
- **Matches** have the limits listed in [docs/MATCHES.md](docs/MATCHES.md). Progression, ranked, shop, battle pass and voice are not part of this edition.
- **Feature toggles** the client reads from its config are empty by default; put a JSON object in
  `local-data/feature-toggles.json` to set any.

## Development

```bash
bun run check        # every gate (backend, proxy, setup, PowerShell parse, release-gate self-test, release gate)
bun run check:oss    # just the release gate
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). You may use, study, change, fork and share this for any
noncommercial purpose; contributions are welcome under the same terms. Selling it, or using it to make
money, is not permitted. (This is a source-available licence, not an OSI "open source" one.)
