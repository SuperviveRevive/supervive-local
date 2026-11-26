// Read the game-mode alias table from the user's OWN DefaultEngine.ini (exported from their install)
// and pair aliases with maps from their catalog to seed an editable queue list.

import { readFileSync } from "node:fs";
import type { Catalog } from "./catalog.ts";

export type Alias = { name: string; gameMode: string };
export type QueueDef = {
  id: string; name: string; alias: string; map: string;
  teamSize: number; teams: number; maxPartySize: number; botFill: boolean;
};

export function readAliases(iniPath: string): Alias[] {
  const out: Alias[] = [];
  for (const line of readFileSync(iniPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\+?GameModeClassAliases=\(Name="([^"]+)",\s*GameMode="([^"]+)"\)/);
    if (m) out.push({ name: m[1], gameMode: m[2] });
  }
  return out;
}

const tokens = (s: string) => s.replace(/GameMode$|Mode$/, "").split(/(?=[A-Z][a-z])|_|(?<=[a-z])(?=[A-Z])/).filter((t) => t.length >= 4);

/** Best-effort: an alias is paired with the map whose name shares its longest distinctive token. */
export function seedQueues(aliases: Alias[], catalog: Catalog): QueueDef[] {
  const maps = catalog.maps.filter((m) => !/Standby|Login|Frontend|Lobby|Test|Dev|Debug|Sandbox/i.test(m.name));
  const queues: QueueDef[] = [];
  for (const a of aliases) {
    let best: { map: string; score: number } | null = null;
    for (const t of tokens(a.name)) {
      for (const m of maps) {
        if (m.name.toLowerCase().includes(t.toLowerCase()) && (!best || t.length > best.score)) best = { map: m.path, score: t.length };
      }
    }
    if (!best) continue;
    const solo = /Solo|Practice|Training|Tutorial/i.test(a.name);
    const duo = /Duo/i.test(a.name);
    const teamSize = solo ? 1 : duo ? 2 : 4;
    queues.push({
      id: a.name.replace(/GameMode$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
      name: a.name.replace(/GameMode$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
      alias: a.name, map: best.map, teamSize, teams: solo ? 1 : 2, maxPartySize: teamSize, botFill: true,
    });
  }
  return queues;
}
