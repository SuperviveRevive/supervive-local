// Runs every gate and prints one summary line each. Exit 1 if any gate fails.
import { join } from "node:path";
const dir = import.meta.dir;
const gates = ["check-setup.ts", "check-backend.ts", "check-proxy.ts", "check-match-hosting.ts", "match/check-ue-protocol.ts", "match/check-ue-server.ts", "match/check-ue-match.ts", "match/check-objectives.ts", "match/check-modes.ts", "match/check-kits.ts", "check-ps.ts", "check-oss-faults.ts"];
let failed = 0;
for (const g of gates) {
  const r = Bun.spawnSync(["bun", join(dir, g)], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString().trim().split("\n");
  console.log(`${r.exitCode === 0 ? "ok  " : "FAIL"} ${out.at(-1)}`);
  if (r.exitCode !== 0) { failed++; console.log(out.filter((l) => l.includes("FAIL")).slice(0, 10).join("\n")); }
}
const oss = Bun.spawnSync(["bun", join(dir, "..", "check-oss.ts")], { stdout: "pipe" });
console.log(`${oss.exitCode === 0 ? "ok  " : "FAIL"} check-oss: ${oss.stdout.toString().trim().split("\n").at(-1)}`);
if (oss.exitCode !== 0) failed++;
process.exit(failed ? 1 : 0);
