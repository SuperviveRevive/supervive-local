// Gate: the TLS redirect proxy against a live backend — CONNECT interception of the game's service
// hostnames, the direct TLS endpoint, WebSocket upgrade through both, passthrough of other hosts, and
// that the leaf certificate chains to the per-install CA.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T } from "./t.ts";

const t = new T("proxy");
const ROOT = join(import.meta.dir, "..", "..");
const d = mkdtempSync(join(tmpdir(), "revive-px-"));
const BP = 25991, PP = 25992, TP = 25993;
const procs: { kill(): void }[] = [];
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
try {
  procs.push(Bun.spawn(["bun", join(ROOT, "server/main.ts")], { env: { ...process.env, REVIVE_PORT: String(BP), REVIVE_DATA_DIR: d }, stdout: "ignore", stderr: "ignore" }));
  procs.push(Bun.spawn(["bun", join(ROOT, "client/proxy.mjs"), "serve", "--backend", `http://127.0.0.1:${BP}`, "--port", String(PP), "--tls-port", String(TP), "--data", d], { stdout: "ignore", stderr: "ignore" }));
  for (let i = 0; i < 60; i++) { if (sh(["curl", "-s", "-o", "/dev/null", `http://127.0.0.1:${BP}/revive/health`]).code === 0 && sh(["sh", "-c", `exec 3<>/dev/tcp/127.0.0.1/${TP}`]).code === 0) break; await Bun.sleep(150); }
  const ca = join(d, "certs", "ca.pem");
  t.ok("leaf chains to the per-install CA", sh(["openssl", "verify", "-CAfile", ca, join(d, "certs", "leaf.pem")]).out.includes("OK"));

  const viaProxy = sh(["curl", "-s", "--cacert", ca, "-x", `http://127.0.0.1:${PP}`, "https://login.projectloki.theorycraftgames.com/revive/health"]);
  t.ok("CONNECT to a game service hostname is intercepted and reaches the backend", viaProxy.out.includes('"ok":true'), viaProxy.err);
  const ab = sh(["curl", "-s", "--cacert", ca, "-x", `http://127.0.0.1:${PP}`, "https://demo.accelbyte.io/iam/v3/oauth/jwks"]);
  t.ok("*.accelbyte.io is intercepted", ab.out.includes("RS256"), ab.err);
  const direct = sh(["curl", "-s", "--cacert", ca, `https://127.0.0.1:${TP}/revive/health`]);
  t.ok("direct TLS endpoint on 127.0.0.1 is trusted by the same CA", direct.out.includes('"ok":true'), direct.err);
  const dns = sh(["curl", "-s", "--cacert", ca, `https://localhost:${TP}/revive/health`]);
  t.ok("direct TLS endpoint is trusted by DNS name (libwebsockets checks SANs, not IP SANs)", dns.out.includes('"ok":true'), dns.err);
  const viaProxyDirect = sh(["curl", "-s", "--cacert", ca, "-x", `http://127.0.0.1:${PP}`, `https://127.0.0.1:${TP}/revive/health`]);
  t.ok("CONNECT to the direct endpoint passes through", viaProxyDirect.out.includes('"ok":true'), viaProxyDirect.err);
  const untrusted = sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `https://127.0.0.1:${TP}/revive/health`]);
  t.ok("without the CA the certificate is rejected (no blanket trust)", untrusted.code !== 0);

  // a websocket through the direct TLS endpoint, authenticated with a locally issued token
  const login = await fetch(`http://127.0.0.1:${BP}/revive/login`, { method: "POST", body: JSON.stringify({ displayName: "Proxy Test" }) }).then((r) => r.json());
  const tok = await fetch(`http://127.0.0.1:${BP}/iam/v3/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=authorization_code&code=${login.authCode}` }).then((r) => r.json());
  process.env.NODE_EXTRA_CA_CERTS = ca;
  const ws = new WebSocket(`wss://127.0.0.1:${TP}/lobby`, { headers: { authorization: `Bearer ${tok.access_token}` }, tls: { ca: await Bun.file(ca).text() } } as any);
  const first = await new Promise<string>((res) => { ws.onmessage = (e) => res(String(e.data)); ws.onerror = () => res("error"); setTimeout(() => res("timeout"), 4000); });
  t.ok("lobby websocket works through the TLS endpoint", first.startsWith("type: connectNotif"), first);
  ws.close();
  const dnsWs = new WebSocket(`wss://localhost:${TP}/lobby`, { headers: { authorization: `Bearer ${tok.access_token}` }, tls: { ca: await Bun.file(ca).text() } } as any);
  const dnsFirst = await new Promise<string>((res) => { dnsWs.onmessage = (e) => res(String(e.data)); dnsWs.onerror = () => res("error"); setTimeout(() => res("timeout"), 4000); });
  t.ok("lobby websocket connects via localhost (Messenger's wss:// URL)", dnsFirst.startsWith("type: connectNotif"), dnsFirst);
  dnsWs.close();
  const bad = sh(["curl", "-s", "--cacert", ca, `https://127.0.0.1:${TP}/nonexistent/thing`]);
  t.ok("unknown paths still answer (empty success)", bad.code === 0);
} catch (e) {
  t.ok("gate crashed", false, String(e));
} finally {
  for (const p of procs) p.kill();
  rmSync(d, { recursive: true, force: true });
}
t.done();
