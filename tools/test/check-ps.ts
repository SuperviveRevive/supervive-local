// Gate: every PowerShell script parses (pwsh's own parser). Windows-only behaviour is not exercised here.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { T } from "./t.ts";

const t = new T("powershell");
const dir = join(import.meta.dir, "..", "..", "client");
const has = Bun.spawnSync(["sh", "-c", "command -v pwsh"]).exitCode === 0;
if (!has) { console.log("powershell: SKIP (pwsh not installed)"); process.exit(0); }
for (const f of readdirSync(dir).filter((f) => f.endsWith(".ps1"))) {
  const script = `$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile('${join(dir, f)}',[ref]$null,[ref]$e);if($e.Count){$e|%{Write-Output $_.Message};exit 1}`;
  const r = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  t.ok(`${f} parses`, r.exitCode === 0, r.stdout.toString() + r.stderr.toString());
}
t.done();
