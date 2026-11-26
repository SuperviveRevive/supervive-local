import { readFileSync } from "node:fs";
import { BitWriter } from "./bits.ts";

/**
 * Exact SUPERVIVE 2.0.4 FRepLayout handles (data/sv-replayout-204.json), recovered
 * from the shipping exe's UHT reflection tables: CPF_Net flags + declaration order
 * (native ClassReps are not offset-sorted), usmap names/supers. Theorycraft's engine
 * adds AActor.ServerState (handles 16-17) and drops APawn.RemoteViewPitch16, so the
 * stock UE5 dump (rep-layout-204.json) is off by two for every actor subclass.
 * Fast-array (NetDeltaSerialize) structs take no handle. Byte/enum props carry the
 * net bit width UE serializes them with (CeilLogTwo(MaxEnumValue + 1)).
 */
export interface NetField {
  h: number;
  class: string;
  name: string;
  type: string;
  enum?: string;
  bits?: number;
  struct?: string;
  inner?: string;
  max?: number;
}

interface SvLayoutFile {
  classes: Record<string, { chain: string[]; handles: Array<Omit<NetField, "class" | "h"> & { h: number | null }> }>;
}

export interface NetClassEntry {
  className: string;
  fields: NetField[];
  byName: Map<string, NetField>;
}

export type NetLayout = Map<string, NetClassEntry>;

let cached: { path: string; layout: NetLayout } | null = null;

export function loadNetLayout(
  path = new URL("./data/sv-replayout-204.json", import.meta.url).pathname,
): NetLayout {
  if (cached?.path === path) return cached.layout;
  const file = JSON.parse(readFileSync(path, "utf8")) as SvLayoutFile;
  const layout: NetLayout = new Map();
  for (const [className, entry] of Object.entries(file.classes)) {
    const fields: NetField[] = [];
    for (const f of entry.handles ?? []) {
      if (f.h === null || f.h === undefined) continue;
      fields.push({ ...f, h: f.h, class: className, type: f.type === "struct" && f.struct ? `struct:${f.struct}` : f.type });
    }
    // Real-client oracle 2026-11-24: GameState handle 20 decodes as ReplicatedWorldTimeSecondsDouble
    // (our dump says 21), so AActor.ServerState is ONE handle on the wire, not State+Version.
    const sv = fields.findIndex((f) => f.name === "ServerState.Version");
    if (sv >= 0 && !process.env.LOKI_SERVERSTATE_SPLIT) {
      const cut = fields[sv].h;
      fields.splice(sv, 1);
      for (const f of fields) if (f.h > cut) f.h -= 1;
    }
    layout.set(className, {
      className,
      fields,
      byName: new Map(fields.map((f) => [f.name, f])),
    });
  }
  cached = { path, layout };
  return layout;
}

/** UE5.4 handle-based property stream: packed handles resolve against the
 *  real client's FRepLayout, so every written handle must come from this
 *  dump. Unknown fields are refused (handle -1) rather than guessed. */
export class NetClassLayout {
  readonly unknown = new Set<string>();
  private readonly layout: NetLayout;

  constructor(layout: NetLayout = loadNetLayout()) {
    this.layout = layout;
  }

  /** Exact per-class flattened handle, or -1 when the dump has no entry. */
  handle(className: string, fieldName: string): number {
    const entry = this.layout.get(className) ?? this.layout.get(`A${className}`);
    const field = entry?.byName.get(fieldName);
    return field ? field.h : -1;
  }

  field(className: string, fieldName: string): NetField | undefined {
    return this.layout.get(className)?.byName.get(fieldName);
  }
  /** Same lookup but returns null instead of undefined for optional-call sites. */
  fieldOf(className: string, fieldName: string): NetField | null {
    return this.layout.get(className)?.byName.get(fieldName) ?? null;
  }

  /** Type-aware serialization for a dumped field. Struct payloads that have
   *  no dedicated serializer yet are refused. */
  write(w: BitWriter, className: string, fieldName: string, value: unknown): boolean {
    const field = this.field(className, fieldName);
    if (!field) {
      const key = `${className}.${fieldName}`;
      if (!this.unknown.has(key)) {
        this.unknown.add(key);
        console.warn(`[netlayout] no handle for ${key}; property skipped`);
      }
      return false;
    }
    w.packed32(field.h);
    return writePropValue(w, field, value);
  }

  /** Writes a terminator without a checksum bit — shipping builds have none. */
  endStream(w: BitWriter) {
    w.packed32(0);
  }
}

/** Serialized payload bytes for one typed field (handle already written). */
export function writePropValue(w: BitWriter, field: NetField, value: unknown): boolean {
  switch (field.type) {
    case "bool":
      w.bit(Boolean(value));
      return true;
    case "byte":
    case "enum":
      if (field.bits !== undefined && field.bits !== null && field.bits < 8) {
        w.bitsFrom(Uint8Array.of(Number(value) & ((1 << field.bits) - 1)), field.bits);
      } else {
        w.int8(Number(value) & 0xff);
      }
      return true;
    case "uint16":
      w.uint16(Number(value) & 0xffff);
      return true;
    case "int8":
      w.int8(Number(value) & 0xff);
      return true;
    case "int16":
      w.int16(Number(value));
      return true;
    case "int32":
      w.int32(Number(value) | 0);
      return true;
    case "uint32":
      w.uint32(Number(value) >>> 0);
      return true;
    case "int64":
    case "uint64": {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigInt64(0, BigInt(value), true);
      w.bytes(new Uint8Array(buf));
      return true;
    }
    case "float":
      w.float(Number(value));
      return true;
    case "double":
      w.double(Number(value));
      return true;
    case "name":
      w.fname(String(value));
      return true;
    case "string":
      w.fstring(String(value));
      return true;
    case "object":
    case "soft_object":
    case "weak_object":
    case "interface":
    case "class":
      w.packed64(BigInt(value));
      return true;
    default:
      // struct/array/map payloads need dedicated serializers; refuse loudly.
      return false;
  }
}
