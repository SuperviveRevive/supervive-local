// RS256 signing key generated per install, plus JWT sign/verify and the matching JWKS.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

const KEY_FILE = join(DATA_DIR, "signing-key.json");

function loadKey(): { kid: string; priv: KeyObject; pub: KeyObject } {
  if (existsSync(KEY_FILE)) {
    const k = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    const priv = createPrivateKey(k.privateKey);
    return { kid: k.kid, priv, pub: createPublicKey(priv) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID().replace(/-/g, "");
  writeFileSync(KEY_FILE, JSON.stringify({ kid, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }), { mode: 0o600 });
  return { kid, priv: privateKey, pub: publicKey };
}

const KEY = loadKey();
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(claims: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KEY.kid }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(sign("sha256", Buffer.from(`${head}.${body}`), KEY.priv))}`;
}

export function verifyJwt<T = Record<string, any>>(token: string): T | null {
  const [h, b, s] = String(token || "").split(".");
  if (!h || !b || !s) return null;
  try {
    if (!verify("sha256", Buffer.from(`${h}.${b}`), KEY.pub, Buffer.from(s, "base64url"))) return null;
    const claims = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch { return null; }
}

export function jwks() {
  const jwk = KEY.pub.export({ format: "jwk" }) as Record<string, string>;
  return { keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: KEY.kid, n: jwk.n, e: jwk.e }] };
}
