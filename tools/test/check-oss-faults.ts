// Gate on the gate: copy the repo to a temp dir, plant one violation of every kind check-oss must
// catch, and require that each one is reported — then remove them and require a clean pass.
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { T } from "./t.ts";

const t = new T("check-oss faults");
const ROOT = join(import.meta.dir, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "revive-oss-"));
const repo = join(tmp, "repo");
cpSync(ROOT, repo, { recursive: true, filter: (s) => !/[/\\](\.git|local-data|node_modules)([/\\]|$)/.test(s) });

const run = () => {
  const r = Bun.spawnSync(["bun", join(repo, "tools/check-oss.ts"), repo, "--all"], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() };
};
const j = (...p: string[]) => p.join("");

const clean = run();
t.ok("clean copy passes", clean.code === 0, clean.out.slice(-400));

// [rule label printed by check-oss, file to plant, content]
const plants: [string, string, string | Buffer][] = [
  ["forbidden extension", "client/Paks/pakchunk0.pak", "not really a pak"],
  ["forbidden extension", "tools/game.usmap", "x"],
  ["file over 5 MB", "docs/huge.md", "a ".repeat(3 * 1024 * 1024)],
  ["infrastructure/identity string", "docs/host.md", `backend at loki.${j("fail", "ure")}.fail\n`],
  ["infrastructure/identity string", "server/ip.ts", `const h = "${j("82.22", ".77.", "96")}";\n`],
  ["infrastructure/identity string", "client/path.ps1", `$p = '${j("D:", "\\Games\\", "SUPERVIVE")}'\n`],
  ["infrastructure/identity string", "docs/peer.md", `seen from ${j("134.82", ".69.69")}:5475\n`],
  ["infrastructure/identity string", "docs/who.md", `pilot ${j("zan", "dylive")}\n`],
  ["secret-shaped string", "server/jwt.txt", `${j("ey", "JhbGciOiJSUzI1NiJ9")}.${j("ey", "JzdWIiOiIxMjM0NTY3ODkwIn0")}.c2lnbmF0dXJlLXZhbHVlLWhlcmU\n`],
  ["secret-shaped string", "server/key.md", `${j("-----BEGIN ", "PRIVATE KEY-----")}\nabc\n`],
  ["secret-shaped string", "server/openai.ts", `const k = "${j("sk-", "abcdefghijklmnopqrstuvwxyz123456")}";\n`],
  ["secret-shaped string", "server/discord.ts", `const t = "${j("MTA", "xMjM0NTY3ODkwMTIzNDU2Nzg5", ".GaBcDe.", "abcdefghijklmnopqrstuvwxyz0123456789AB")}";\n`],
  ["secret-shaped string", "docs/blob.md", Buffer.from(randomBytes(3000)).toString("base64") + "\n"],
  ["secret-shaped string", "server/aes.ts", `const aes = "0x${randomBytes(32).toString("hex").toUpperCase()}";\n`],
  ["protection-circumvention reference", "client/tool.ps1", `# run ${j("mem", "xref")} first\n`],
  ["protection-circumvention reference", "docs/note.md", `uses a ${j("signa", "ture bypass")}\n`],
  ["forbidden directory", "ref/retail-capture/notes.md", "x\n"],
  ["forbidden directory", "client/extracted/readme.md", "x\n"],
  ["forbidden file name", ".env", "REVIVE_PORT=1\n"],
  ["forbidden file name", "server/jwt-key.json", "{}\n"],
  ["generated/dumped game data", "server/dump.json", JSON.stringify(Array.from({ length: 40 }, (_, i) => `/Game/Loki/Maps/M${i}/LVL_M${i}`))],
  ["forbidden directory", "local-data/generated/catalog.json", "{}\n"],
  ["binary file", "docs/blob.dat", Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02])],
  ["unlisted match table", "match/data/retail-world-breach.json", "{}\n"],
];

for (const [rule, file, content] of plants) {
  const abs = join(repo, file);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  const r = run();
  const caught = r.code === 1 && r.out.includes(`FAIL ${rule}`) && r.out.includes(file.split("/").pop()!);
  t.ok(`catches ${rule}: ${file}`, caught, r.out.slice(-600));
  unlinkSync(abs);
}

// a pinned table that changes must be caught too
{
  const f = join(repo, "match/data/match-config.json");
  const orig = require("node:fs").readFileSync(f);
  writeFileSync(f, Buffer.concat([orig, Buffer.from(" ")]));
  const r = run();
  t.ok("catches a changed pinned match table", r.code === 1 && r.out.includes("FAIL match table changed"), r.out.slice(-400));
  writeFileSync(f, orig);
}

const after = run();
t.ok("clean again after removing every plant", after.code === 0, after.out.slice(-400));
rmSync(tmp, { recursive: true, force: true });
t.done();
