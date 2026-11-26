// Release gate for the open-source Local Edition.
//
//   bun tools/check-oss.ts [dir] [--all]
//
// Scans every file that would be published and fails (exit 1) on anything that must never ship:
// game files, data dumped from the game, secrets, private infrastructure/identity strings,
// protection-circumvention tooling, oversized files, and generated data committed by mistake.
// In a git checkout it scans tracked + untracked-but-not-ignored files (what `git add -A` would take);
// outside git, or with --all, it scans everything except .git/.
//
// The patterns below are assembled from fragments so that this file does not itself contain the
// strings it forbids (it is scanned like every other file).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const j = (...p: string[]) => p.join("");
const argv = process.argv.slice(2);
const ROOT = resolve(argv.find((a) => !a.startsWith("--")) || join(import.meta.dir, ".."));
const ALL = argv.includes("--all");
const MAX_BYTES = 5 * 1024 * 1024;

type Finding = { rule: string; file: string; detail: string };
const findings: Finding[] = [];
const add = (rule: string, file: string, detail: string) => findings.push({ rule, file, detail });

// ---- 1. what to scan ---------------------------------------------------------------------------
function listFiles(): string[] {
  if (!ALL && existsSync(join(ROOT, ".git"))) {
    const r = spawnSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.split("\0").filter(Boolean).filter((f) => existsSync(join(ROOT, f)));
  }
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(ROOT, p));
    }
  };
  walk(ROOT);
  return out;
}

// ---- 2. rules ------------------------------------------------------------------------------------
const FORBIDDEN_EXT = new Set([
  ".pak", ".utoc", ".ucas", ".sig", ".usmap", ".uasset", ".umap", ".uexp", ".ubulk",
  ".exe", ".dll", ".pdb", ".so", ".dylib", ".sys", ".bin",
  ".zip", ".7z", ".rar", ".tar", ".gz",
  ".pem", ".key", ".crt", ".cer", ".p12", ".pfx", ".jks",
  ".saz", ".har", ".pcap", ".pcapng",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tga", ".dds", ".mp4", ".mkv", ".wav", ".ogg",
]);
const FORBIDDEN_NAMES = new Set([".env", "cacert.pem", "jwt-key.json", "accounts.json", "profiles.json", ".admin-key", ".discord.json", "state.json"]);
const FORBIDDEN_DIRS = new Set([
  "local-data", "generated", "node_modules", "client-204", "extracted", "release", "captures", "ref", "uehost",
  j("retail", "-capture"), j("friend", "-checkpoint"), "paks", "Binaries", "Content", "ue4ss", "UE4SS", "Mods",
]);

const INFRA: [string, RegExp][] = [
  ["private host", new RegExp(j("fail", "ure", "\\.", "fail"), "i")],
  ["private host", new RegExp(j("zo", "\\.", "space"), "i")],
  ["private host", new RegExp(j("zo", "\\.", "computer"), "i")],
  ["private host", new RegExp(j("zo", "computer"), "i")],
  ["private host", new RegExp(j("zo", "\\.", "pub"), "i")],
  ["private IP", new RegExp(j("\\b82\\.22\\.77", "\\."))],
  ["private IP", new RegExp(j("\\b147\\.79", "\\."))],
  ["private IP", new RegExp(j("\\b95\\.216", "\\."))],
  ["identity", new RegExp(j("zan", "dy"), "i")],
  ["identity", new RegExp(j("zap", "m1"), "i")],
  ["identity", new RegExp(j("zap", "gaming"), "i")],
  ["identity", new RegExp(j("2a15c833", "94744c1d"), "i")],
  ["private path", new RegExp(j("D:", "\\\\\\\\?", "Games"), "i")],
  ["private path", new RegExp(j("/home/", "workspace"))],
  ["private path", new RegExp(j("/home/", "\\.z/"))],
  ["private infra", new RegExp(j("ping", "gy"), "i")],
  ["private infra", new RegExp(j("very", "cloud"), "i")],
  ["private infra", new RegExp(j("play", "it\\.gg"), "i")],
  ["private infra", new RegExp(j("loki-", "(backend|tunnel)"))],
  ["private infra", new RegExp(j("supervive", "-ue\\b"))],
  ["private infra", new RegExp(j("supervisor", "ctl"))],
  ["public IPv4 literal", /(?<!oid\(")(?!2\.5\.)(?!1\.2\.840\.)(?!1\.3\.6\.1\.)(?<![\w.])(?!(?:10|127|0)\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!169\.254\.)(?!255\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d+)?(?![\w.])/],
];

const SECRETS: [string, RegExp][] = [
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["private key", new RegExp(j("-----BEGIN ", "(RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"))],
  ["certificate", new RegExp(j("-----BEGIN ", "CERTIFICATE-----"))],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Discord token", /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/],
  ["base64 blob > 2 KB", /[A-Za-z0-9+/]{2048,}={0,2}/],
  ["64-hex (AES-key-shaped)", /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/],
  ["32-hex id literal", /(?<![0-9a-fA-F-])[0-9a-f]{32}(?![0-9a-fA-F-])/],
];

const CIRCUMVENTION = new RegExp(j("mem", "xref|mem", "probe|pak", "_key|sig ", "bypass|signa", "ture bypass"), "i");
const GAME_PATH = /\/Game\/[A-Za-z0-9_]+\/[A-Za-z0-9_/.]+/g;
const MAX_GAME_PATHS = 25;

// Pinned match-server tables: allowed only as listed, byte-for-byte.
const PINNED: Record<string, { sha256: string }> = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, "tools", "match-tables.json"), "utf8")).tables || {}; } catch { return {}; }
})();

// ---- 3. scan -------------------------------------------------------------------------------------
const files = listFiles();
let bytes = 0;
for (const rel of files) {
  const abs = join(ROOT, rel);
  const parts = rel.split(sep).join("/").split("/");
  const name = parts[parts.length - 1];
  const st = statSync(abs);
  bytes += st.size;

  for (const d of parts.slice(0, -1)) if (FORBIDDEN_DIRS.has(d)) add("forbidden directory", rel, `under '${d}/'`);
  const ext = extname(name).toLowerCase();
  if (FORBIDDEN_EXT.has(ext)) add("forbidden extension", rel, ext);
  if (FORBIDDEN_NAMES.has(name) || /^\.env(\.(?!example$).+)?$/.test(name)) add("forbidden file name", rel, name);
  if (st.size > MAX_BYTES) add("file over 5 MB", rel, `${(st.size / 1048576).toFixed(1)} MB`);

  const buf = readFileSync(abs);
  if (buf.includes(0)) { add("binary file", rel, "contains NUL bytes"); continue; }
  const posix = parts.join("/");
  let pinned = false;
  if (posix.startsWith("match/data/")) {
    const want = PINNED[name]?.sha256;
    const got = createHash("sha256").update(buf).digest("hex");
    if (!want) add("unlisted match table", rel, "not in tools/match-tables.json");
    else if (want !== got) add("match table changed", rel, `sha256 ${got.slice(0, 16)}… ≠ pinned ${want.slice(0, 16)}…`);
    else pinned = true;
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");

  const scan = (rule: string, label: string, re: RegExp) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) { add(rule, `${rel}:${i + 1}`, `${label}: ${m[0].slice(0, 48)}${m[0].length > 48 ? "…" : ""}`); return; }
    }
  };
  for (const [label, re] of INFRA) scan("infrastructure/identity string", label, re);
  if (posix !== "tools/match-tables.json") for (const [label, re] of SECRETS) scan("secret-shaped string", label, re);
  scan("protection-circumvention reference", "keyword", CIRCUMVENTION);

  if (pinned) continue;
  const gamePaths = new Set(text.match(GAME_PATH) || []);
  if (gamePaths.size > MAX_GAME_PATHS) add("generated/dumped game data", rel, `${gamePaths.size} distinct /Game/ asset paths (limit ${MAX_GAME_PATHS})`);
  if (/\.json$/i.test(name) && st.size > 256 * 1024) add("generated/dumped game data", rel, "JSON file over 256 KB");
}

// ---- 4. report -----------------------------------------------------------------------------------
const byRule = new Map<string, Finding[]>();
for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) || []), f]);
console.log(`check-oss: scanned ${files.length} files (${(bytes / 1024).toFixed(1)} KB) in ${ROOT}${ALL ? " [--all]" : ""}`);
if (!findings.length) {
  console.log("PASS — no forbidden content found");
  process.exit(0);
}
for (const [rule, fs] of byRule) {
  console.log(`\nFAIL ${rule} (${fs.length})`);
  for (const f of fs.slice(0, 50)) console.log(`  ${f.file}  —  ${f.detail}`);
  if (fs.length > 50) console.log(`  … ${fs.length - 50} more`);
}
console.log(`\n${findings.length} finding(s) in ${byRule.size} rule(s). Not releasable.`);
process.exit(1);
