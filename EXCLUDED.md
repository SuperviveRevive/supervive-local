# What was left out, and why

This repository was written fresh. Nothing was bulk-copied from the private project it replaces; the
only things carried over are ideas and a few small pieces of our own code (the certificate writer in
`client/proxy.mjs`, the catalog path rules in `tools/gen/catalog.ts`), each rewritten. The table lists
what the private project contains that is **not** here. Rule numbers refer to the export rules:
1 game files · 2 data dumped from the game · 3 retail network captures · 4 third-party work ·
5 protection circumvention · 6 secrets / personal data · 7 private infrastructure / identity ·
8 publisher branding · 9 live-ops / monetisation imitation.

| Left out | Rule | Notes |
|---|---|---|
| Game client folders, extracted files, release zips, all `.pak/.utoc/.ucas/.sig/.exe/.dll`, mod-loader binaries, certificate bundles, the DLL proxy, the retired older client and its runtime workaround | 1, 5 | Users bring their own install. |
| `.usmap` mappings, the generated catalog, package lists, AssetRegistry dumps, enum/layout/function-flag dumps, spawn/floor/zone/loot/ability/montage fixtures, store offer lists, executable string dumps, config files extracted from paks | 2 | Replaced by `tools/setup.ts` + `tools/gen/`, which read the user's own install into `local-data/`. |
| AccelByte SDK response-shape catalogues and endpoint lists used by the old coverage/shape gates, and those gates | 2, 4 | The AccelByte Unreal SDK is under a proprietary licence that limits use to games on AccelByte's platform; nothing derived from it is used here. New gates test our own behaviour instead. |
| The retail capture folder, every `retail-*` tool, the retail-value module and every value in the old backend that cited it (queue priorities, ranked windows, toggle sets, patch versions, game-mode templates, inventory validations, status codes taken from it) | 3 | The new backend uses neutral values; feature toggles are empty unless the host sets them. |
| The third-party checkpoint folder, the UE host built from it, the clean-room match server (its tables came from captures and that checkpoint), and lobby notes attributed to third-party reverse engineering | 3, 4 | Matches run only on the host's own copy of the game (see `docs/LISTEN-SERVER.md`). |
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
