// First-run setup:  bun run setup -- --game "<SUPERVIVE install root>" [--listing <file|dir>] [--ini <DefaultEngine.ini>]
//
// 1. Checks that the install is SUPERVIVE 2.0.4 (build string inside the game executable).
// 2. Optionally builds the catalog (heroes/cosmetics/maps) from a package listing of YOUR install and
//    the queue list from YOUR install's DefaultEngine.ini, into <data>/generated/.
// Reads only. Never uploads anything, never writes inside the game folder.

import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCatalog, readListing } from "./gen/catalog.ts";
import { readAliases, seedQueues } from "./gen/modes.ts";

export const EXPECTED_BUILD = "release2.4.live-156430-shipping";
const EXE_REL = ["Loki", "Binaries", "Win64", "SUPERVIVE-Win64-Shipping.exe"];

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const DATA = resolve(opt("data") || process.env.REVIVE_DATA_DIR || "./local-data");
const OUT = join(DATA, "generated");

export function findExe(root: string): string | null {
  for (const base of [root, join(root, "SUPERVIVE")]) {
    const p = join(base, ...EXE_REL);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Streams the file looking for the build string as ASCII or UTF-16LE. */
export function fileContains(path: string, needle: string): boolean {
  const pats = [Buffer.from(needle, "latin1"), Buffer.from(needle, "utf16le")];
  const keep = Math.max(...pats.map((p) => p.length));
  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) return false;
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      if (pats.some((p) => buf.includes(p))) return true;
      carry = Buffer.from(buf.subarray(Math.max(0, buf.length - keep)));
    }
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  const game = opt("game");
  if (!game) {
    console.error('usage: bun run setup -- --game "<SUPERVIVE install root>" [--listing <file|dir>] [--ini <DefaultEngine.ini>]');
    process.exit(2);
  }
  const exe = findExe(game);
  if (!exe) { console.error(`✗ ${EXE_REL.join("/")} not found under ${game}`); process.exit(1); }
  process.stdout.write(`… checking build of ${exe} (${(statSync(exe).size / 1048576).toFixed(0)} MB)\n`);
  if (!fileContains(exe, EXPECTED_BUILD)) {
    console.error(`✗ this is not SUPERVIVE 2.0.4 (${EXPECTED_BUILD} not found in the executable). Only 2.0.4 is supported.`);
    process.exit(1);
  }
  console.log(`✓ SUPERVIVE 2.0.4 (${EXPECTED_BUILD})`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "install.json"), JSON.stringify({ gameRoot: resolve(game), exe, build: EXPECTED_BUILD, checkedAt: new Date().toISOString() }, null, 1));

  const listing = opt("listing");
  let catalog = null;
  if (listing) {
    catalog = buildCatalog(readListing(listing), "user listing");
    writeFileSync(join(OUT, "catalog.json"), JSON.stringify(catalog, null, 1));
    console.log(`✓ catalog: ${catalog.heroes.length} hunters, ${catalog.heroCosmetics.length} hunter skins, ${catalog.emotes.length} emotes, ${catalog.titles.length} titles, ${catalog.slotCosmetics.length} other cosmetics, ${catalog.maps.length} maps`);
  } else {
    console.log("• no --listing given: the backend will start with an empty catalog (default loadouts only). See docs/SETUP.md.");
  }
  const ini = opt("ini");
  if (ini) {
    const aliases = readAliases(ini);
    writeFileSync(join(OUT, "modes.json"), JSON.stringify({ aliases }, null, 1));
    console.log(`✓ ${aliases.length} game-mode aliases`);
    const qfile = join(DATA, "queues.json");
    if (catalog && !existsSync(qfile)) {
      const queues = seedQueues(aliases, catalog);
      writeFileSync(qfile, JSON.stringify({ queues }, null, 1));
      console.log(`✓ seeded ${queues.length} queues into ${qfile} (auto-paired alias → map; edit freely)`);
    }
  }
  console.log(`\nDone. Output in ${OUT}. Next: bun start`);
}
