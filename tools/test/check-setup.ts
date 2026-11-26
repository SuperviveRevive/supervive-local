// Gate: setup's version check and generators, against a synthetic fake install (no game files used).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildCatalog, normalise } from "../gen/catalog.ts";
import { readAliases, seedQueues } from "../gen/modes.ts";
import { T } from "./t.ts";

const t = new T("setup");
const root = mkdtempSync(join(tmpdir(), "revive-setup-"));
const game = join(root, "game");
const data = join(root, "data");
const exeDir = join(game, "Loki", "Binaries", "Win64");
mkdirSync(exeDir, { recursive: true });
const exe = join(exeDir, "SUPERVIVE-Win64-Shipping.exe");
// The build string straddles the 8 MB read-chunk boundary on purpose.
writeFileSync(exe, Buffer.concat([randomBytes(8 * 1024 * 1024 - 20), Buffer.from("release2.4.live-156430-shipping", "utf16le"), randomBytes(512)]));

const listing = join(root, "listing.txt");
writeFileSync(listing, [
  "Loki/Content/Loki/Characters/Heroes/Alpha/BP_HeroAsset_Alpha.uasset",
  "SUPERVIVE/Loki/Content/Loki/Characters/Heroes/Alpha/Skins/DA_Alpha_Default_CosmeticsBundle.uasset",
  "/Game/Loki/Maps/Islands/LVL_Islands.umap",
  "Loki/Content/Loki/Maps/Islands/_Generated_/LVL_Islands_Cell.umap",
  "Loki/Content/Loki/Maps/TestArena/LVL_TestArena.umap",
  "Engine/Content/Whatever.uasset",
].join("\n"));
const ini = join(root, "DefaultEngine.ini");
writeFileSync(ini, '[x]\n+GameModeClassAliases=(Name="IslandsBRGameMode",GameMode="/Script/X.A")\n+GameModeClassAliases=(Name="NowhereGameMode",GameMode="/Script/X.B")\n');

const run = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "setup.ts"), ...a, "--data", data], { stdout: "pipe", stderr: "pipe" });

let r = run("--game", game, "--listing", listing, "--ini", ini);
t.ok("accepts a 2.0.4 build (UTF-16 string across chunk boundary)", r.exitCode === 0, r.stderr.toString());
t.ok("writes install.json", existsSync(join(data, "generated", "install.json")));
const cat = JSON.parse(readFileSync(join(data, "generated", "catalog.json"), "utf8"));
t.eq("catalog hunters", cat.heroes.length, 1);
t.eq("catalog hunter skins", cat.heroCosmetics.length, 1);
t.eq("catalog maps (generated cells skipped)", cat.maps.length, 2);
t.eq("map package path", cat.maps.find((m: any) => m.name === "LVL_Islands")?.path, "/Game/Loki/Maps/Islands/LVL_Islands");
const q = JSON.parse(readFileSync(join(data, "queues.json"), "utf8")).queues;
t.eq("seeded queues (unpairable alias dropped)", q.length, 1);
t.eq("queue paired to map", q[0]?.map, "/Game/Loki/Maps/Islands/LVL_Islands");

writeFileSync(exe, randomBytes(1024 * 1024));
r = run("--game", game);
t.ok("rejects a non-2.0.4 executable", r.exitCode === 1 && /not SUPERVIVE 2\.0\.4/.test(r.stderr.toString()));
r = run("--game", join(root, "nope"));
t.ok("rejects a folder without the game", r.exitCode === 1);
r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "setup.ts")], { stdout: "pipe", stderr: "pipe" });
t.eq("usage error without --game", r.exitCode, 2);

t.eq("normalise /Game form", normalise("/Game/Loki/X.uasset"), "Loki/Content/Loki/X.uasset");
t.eq("normalise foreign path", normalise("Engine/Content/X.uasset"), null);
t.eq("aliases parsed", readAliases(ini).length, 2);
t.eq("no catalog → no queues", seedQueues(readAliases(ini), buildCatalog([], "x")).length, 0);

rmSync(root, { recursive: true, force: true });
t.done();
