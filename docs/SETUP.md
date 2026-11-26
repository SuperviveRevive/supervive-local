# Setup

`bun run setup -- --game "<install root>" [--listing <file|dir>] [--ini <DefaultEngine.ini>] [--data <dir>]`

Everything setup produces goes to `local-data/` (or `--data`), which is git-ignored. Setup only reads.

## 1. Version check (`--game`)

Setup finds `Loki/Binaries/Win64/SUPERVIVE-Win64-Shipping.exe` under the folder you give it (or under
`<folder>/SUPERVIVE`) and looks for the build string `release2.4.live-156430-shipping` inside it. Any
other build is refused. The result is written to `local-data/generated/install.json` so the launcher can
find the game without `-Game`.

## 2. Catalog (`--listing`)

The catalog is the list of hunters, hunter skins, emotes, titles, slot cosmetics, lobby platforms and
maps. It drives "everything unlocked", default skins and the map choices for queues.

Give setup either:

- a **text file**, one packaged path per line, e.g. `Loki/Content/Loki/Maps/Foo/LVL_Foo.umap` (paths
  starting with `/Game/...` or with your install folder in front are accepted too), or
- a **folder** you exported from your install; its file names are walked.

Produce it with any Unreal asset browser you trust, from your own install. Setup never reads pak
contents itself.

Primary-asset names live inside the assets, so setup records several spellings for each asset and the
backend grants all of them. Hunters match reliably; a minority of cosmetics may not.

## 3. Queues (`--ini`)

Export your install's `Loki/Config/DefaultEngine.ini` and pass it with `--ini`. Setup reads the
`GameModeClassAliases` table and, if a catalog exists and `local-data/queues.json` does not, writes a
starting queue list by pairing each alias with the map whose name shares its longest word.

`local-data/queues.json` is yours to edit:

```json
{ "queues": [
  { "id": "my-arena", "name": "Arena", "alias": "<GameModeClassAlias name>", "map": "/Game/.../LVL_Something",
    "teamSize": 4, "teams": 2, "maxPartySize": 4, "botFill": true }
] }
```

`alias` is passed to the match server as the game mode and `map` as the level. The backend re-reads the
file when it changes.
