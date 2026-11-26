# Contributing

## Licence of contributions

By contributing you agree your contribution is licensed under the repository licence (PolyForm
Noncommercial 1.0.0, `LICENSE.md`).

## Rules that keep this project publishable

1. **No game files, ever** — no executables, DLLs, paks, `.usmap`, extracted assets, screenshots or audio.
2. **No data dumped from the game** checked in, except the pinned match-server structure tables in
   `match/data/` (`tools/match-tables.json`). Anything else that needs game data gets a generator that reads
   the user's own install during setup and writes into `local-data/`.
3. **No network captures** of the original live service in the repository — no capture files, packet
   dumps or replayed recorded bytes. Rules and values *learned* from recordings are fine in code.
4. **No code or data from third parties without permission** (a licence or the owner's explicit say-so).
5. **Nothing that bypasses or weakens protection** — signing, encryption, anti-tamper, memory reading.
   The game must run unmodified.
6. **No secrets, personal data, private hostnames or IPs.**

`bun tools/check-oss.ts` enforces what it can (extensions, sizes, secret shapes, private strings,
forbidden directories, dumped data). Run `bun run check` before every pull request; all gates must pass.

## Reporting what the game does

The most useful contribution is evidence: the request the client made, what it expected, what happened.
`local-data/logs/unknown.jsonl` lists every call the backend did not implement. Share method + path,
and describe the response shape the client needed — not dumps of game files.

## Code style

TypeScript on Bun, no runtime dependencies. Keep handlers small, match field names exactly, accept
PascalCase and camelCase request bodies (`pick()` in `server/lib/http.ts`).
