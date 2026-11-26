// The storm (death circle) — replicated BP_DeathCircle_Skylands_Bots_C, bit-exact to retail.
//
// Evidence: retail Breach flows 7038 + 7039 (recorded retail match traffic, decoded with the capture decoder (not shipped); gate tools/check-zone.ts
// re-encodes the 7038 open/reveal/shrink/GameState blocks bit-identical), FFA flow 7547 (static BP_DeathCircle_FFA_C),
// LokiZone.h (FLokiDeathCirclePhase native NetSerialize = Radius f32, WaitTime f32, ShrinkTime f32, DamageLevel i32,
// DayNightState u8 → 136 bits; CT DeathCircle_Damage curve).
//
// Wire (client handles, AActor.ServerState = one handle):
//   h5 RemoteRole(3b)=1, h14 Role(3b)=3, h17 CirclePhases (uint16 num, packed(i+1)+136-bit element…, packed 0),
//   h18 Radius f32, h19 Center FVector2D (2 doubles), h20 NextLocation FVector (3 doubles, BP), h21 NextRadius double (BP),
//   h22 FinalLocation FVector (BP).
// Retail timeline (7038, flow seconds; combat = 14.14):
//   12.14 open: phases + Center + NextLocation=Center + NextRadius 58000 + FinalLocation, then dormant;
//   GameState h42 DeathCirclePhase 0, h65 DeathCircle, h38/39/40 DayNightState/LastChange/TotalDayNightTime.
//   86.99 reveal: NextLocation/NextRadius of the first shrink's circle.
//   134.05 (combat+120) phase 1 = shrink: every frame h18 Radius + h19 Center (lerp to the next circle), GS h42 1.
//   244.05 shrink end: h19 final Center + h20/h21 the NEXT circle (revealed at once), GS h42 2 + day/night fields.
// Damage: GE_DeathCircleBurn, 0.25 s period, 0.25 x DeathCircle_Damage(level) per period = curve(level) per second.
import { BitWriter } from "./bits.ts";

export interface CirclePhase { radius: number; wait: number; shrink: number; level: number; dayNight: number }

/** Retail BP_DeathCircle_Skylands_Bots server schedule (flows 7038 = 7039; differs from the CDO after phase 14). */
export const BREACH_PHASES: CirclePhase[] = ([
  [58000, 120, 0, 0, 0], [58000, 0, 110, 0, 0], [38000, 75, 0, 1, 1], [38000, 10, 0, 1, 0], [38000, 0, 80, 1, 0],
  [25000, 60, 0, 2, 1], [25000, 10, 0, 2, 0], [25000, 0, 60, 2, 0], [18000, 60, 0, 3, 1], [18000, 10, 0, 3, 0],
  [18000, 0, 50, 3, 0], [13000, 60, 0, 4, 1], [13000, 10, 0, 4, 2], [13000, 0, 40, 4, 2], [8500, 40, 0, 5, 2],
  [8500, 0, 75, 5, 2], [6500, 40, 0, 6, 2], [6500, 0, 75, 6, 2], [4500, 40, 0, 7, 2], [4500, 0, 75, 7, 2],
  [3000, 40, 0, 8, 2], [3000, 0, 75, 8, 2], [2000, 40, 0, 9, 2], [2000, 0, 75, 9, 2], [1500, 30, 0, 10, 2],
  [1500, 0, 75, 10, 2], [1500, 30, 0, 10, 2], [1500, 0, 75, 10, 2], [0, 15, 30, 5, 0],
] as const).map(([radius, wait, shrink, level, dayNight]) => ({ radius, wait, shrink, level, dayNight }));

/** Retail FFA (flow 7547): a fixed 8000 circle at (23140, 41420) that never shrinks (wait 360000 s), damage level 8. */
export const FFA_PHASES: CirclePhase[] = [
  { radius: 8000, wait: 360000, shrink: 0, level: 8, dayNight: 0 },
  { radius: 8000, wait: 0, shrink: 0, level: 8, dayNight: 0 },
  { radius: 0, wait: 15, shrink: 30, level: 5, dayNight: 0 },
];
export const FFA_CENTER: [number, number] = [23140, 41420];

export const ZONE_CLASSES = {
  breach: { pkg: "/Game/Loki/Core/GameModes/Objectives/BP_DeathCircle_Skylands_Bots", cdo: "Default__BP_DeathCircle_Skylands_Bots_C", cdoRadius: 58000, cdoNextRadius: 0 },
  ffa: { pkg: "/Game/Loki/Core/GameModes/FFA/BP_DeathCircle_FFA", cdo: "Default__BP_DeathCircle_FFA_C", cdoRadius: 8000, cdoNextRadius: 8000 },
} as const;

export const H = { RemoteRole: 5, Role: 14, CirclePhases: 17, Radius: 18, Center: 19, NextLocation: 20, NextRadius: 21, FinalLocation: 22 } as const;
/** GameState (BP_LokiBattleRoyaleGameState_Breach_C, client handles): DayNightState 38 (2b), LastDayNightChangeTime 39 f32,
 *  TotalDayNightTime 40 f32, DeathCirclePhase 42 i32, DeathCircle 65 object. */
export const GS_H = { DayNightState: 38, LastDayNightChangeTime: 39, TotalDayNightTime: 40, DeathCirclePhase: 42, DeathCircle: 65 } as const;

/** CT_LokiGameplaySystemsAttributes.DeathCircle_Damage: linear (0,3) (1,6) (2,50) (10,450), constant outside. HP per second. */
export function stormDps(level: number): number {
  const T = [0, 1, 2, 10], V = [3, 6, 50, 450];
  if (level <= T[0]!) return V[0]!;
  for (let i = 1; i < T.length; i++) if (level <= T[i]!) return V[i - 1]! + (V[i]! - V[i - 1]!) * (level - T[i - 1]!) / (T[i]! - T[i - 1]!);
  return V[V.length - 1]!;
}

export interface ZoneState {
  phase: number; elapsed: number;
  radius: number; center: [number, number];
  shrinking: boolean;
  /** the circle the next (or current) shrink ends at; null once nothing shrinks any more */
  next: { center: [number, number]; radius: number } | null;
  revealed: boolean;
  level: number; dps: number; dayNight: number;
}

export class Zone {
  readonly starts: number[] = [];
  /** centre of the circle each phase holds/starts its shrink from */
  readonly centers: Array<[number, number]> = [];
  readonly final: [number, number];

  /** @param revealAt seconds after `epoch` at which the first next circle is revealed (retail: 72.85 s after combat) */
  constructor(readonly phases: CirclePhase[], readonly center0: [number, number], opts: { seed?: number; final?: [number, number]; candidates?: Array<[number, number]>; revealAt?: number; staticCenter?: boolean } = {}) {
    this.revealAt = opts.revealAt ?? 72.85;
    let t = 0;
    for (const p of phases) { this.starts.push(t); t += p.wait + p.shrink; }
    let rnd = (opts.seed ?? 1) >>> 0;
    const rand = () => { rnd = (Math.imul(rnd ^ (rnd >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return rnd / 2 ** 32; };
    if (opts.final) this.final = opts.final;
    else if (opts.staticCenter || !opts.candidates?.length) this.final = [...center0];
    else {
      const ok = opts.candidates.filter(([x, y]) => Math.hypot(x - center0[0], y - center0[1]) < phases[0]!.radius * 0.55);
      const pool = ok.length ? ok : opts.candidates;
      this.final = pool[Math.floor(rand() * pool.length)]!;
    }
    // Each circle moves toward the final point by at most the radius it loses, so every circle is inside the last.
    let c: [number, number] = [...center0];
    for (let i = 0; i < phases.length; i++) {
      this.centers.push(c);
      const p = phases[i]!, nr = phases[i + 1]?.radius;
      if (p.shrink > 0 && nr !== undefined && !opts.staticCenter) {
        const dx = this.final[0] - c[0], dy = this.final[1] - c[1], d = Math.hypot(dx, dy);
        const step = Math.min(d, Math.max(0, p.radius - nr) * (0.75 + 0.25 * rand()));
        c = d > 1 ? [c[0] + dx / d * step, c[1] + dy / d * step] : c;
      }
    }
  }
  readonly revealAt: number;

  /** the shrink phase (index) that is running or comes next at/after phase i */
  private nextShrink(i: number): number {
    for (let k = i; k < this.phases.length - 1; k++) if (this.phases[k]!.shrink > 0) return k;
    return -1;
  }

  at(elapsed: number): ZoneState {
    const P = this.phases;
    let i = 0;
    while (i + 1 < P.length && elapsed >= this.starts[i + 1]!) i++;
    const p = P[i]!;
    const local = Math.max(0, elapsed - this.starts[i]!);
    const shrinking = i + 1 < P.length && p.shrink > 0 && local >= p.wait;
    let radius = p.radius, center = this.centers[i]!;
    if (shrinking) {
      const f = Math.min(1, (local - p.wait) / p.shrink);
      const to = this.centers[i + 1]!;
      radius = p.radius + (P[i + 1]!.radius - p.radius) * f;
      center = [center[0] + (to[0] - center[0]) * f, center[1] + (to[1] - center[1]) * f];
    }
    const k = this.nextShrink(i);
    const next = k >= 0 ? { center: this.centers[k + 1]!, radius: P[k + 1]!.radius } : null;
    // first circle: revealed at revealAt (or its shrink start); later ones at the end of the shrink before them
    const firstShrink = this.nextShrink(0);
    const revealed = next !== null && (k !== firstShrink || elapsed >= Math.min(this.revealAt, this.starts[k]! + P[k]!.wait));
    const level = p.level;
    return { phase: i, elapsed, radius, center, shrinking, next, revealed, level, dps: stormDps(level), dayNight: p.dayNight };
  }

  /** seconds the day/night state starting at phase i lasts (retail TotalDayNightTime) */
  dayNightSpan(i: number): number {
    let s = 0;
    const dn = this.phases[i]!.dayNight;
    for (let k = i; k < this.phases.length && this.phases[k]!.dayNight === dn; k++) s += this.phases[k]!.wait + this.phases[k]!.shrink;
    return s;
  }

  /** true when phase i starts a new day/night state (or is phase 0) */
  dayNightEdge(i: number): boolean { return i === 0 || this.phases[i]!.dayNight !== this.phases[i - 1]!.dayNight; }
}

// ------------------------------------------------------------------ payloads (property streams incl. checksum bit + end)

function element(w: BitWriter, p: CirclePhase) {
  w.float(p.radius); w.float(p.wait); w.float(p.shrink); w.int32(p.level); w.uint8(p.dayNight);
}

/** Actor open block. `skip` = element indices equal to the CDO's that retail leaves out (7039 omits 0–1, 7038 sends all). */
export function openPayload(z: Zone, s: ZoneState, cdoRadius: number, opts: { skip?: Set<number>; cdoNextRadius?: number } = {}): BitWriter {
  const w = new BitWriter(6000);
  w.bit(false);
  w.packed32(H.RemoteRole); bits3(w, 1);
  w.packed32(H.Role); bits3(w, 3);
  w.packed32(H.CirclePhases); w.uint16(z.phases.length);
  z.phases.forEach((p, i) => { if (opts.skip?.has(i)) return; w.packed32(i + 1); element(w, p); });
  w.packed32(0);
  if (Math.fround(s.radius) !== Math.fround(cdoRadius)) { w.packed32(H.Radius); w.float(s.radius); }
  // properties equal to the CDO (centre/next location 0) are not sent (retail 7039 opened at the origin)
  if (s.center[0] !== 0 || s.center[1] !== 0) { w.packed32(H.Center); w.double(s.center[0]); w.double(s.center[1]); }
  // before the reveal, retail's NextLocation is the current centre and NextRadius the CDO radius
  const nl = s.revealed && s.next ? s.next.center : s.center;
  const nr = s.revealed && s.next ? s.next.radius : cdoRadius;
  if (nl[0] !== 0 || nl[1] !== 0) { w.packed32(H.NextLocation); w.double(nl[0]); w.double(nl[1]); w.double(0); }
  if (nr !== (opts.cdoNextRadius ?? 0)) { w.packed32(H.NextRadius); w.double(nr); }
  w.packed32(H.FinalLocation); w.double(z.final[0]); w.double(z.final[1]); w.double(0);
  w.packed32(0);
  return w;
}

function bits3(w: BitWriter, v: number) { for (let i = 0; i < 3; i++) w.bit((v >> i) & 1); }

/** Per-frame shrink update: h18 Radius + h19 Center. */
export function shrinkPayload(s: ZoneState): BitWriter {
  const w = new BitWriter(256);
  w.bit(false);
  w.packed32(H.Radius); w.float(s.radius);
  w.packed32(H.Center); w.double(s.center[0]); w.double(s.center[1]);
  w.packed32(0);
  return w;
}

/** Reveal (h20 NextLocation + h21 NextRadius), optionally with the settled centre (shrink end) and radius. */
export function revealPayload(next: { center: [number, number]; radius: number }, settle?: { center: [number, number]; radius?: number }): BitWriter {
  const w = new BitWriter(512);
  w.bit(false);
  if (settle?.radius !== undefined) { w.packed32(H.Radius); w.float(settle.radius); }
  if (settle) { w.packed32(H.Center); w.double(settle.center[0]); w.double(settle.center[1]); }
  w.packed32(H.NextLocation); w.double(next.center[0]); w.double(next.center[1]); w.double(0);
  w.packed32(H.NextRadius); w.double(next.radius);
  w.packed32(0);
  return w;
}

/** Settle only (last circle reached, nothing more to reveal). */
export function settlePayload(s: ZoneState): BitWriter {
  const w = new BitWriter(256);
  w.bit(false);
  w.packed32(H.Radius); w.float(s.radius);
  w.packed32(H.Center); w.double(s.center[0]); w.double(s.center[1]);
  w.packed32(0);
  return w;
}

/** GameState entries for a phase change: [handle, writer] (caller merges into its own sorted property stream). */
export function gsPhaseEntries(z: Zone, s: ZoneState, worldTime: number, opts: { zoneGuid?: bigint; writeGuid?: (w: BitWriter, g: bigint) => void; dayNight?: boolean } = {}): Array<[number, (w: BitWriter) => void]> {
  const out: Array<[number, (w: BitWriter) => void]> = [];
  if (opts.dayNight !== false && z.dayNightEdge(s.phase)) {
    const startWt = worldTime - (s.elapsed - z.starts[s.phase]!);
    out.push([GS_H.DayNightState, (w) => { w.bit(s.dayNight & 1); w.bit((s.dayNight >> 1) & 1); }]);
    out.push([GS_H.LastDayNightChangeTime, (w) => w.float(startWt)]);
    out.push([GS_H.TotalDayNightTime, (w) => w.float(z.dayNightSpan(s.phase))]);
  }
  out.push([GS_H.DeathCirclePhase, (w) => w.int32(s.phase)]);
  if (opts.zoneGuid !== undefined && opts.writeGuid) out.push([GS_H.DeathCircle, (w) => opts.writeGuid!(w, opts.zoneGuid!)]);
  return out;
}

/** Comp_GameState_GamePhase block (retail 81 bits): h5 = world time the phase began. */
export function gamePhasePayload(worldTime: number): BitWriter {
  const w = new BitWriter(96);
  w.bit(false); w.packed32(5); w.double(worldTime); w.packed32(0);
  return w;
}
