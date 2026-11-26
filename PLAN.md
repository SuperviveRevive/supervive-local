# Plan (2026-11-26) — status: initial version built

Scope: a from-scratch Local Edition that lets owners of SUPERVIVE 2.0.4 play on their own PC or LAN,
hosted by one player, with no central server, no game files, and the game left unmodified.

Approach: **rewrite, not export.** The private project's backend had absorbed values from retail
captures, a third party's work and a proprietary SDK, so instead of copying and stripping, every file
here was written new; see `EXCLUDED.md` for what stayed behind.

| Step | State |
|---|---|
| Release gate `tools/check-oss.ts` + fault-injection self-test | done, green |
| TLS proxy with per-install CA, consented trust install, byte-exact uninstall | done, tested |
| Setup: 2.0.4 check, catalog + queue generators from the user's own install | done, tested on synthetic input |
| Backend: local login, IAM, lobby/messenger WS, friends, parties, queues, bot fill, Hero Select | done, tested end to end |
| Match server (`match/`, from our clean-room server minus third-party and recorded material) | ported; allocation e2e + protocol/match gates green; **not yet run against the real client** |
| Game's own server mode (Agones SDK stand-in) | alternative, experimental |
| Windows launcher / host scripts | written, syntax-checked; not run on Windows |
| Licence | PolyForm Noncommercial 1.0.0 (`LICENSE.md`) |

Next: run a real 2.0.4 client against this build (lobby → queue → match), measure kits for more hunters,
and fill the calls listed in `local-data/logs/unknown.jsonl`.
