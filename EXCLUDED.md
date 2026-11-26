# What was left out, and why

The backend, launcher, proxy and setup were written fresh. The match server in `match/` is our own
clean-room server from the private project, ported with everything below removed: third-party material,
recordings and recorded bytes, private infrastructure, and local packet logging (now off by default). The table lists
what the private project contains that is **not** here. Only server code is published — no game files, recordings or other non-code assets. Rule numbers refer to the export rules:
1 game files · 2 data dumped from the game · 3 retail network captures · 4 third-party work ·
5 protection circumvention · 6 secrets / personal data · 7 private infrastructure / identity ·
8 publisher branding · 9 live-ops / monetisation imitation.

| Left out | Rule | Notes |
|---|---|---|
| Game client folders, extracted files, release zips, all `.pak/.utoc/.ucas/.sig/.exe/.dll`, mod-loader binaries, certificate bundles, the DLL proxy, the retired older client and its runtime workaround | 1, 5 | Users bring their own install. |
| `.usmap` mappings, the generated catalog, package lists, AssetRegistry dumps, class net caches, store offer lists, executable string dumps, config files extracted from paks | 2 | Replaced by `tools/setup.ts` + `tools/gen/`, which read the user's own install into `local-data/`. **Exception (owner's decision, for matches):** the match server's structure tables in `match/data/` — replication layouts and function flags from the executable's reflection data, enum values, spawn locations — ship, each pinned by hash in `tools/match-tables.json`. |
| AccelByte SDK response-shape catalogues and endpoint lists used by the old coverage/shape gates, and those gates | 2, 4 | The AccelByte Unreal SDK is under a proprietary licence that limits use to games on AccelByte's platform; nothing derived from it is used here. New gates test our own behaviour instead. |
| The retail capture files themselves (pcapng, saz, decoded flow dumps), every `retail-*` decoder, every capture fixture used by the old gates, the recorded world replay (`retail-world-*`), and recorded byte blobs inside the match code (Airdoo attribute/icon blocks) | 3 | **Owner's decision:** the match server may be *built from* what the captures showed — decoded rules, field orders, timings, a FireFox ability spec list — but no recording ships. Test vectors that were raw recorded packets (the old drop gate) were removed with them. The backend uses neutral values; feature toggles are empty unless the host sets them. |
| The third-party checkpoint folder itself, the UE host built from it, its code and its test fixtures | 4 | Not shipped as files. **Owner's decision:** facts and tables from it that the match server needs — hunter ability kits, the ability-to-montage map, per-hunter health/movement stats, instance policy, Breach terrain triangles and floor-verified spawns — are included as server code in `match/` and `match/tables/`. |
| Client memory-inspection and pattern-scan scripts, the logging-command patcher, the mod-loader injector, AES keys and key-search output | 5 | The game runs unmodified. The Lua mods (auto-login, match host, chat bridge) are also out: their loader does not run on this build without defeating its protection. |
| State and secrets: admin key, Discord bot credentials, JWT signing key, account stores, backend state, active-player and dedicated-server records, install manifest, uploads, match recordings | 6 | Every install generates its own key and state in `local-data/`. |
| The Discord social integration | 6, 7 | Needed a private bot token and application; not part of this edition. |
| The private identity service and its launcher daemon, launch-relay scripts, laptop paths, private hostnames and IPs, tunnel and hosting-provider services, the remote status page, test accounts | 7 | Replaced by local profiles (`/revive/login`) and `client/launch.ps1`. |
| Branding folder, logos, screenshots | 8 | Plain-text product names only, for compatibility. |
| Storefront, wallets and prices, orders, promo codes, battle pass, missions, armory, mailbox rewards, ranked/MMR | 9 | Everything in the user's own catalog is unlocked; no shop. |
| Old investigation notes and hand-off docs | 7, 3 | Rewritten as `docs/` without infrastructure details or capture-derived facts. |

## Things I was unsure about (kept out, or kept with a note)

- **Interop identifiers in code** — service hostnames the game connects to, JSON field names it reads,
  match state names, the Messenger and Lobby framing. These are needed to interoperate at all and are
  observable from any copy of the game; they are kept, written fresh. Whether that is acceptable is a
  judgement for the publisher of this repository, not a settled fact.
- **Asset-name spelling rules** in `tools/gen/catalog.ts` were tuned by comparing against a catalog from
  one install. The rules are in the code; the comparison data is not.
- **The 2.0.4 build string** is used by setup to refuse other builds.
