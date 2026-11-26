// Small request/response helpers shared by every module.
import type { Profile } from "./accounts.ts";

export type Ctx = {
  req: Request;
  url: URL;
  path: string;
  method: string;
  body: any;
  bodyText: string;
  namespace: string;
  user: Profile | null;
  ip: string;
};

export type Handler = (c: Ctx) => Response | Promise<Response> | null;

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
export const noContent = () => new Response(null, { status: 204 });
export const error = (status: number, errorMessage: string, errorCode = status) => json({ errorCode, errorMessage, error: errorMessage }, status);
export const page = <T>(data: T[]) => json({ data, paging: { first: "", last: "", next: "", previous: "" } });
export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

/** Case-insensitive field lookup: the client sends PascalCase or camelCase depending on the call. */
export function pick(obj: any, ...names: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) { const k = lower.get(n.toLowerCase()); if (k !== undefined && obj[k] !== undefined) return obj[k]; }
  return undefined;
}

/** "Hero:Foo", {PrimaryAssetType, PrimaryAssetName} or {Type, Name} → "Type:Name". */
export function assetId(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  const t = pick(v, "PrimaryAssetType", "Type"), n = pick(v, "PrimaryAssetName", "Name");
  if (t && n) return `${typeof t === "object" ? pick(t, "Name") : t}:${n}`;
  return "";
}

export const nsFromPath = (path: string) => path.match(/\/namespaces\/([^/]+)/)?.[1];
