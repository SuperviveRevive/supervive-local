import { BitReader, BitWriter } from "./protocol.ts";
import { NetClassLayout } from "./netlayout.ts";
import type { MatchRules } from "./match.ts";

/**
 * Best-effort GAS RPC bridge.
 *
 * The wire handles come from the shipped 2.0.4 .usmap (data/netlayout.json) and are
 * exact. The parameter structs around them are NOT verified against a live client,
 * so this module is disabled unless LOKI_ENABLE_GAS_RPC=1. The authoritative
 * simulation (match.ts) works without it; this only lets a real client's
 * ServerTryActivateAbility calls drive the simulated abilities.
 */

export interface RpcHandles {
  serverTryActivateAbility: number;
  serverEndAbility: number;
  serverAbilityRPCBatch: number;
  serverMovePacked: number;
  clientActivateAbilitySucceed: number;
  clientEndAbility: number;
  clientActivateAbilityFailed: number;
}

export function rpcHandles(layout: NetClassLayout): RpcHandles {
  return {
    serverTryActivateAbility: layout.handle("AbilitySystemComponent", "ServerTryActivateAbility"),
    serverEndAbility: layout.handle("AbilitySystemComponent", "ServerEndAbility"),
    serverAbilityRPCBatch: layout.handle("AbilitySystemComponent", "ServerAbilityRPCBatch"),
    serverMovePacked: layout.handle("Character", "ServerMovePacked"),
    clientActivateAbilitySucceed: layout.handle("AbilitySystemComponent", "ClientActivateAbilitySucceed"),
    clientEndAbility: layout.handle("AbilitySystemComponent", "ClientEndAbility"),
    clientActivateAbilityFailed: layout.handle("AbilitySystemComponent", "ClientActivateAbilityFailed"),
  };
}

export interface DetectedRpc {
  handle: number;
  kind: "activate" | "end" | "batch" | "move" | "other";
  specIndex: number;
}

/**
 * Scans a client actor-channel payload for known RPC handles.
 *
 * UE writes an RPC as `bHasRepLayout=0, bIsActor=0, <handle:packed32>, <params...>`.
 * Property updates write `bHasRepLayout=1, ...`. We try both alignments, then read
 * the first int32 after the handle as a spec handle. `specIndex = handle % abilityCount`
 * is a deliberate clean-room convention: the real client's ability table cannot be
 * recovered from the .usmap alone, so this gives a stable, configurable mapping.
 */
export function detectRpcCalls(payload: Uint8Array, bits: number, handles: RpcHandles, abilityCount: number): DetectedRpc[] {
  const out: DetectedRpc[] = [];
  const seen = new Set<number>();
  const known = new Set<number>([
    handles.serverTryActivateAbility, handles.serverEndAbility,
    handles.serverAbilityRPCBatch, handles.serverMovePacked,
  ].filter((h) => h > 0));

  for (const repLayout of [false, true]) {
    for (let start = 0; start < 3; start++) {
      try {
        const r = new BitReader(payload, bits);
        if (r.bit() !== repLayout) continue;
        if (!repLayout && start === 0) {
          if (r.bit() !== false) continue; // bIsActor
        } else {
          r.skip(start);
        }
        let guard = 0;
        while (r.bitsLeft > 40 && guard++ < 32) {
          const handle = r.packed32();
          if (!known.has(handle)) break;
          if (!seen.has(handle)) {
            seen.add(handle);
            const spec = r.int32();
            out.push({
              handle,
              kind: handle === handles.serverTryActivateAbility ? "activate"
                : handle === handles.serverEndAbility ? "end"
                : handle === handles.serverAbilityRPCBatch ? "batch" : "move",
              specIndex: abilityCount > 0 ? Math.abs(spec) % abilityCount : 0,
            });
          }
          // Skip the rest of this RPC rather than guessing every parameter type.
          break;
        }
      } catch { /* wrong alignment */ }
    }
  }
  return out;
}

/** FGameplayAbilitySpecHandle + prediction key, for ClientActivateAbilitySucceed. */
export function writeActivateConfirm(w: BitWriter, specHandle: number, predictionKey: number, rebroadcast = false) {
  w.int32(specHandle);
  w.int32(0);
  w.int32(0);
  w.int32(0);
  w.int32(predictionKey);
  w.bit(rebroadcast);
}

export function abilityIdForSpec(rules: MatchRules, specIndex: number): string {
  const ability = rules.abilities[specIndex % Math.max(1, rules.abilities.length)];
  return ability?.id || rules.abilities[0]?.id || "primary";
}
