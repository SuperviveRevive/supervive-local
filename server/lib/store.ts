// Tiny JSON-file persistence. One file per collection under DATA_DIR, written atomically and debounced.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const flushers = new Map<string, () => void>();

export function collection<T extends object>(name: string, initial: T): T {
  const file = join(DATA_DIR, `${name}.json`);
  let value: T = initial;
  if (existsSync(file)) {
    try { value = { ...initial, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { /* keep initial; file is rewritten on next save */ }
  }
  const flush = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  };
  flushers.set(name, flush);
  return new Proxy(value, {
    set(t, k, v) { (t as any)[k] = v; save(name); return true; },
    deleteProperty(t, k) { delete (t as any)[k]; save(name); return true; },
  });
}

export function save(name: string) {
  if (timers.has(name)) return;
  timers.set(name, setTimeout(() => { timers.delete(name); flushers.get(name)?.(); }, 250));
}

export function flushAll() {
  for (const [name, t] of timers) { clearTimeout(t); timers.delete(name); flushers.get(name)?.(); }
}

process.on("exit", flushAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { flushAll(); process.exit(0); });
