/**
 * castvis.ts — other players' and bots' casts made visible on every observer's client (2026-11-25).
 *
 * Retail plays a spell's warmup montage through UAbilitySystemComponent::PlayMontage on the server, which writes the ASC's
 * RepAnimMontageInfo (ASC RepLayout handle 11); every other client's OnRep_ReplicatedAnimMontage then plays it on the caster's
 * body (its AvatarActor). Wire = the retail reader (cross-checked against retail traffic):
 *   bRepPosition(1) [packed Position*100 | SectionIdToPlay 7b], IsStopped, ForcePlayBit, SkipPositionCorrection, bSkipPlayRate,
 *   montage NetGUID, bAnimatingCombatSpell (32-bit UBOOL), PlayRate f32, BlendTime f32, NextSectionID u8, PredictionKey.
 * Measured: the capture decoder (not shipped) decodes 117,082 retail handle-11 payloads (all five flows) with this reader, 0 bits
 * left; gate `bun tools/check-castvis.ts` re-encodes them bit-identically. The client replays when the montage or ForcePlayBit
 * differs from its local copy, so each cast flips the bit.
 *
 * The ability -> montage table is data/ability-montages-204.json (tools/gen-montage-map.py: the cooked
 * WarmupMontage where known, else a name/slot match preferring montages retail actually played).
 */
import { readFileSync } from "node:fs";
import { BitReader, BitWriter } from "./bits.ts";
import { writePredictionKey, readPredictionKey, type PredictionKey, writeBitsN, readBitsN } from "./gas.ts";

export interface MontagePlay {
  position?: number;        // seconds (bRepPosition=1); undefined -> section form
  section?: number;         // SectionIdToPlay (bRepPosition=0)
  stopped?: boolean;
  forcePlayBit: boolean;
  skipPositionCorrection?: boolean;
  skipPlayRate?: boolean;
  montage: bigint | number; // NetGUID
  combat: number;           // bAnimatingCombatSpell, 32-bit UBOOL
  rate: number;
  blend: number;
  nextSection?: number;
  key?: PredictionKey;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function writeF32(w: BitWriter, v: number) { f32[0] = v; writeBitsN(w, u32[0]!, 32); }
function readF32(r: BitReader) { u32[0] = readBitsN(r, 32); return f32[0]!; }

export function writeRepAnimMontage(w: BitWriter, m: MontagePlay) {
  const repPos = m.position !== undefined;
  w.bit(repPos);
  if (repPos) w.packed32(Math.round(m.position! * 100) >>> 0);
  else writeBitsN(w, m.section ?? 0, 7);
  w.bit(!!m.stopped); w.bit(!!m.forcePlayBit); w.bit(!!m.skipPositionCorrection); w.bit(!!m.skipPlayRate);
  w.packed64(BigInt(m.montage));
  writeBitsN(w, m.combat >>> 0, 32);
  writeF32(w, m.rate); writeF32(w, m.blend);
  writeBitsN(w, m.nextSection ?? 0, 8);
  writePredictionKey(w, m.key ?? { current: 0 });
}

export function readRepAnimMontage(r: BitReader): MontagePlay {
  const repPos = r.bit();
  const m: MontagePlay = { forcePlayBit: false, montage: 0, combat: 0, rate: 0, blend: 0 };
  if (repPos) m.position = r.packed32() * 0.01; else m.section = readBitsN(r, 7);
  m.stopped = r.bit(); m.forcePlayBit = r.bit(); m.skipPositionCorrection = r.bit(); m.skipPlayRate = r.bit();
  m.montage = r.packed64();
  m.combat = readBitsN(r, 32); m.rate = readF32(r); m.blend = readF32(r); m.nextSection = readBitsN(r, 8);
  m.key = readPredictionKey(r);
  return m;
}

export interface MontageRow { inputId: number; pkg: string; obj: string; combat: number; rate: number; blend: number; src: string }
type Table = Record<string, Record<string, MontageRow>>;
const TABLE: Table = (() => {
  try { return JSON.parse(readFileSync(new URL("./data/ability-montages-204.json", import.meta.url), "utf8")).heroes ?? {}; }
  catch { return {}; }
})();
/** Retail-verified overrides where the generator's name match is wrong (retail flows: FireFox R = AM_FireFox_Ability_R). */
const OVERRIDES: Record<string, Record<string, Partial<MontageRow>>> = {
  FireFox: { GS_Firefox_Jetpack_DashV2_C: { pkg: "/Game/Loki/Characters/Heroes/FireFox/Animation/Ability/AM_FireFox_Ability_R", obj: "AM_FireFox_Ability_R" } },
};

export function montageForSpell(heroFolder: string, spellCls: string): MontageRow | null {
  const row = TABLE[heroFolder]?.[spellCls];
  if (!row) return null;
  return { ...row, ...(OVERRIDES[heroFolder]?.[spellCls] ?? {}) };
}

/** First row for an input slot (bots: the sim knows the slot, not the spell). */
export function montageForInput(heroFolder: string, inputId: number): MontageRow | null {
  const rows = TABLE[heroFolder];
  if (!rows) return null;
  for (const [cls, row] of Object.entries(rows)) if (row.inputId === inputId) return montageForSpell(heroFolder, cls);
  return null;
}

export function heroesWithMontages(): string[] { return Object.keys(TABLE); }

/** Static NetGUIDs (odd) per montage package: pkg 0x60001 + 4i, the montage object +2. */
const guidIndex = new Map<string, number>();
export function montageGuids(pkg: string): { pkg: bigint; obj: bigint } {
  let i = guidIndex.get(pkg);
  if (i === undefined) { i = guidIndex.size; guidIndex.set(pkg, i); }
  const g = 0x60001n + BigInt(i) * 4n;
  return { pkg: g, obj: g + 2n };
}
