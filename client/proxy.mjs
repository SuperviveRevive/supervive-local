// SUPERVIVE Revive — Local Edition: TLS redirect proxy.
//
// The game is started with `-httpproxy=127.0.0.1:<port>`. For the handful of hostnames the client
// expects its online services on, this proxy terminates TLS with a certificate issued by a CA that is
// generated on this machine on first run, and forwards the decrypted HTTP/WebSocket traffic to the
// local backend (or a LAN host's backend). Every other host is tunnelled untouched.
//
// Commands (run with `bun` or `node`):
//   proxy.mjs serve   [--backend http://127.0.0.1:24970] [--port 24972] [--tls-port 24973] [--data <dir>]
//   proxy.mjs trust   --game "<SUPERVIVE install root>" [--yes] [--data <dir>]
//   proxy.mjs untrust --game "<SUPERVIVE install root>"
//   proxy.mjs status  --game "<SUPERVIVE install root>" [--data <dir>]
//
// `trust` appends the local CA to the game's own trust bundle after an explicit confirmation and keeps
// a byte-exact backup; `untrust` restores that backup. Nothing else in the install is touched.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const INTERCEPT_SUFFIXES = [".theorycraftgames.com", ".accelbyte.io"];
const TRUST_MARKER_BEGIN = "# >>> supervive-revive-local CA (remove with: proxy.mjs untrust) >>>";
const TRUST_MARKER_END = "# <<< supervive-revive-local CA <<<";
const TRUST_REL = path.join("Loki", "Content", "Certificates", "cacert.pem");
const BACKUP_SUFFIX = ".revive-local-backup";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const A = args(process.argv.slice(2));
const DATA_DIR = path.resolve(String(A.data || process.env.REVIVE_DATA_DIR || path.join(REPO, "local-data")));
const CERT_DIR = path.join(DATA_DIR, "certs");
const LOG_FILE = path.join(DATA_DIR, "logs", "proxy.log");

function log(msg) {
  const line = `${new Date().toISOString()} [proxy] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ---------------------------------------------------------------------------------------------
// Minimal X.509 v3 writer (DER). Enough for one self-signed CA and one server leaf.

const der = {
  len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const b = [];
    for (let v = n; v > 0; v >>= 8) b.unshift(v & 0xff);
    return Buffer.from([0x80 | b.length, ...b]);
  },
  tlv(tag, body) { return Buffer.concat([Buffer.from([tag]), der.len(body.length), body]); },
  seq(...xs) { return der.tlv(0x30, Buffer.concat(xs)); },
  set(...xs) { return der.tlv(0x31, Buffer.concat(xs)); },
  int(buf) {
    let b = Buffer.from(buf);
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return der.tlv(0x02, b);
  },
  bool(v) { return der.tlv(0x01, Buffer.from([v ? 0xff : 0])); },
  bits(buf) { return der.tlv(0x03, Buffer.concat([Buffer.from([0]), buf])); },
  octets(buf) { return der.tlv(0x04, buf); },
  nul() { return Buffer.from([0x05, 0x00]); },
  oid(s) {
    const p = s.split(".").map(Number);
    const out = [p[0] * 40 + p[1]];
    for (const n of p.slice(2)) {
      const enc = [n & 0x7f];
      for (let v = n >> 7; v > 0; v >>= 7) enc.unshift((v & 0x7f) | 0x80);
      out.push(...enc);
    }
    return der.tlv(0x06, Buffer.from(out));
  },
  utf8(s) { return der.tlv(0x0c, Buffer.from(s, "utf8")); },
  time(d) {
    const z = (n) => String(n).padStart(2, "0");
    const s = `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
    return der.tlv(0x18, Buffer.from(s, "ascii"));
  },
  name(cn) { return der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(cn)))); },
  ext(oid, value, critical) {
    return der.seq(der.oid(oid), ...(critical ? [der.bool(true)] : []), der.octets(value));
  },
};

function pem(label, buf) {
  return `-----BEGIN ${label}-----\n${buf.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
}

function issue({ subject, issuer, spki, signKey, ca, dnsNames = [], ipNames = [], days }) {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const alg = der.seq(der.oid("1.2.840.113549.1.1.11"), der.nul());
  const exts = ca
    ? [
        der.ext("2.5.29.19", der.seq(der.bool(true)), true),
        der.ext("2.5.29.15", der.bits(Buffer.from([0x06])), true),
      ]
    : [
        der.ext("2.5.29.19", der.seq(), true),
        der.ext("2.5.29.15", der.bits(Buffer.from([0xa0])), true),
        der.ext("2.5.29.37", der.seq(der.oid("1.3.6.1.5.5.7.3.1")), false),
        der.ext("2.5.29.17", der.seq(
          ...dnsNames.map((d) => der.tlv(0x82, Buffer.from(d, "ascii"))),
          ...ipNames.map((ip) => der.tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
        ), false),
      ];
  const tbs = der.seq(
    der.tlv(0xa0, der.int(Buffer.from([2]))),
    der.int(serial),
    alg,
    der.name(issuer),
    der.seq(der.time(new Date(Date.now() - 86400e3)), der.time(new Date(Date.now() + days * 86400e3))),
    der.name(subject),
    spki,
    der.tlv(0xa3, der.seq(...exts)),
  );
  return pem("CERTIFICATE", der.seq(tbs, alg, der.bits(crypto.sign("sha256", tbs, signKey))));
}

// A wildcard matches one label only, so the deeper service hostnames get their own entries.
const LEAF_NAMES = [
  "*.theorycraftgames.com",
  "*.projectloki.theorycraftgames.com",
  "*.prodcluster.awsinfra.theorycraftgames.com",
  "*.accelbyte.io",
  "localhost",
];
const LEAF_IPS = ["127.0.0.1"];

function loadOrCreateCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  const f = (n) => path.join(CERT_DIR, n);
  let caKey, caPem;
  if (fs.existsSync(f("ca.pem")) && fs.existsSync(f("ca.key"))) {
    caPem = fs.readFileSync(f("ca.pem"), "utf8");
    caKey = crypto.createPrivateKey(fs.readFileSync(f("ca.key"), "utf8"));
  } else {
    const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    caKey = kp.privateKey;
    const cn = `SUPERVIVE Revive Local CA ${crypto.randomBytes(4).toString("hex")}`;
    caPem = issue({ subject: cn, issuer: cn, spki: kp.publicKey.export({ type: "spki", format: "der" }), signKey: caKey, ca: true, days: 3650 });
    fs.writeFileSync(f("ca.key"), caKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(f("ca.pem"), caPem, { mode: 0o644 });
    log(`generated a new local CA in ${CERT_DIR}`);
  }
  const caCn = new crypto.X509Certificate(caPem).subject.replace(/^CN=/, "");
  let leafPem, leafKeyPem;
  const leafOk = fs.existsSync(f("leaf.pem")) && fs.existsSync(f("leaf.key"))
    && new crypto.X509Certificate(fs.readFileSync(f("leaf.pem"))).checkIssued(new crypto.X509Certificate(caPem))
    && new crypto.X509Certificate(fs.readFileSync(f("leaf.pem"))).checkIP("127.0.0.1") !== undefined;
  if (leafOk) {
    leafPem = fs.readFileSync(f("leaf.pem"), "utf8");
    leafKeyPem = fs.readFileSync(f("leaf.key"), "utf8");
  } else {
    const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    leafPem = issue({ subject: "supervive-revive-local", issuer: caCn, spki: kp.publicKey.export({ type: "spki", format: "der" }), signKey: caKey, ca: false, dnsNames: LEAF_NAMES, ipNames: LEAF_IPS, days: 825 });
    leafKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
    fs.writeFileSync(f("leaf.key"), leafKeyPem, { mode: 0o600 });
    fs.writeFileSync(f("leaf.pem"), leafPem, { mode: 0o644 });
    log("generated a new leaf certificate");
  }
  return { caPem, leafPem, leafKeyPem };
}

// ---------------------------------------------------------------------------------------------
// Trust bundle install / uninstall (the only game file this project ever writes, and only on request)

function trustPath(gameRoot) {
  const candidates = [path.join(gameRoot, TRUST_REL), path.join(gameRoot, "SUPERVIVE", TRUST_REL)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function stripBlock(text) {
  const a = text.indexOf(TRUST_MARKER_BEGIN);
  if (a < 0) return text;
  const b = text.indexOf(TRUST_MARKER_END, a);
  if (b < 0) return text.slice(0, a).replace(/\n+$/, "\n");
  return (text.slice(0, a) + text.slice(b + TRUST_MARKER_END.length)).replace(/\n{3,}/g, "\n\n");
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

async function cmdTrust() {
  if (!A.game) throw new Error("--game <install root> is required");
  const file = trustPath(String(A.game));
  if (!file) throw new Error(`trust bundle not found under ${A.game} (expected ${TRUST_REL})`);
  const { caPem } = loadOrCreateCerts();
  const cur = fs.readFileSync(file, "utf8");
  if (cur.includes(caPem.trim())) { log(`local CA already trusted in ${file}`); return; }
  console.log(`\nThis will append a CA certificate generated on THIS machine to:\n  ${file}\n` +
    `so the game accepts the local backend. A byte-exact backup is kept at:\n  ${file}${BACKUP_SUFFIX}\n` +
    `Undo at any time with: proxy.mjs untrust --game "${A.game}"\n`);
  const ok = A.yes === true || (await confirm("Proceed? [y/N] "));
  if (!ok) { console.log("Cancelled. Nothing was changed."); process.exitCode = 1; return; }
  if (!fs.existsSync(file + BACKUP_SUFFIX)) fs.copyFileSync(file, file + BACKUP_SUFFIX);
  const base = stripBlock(cur).replace(/\s*$/, "\n");
  fs.writeFileSync(file, `${base}\n${TRUST_MARKER_BEGIN}\n${caPem.trim()}\n${TRUST_MARKER_END}\n`);
  log(`installed local CA into ${file}`);
}

function cmdUntrust() {
  if (!A.game) throw new Error("--game <install root> is required");
  const file = trustPath(String(A.game));
  if (!file) throw new Error(`trust bundle not found under ${A.game}`);
  if (fs.existsSync(file + BACKUP_SUFFIX)) {
    fs.copyFileSync(file + BACKUP_SUFFIX, file);
    fs.unlinkSync(file + BACKUP_SUFFIX);
    log(`restored ${file} from backup`);
  } else {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.includes(TRUST_MARKER_BEGIN)) { fs.writeFileSync(file, stripBlock(cur)); log(`removed local CA block from ${file} (no backup existed)`); }
    else log(`nothing to undo in ${file}`);
  }
}

function cmdStatus() {
  const file = A.game ? trustPath(String(A.game)) : null;
  const hasCa = fs.existsSync(path.join(CERT_DIR, "ca.pem"));
  const trusted = file && hasCa && fs.readFileSync(file, "utf8").includes(fs.readFileSync(path.join(CERT_DIR, "ca.pem"), "utf8").trim());
  console.log(JSON.stringify({ certDir: CERT_DIR, caGenerated: hasCa, trustFile: file, trusted: !!trusted, backup: !!(file && fs.existsSync(file + BACKUP_SUFFIX)) }, null, 2));
}

// ---------------------------------------------------------------------------------------------
// Proxy

function shouldIntercept(host) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  return INTERCEPT_SUFFIXES.some((s) => h.endsWith(s));
}

function serve() {
  const upstream = new URL(String(A.backend || process.env.REVIVE_BACKEND || "http://127.0.0.1:24970"));
  const port = Number(A.port || process.env.REVIVE_PROXY_PORT || 24972);
  const bind = String(A.bind || "127.0.0.1");
  const client = upstream.protocol === "https:" ? https : http;
  const { leafPem, leafKeyPem } = loadOrCreateCerts();
  const secureContext = tls.createSecureContext({ key: leafKeyPem, cert: leafPem });

  function forward(req, res, originalHost) {
    const headers = { ...req.headers, host: upstream.host, "x-revive-original-host": originalHost };
    delete headers["proxy-connection"];
    const up = client.request({ hostname: upstream.hostname, port: upstream.port || (upstream.protocol === "https:" ? 443 : 80), path: req.url, method: req.method, headers }, (r) => {
      log(`${req.method} ${originalHost}${req.url} -> ${r.statusCode}`);
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      log(`upstream error ${req.method} ${originalHost}${req.url}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorCode: 502, errorMessage: "local backend unreachable" }));
    });
    req.pipe(up);
  }

  function forwardUpgrade(req, sock, head, originalHost) {
    const connect = upstream.protocol === "https:"
      ? (cb) => tls.connect({ host: upstream.hostname, port: Number(upstream.port || 443), servername: upstream.hostname }, cb)
      : (cb) => net.connect({ host: upstream.hostname, port: Number(upstream.port || 80) }, cb);
    const up = connect(() => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        raw += `${k}: ${k.toLowerCase() === "host" ? upstream.host : req.rawHeaders[i + 1]}\r\n`;
      }
      raw += `X-Revive-Original-Host: ${originalHost}\r\n\r\n`;
      up.write(raw);
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
      log(`websocket ${originalHost}${req.url} -> ${upstream.host}`);
    });
    up.on("error", (e) => { log(`websocket upstream error: ${e.message}`); sock.destroy(); });
    sock.on("error", () => up.destroy());
  }

  const inner = http.createServer((req, res) => forward(req, res, req.socket.__host || req.headers.host || ""));
  inner.on("upgrade", (req, sock, head) => forwardUpgrade(req, sock, head, sock.__host || req.headers.host || ""));

  const outer = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    if (shouldIntercept(u.hostname)) { req.url = u.pathname + u.search; return forward(req, res, u.hostname); }
    const o = http.request(u, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    o.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(o);
  });

  outer.on("connect", (req, sock, head) => {
    const [host, p] = String(req.url || "").split(":");
    const targetPort = Number(p || 443);
    if (shouldIntercept(host)) {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const t = new tls.TLSSocket(sock, { isServer: true, secureContext });
      t.__host = host;
      t.on("error", (e) => log(`tls error ${host}: ${e.message}`));
      inner.emit("connection", t);
      if (head?.length) sock.unshift(head);
      return;
    }
    const up = net.connect(targetPort, host, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });

  outer.listen(port, bind, () => log(`proxy listening on ${bind}:${port}, upstream ${upstream.origin}`));

  // Direct TLS endpoint: the game's own service URLs are pointed at https://127.0.0.1:<tlsPort>, which
  // works whether or not a given client subsystem honours -httpproxy.
  const tlsPort = Number(A["tls-port"] || process.env.REVIVE_TLS_PORT || port + 1);
  const onDirect = (sock) => { sock.__host = `localhost:${tlsPort}`; inner.emit("connection", sock); };
  const direct = tls.createServer({ key: leafKeyPem, cert: leafPem }, onDirect);
  direct.on("tlsClientError", (e) => log(`direct tls error: ${e.message}`));
  direct.listen(tlsPort, "127.0.0.1", () => log(`direct TLS listening on 127.0.0.1:${tlsPort}`));
  // libwebsockets resolves localhost to ::1 first on Windows. Bind IPv6 too where available.
  const direct6 = tls.createServer({ key: leafKeyPem, cert: leafPem }, onDirect);
  direct6.on("tlsClientError", (e) => log(`direct tls error: ${e.message}`));
  direct6.on("error", (e) => log(`direct TLS IPv6 unavailable: ${e.message}`));
  direct6.listen(tlsPort, "::1", () => log(`direct TLS listening on [::1]:${tlsPort}`));
}

const cmd = A._[0] || "serve";
try {
  if (cmd === "serve") serve();
  else if (cmd === "trust") await cmdTrust();
  else if (cmd === "untrust") cmdUntrust();
  else if (cmd === "status") cmdStatus();
  else if (cmd === "certs") { loadOrCreateCerts(); cmdStatus(); }
  else { console.error(`unknown command ${cmd}`); process.exit(2); }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
