/** Real 2.0.4 hero pawn blueprints (from data/204/all-packages-204.txt). */
export const HERO_BPS: Array<{ id: string; pkg: string; cls: string }> = [
  "Alchemist", "Assault", "BacklineHealer", "Beebo", "BountyHunter", "BurstCaster", "Earthtank",
  "FarShot", "FireFox", "Flex", "Freeze", "Gunner", "HookGuy", "Huntress", "Reaper", "ResHealer",
  "RocketJumper", "Ronin", "ShieldBot", "Sniper", "Stalker", "Storm", "Succubus", "Void", "Wukong",
].map((id) => {
  const bp = ["HookGuy", "Stalker", "Storm"].includes(id) ? `BP_Hero_${id}` : `BP_HERO_${id}`;
  return { id, pkg: `/Game/Loki/Characters/Heroes/${id}/${bp}`, cls: `${bp}_C` };
});

export const DEFAULT_HERO = HERO_BPS.find((h) => h.id === "Assault")!;

/** Resolve "Hero:assault", an asset path, or a bare name to a hero blueprint. */
export function heroBlueprint(heroId: string | undefined): { id: string; pkg: string; cls: string; index: number } {
  const key = String(heroId || "").toLowerCase();
  let index = HERO_BPS.findIndex((h) => key.includes(`/heroes/${h.id.toLowerCase()}/`));
  if (index < 0) {
    const bare = key.replace(/^hero:/, "").replace(/^bp_heroasset_/, "").split(/[./]/).pop() || "";
    index = HERO_BPS.findIndex((h) => h.id.toLowerCase() === bare);
  }
  if (index < 0) index = HERO_BPS.indexOf(DEFAULT_HERO);
  return { ...HERO_BPS[index]!, index };
}

export const PLAYER_STATE_BP = { pkg: "/Game/Loki/Core/GameModes/BP_LokiPlayerState", cls: "BP_LokiPlayerState_C" };
export const PLAYER_CONTROLLER_BP = { pkg: "/Game/Loki/Core/Player/Controller/BP_LokiPlayerController", cls: "BP_LokiPlayerController_C" };
