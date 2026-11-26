// Gate: every hunter in the kit table resolves to ability rows; FireFox's measured grant is present.
import * as Gas from "../../../match/gas.ts";
import { T } from "../t.ts";
const t = new T("kits");
const heroes = ["Alchemist", "Assault", "BacklineHealer", "Beebo", "BountyHunter", "BurstCaster", "Earthtank", "FarShot", "FireFox", "Flex", "Freeze", "Gunner", "HookGuy", "Huntress", "Reaper", "ResHealer", "RocketJumper", "Ronin", "ShieldBot", "Sniper", "Stalker", "Storm", "Succubus", "Void", "Wukong"];
for (const h of heroes) {
  const kit = Gas.heroGrants(h);
  t.ok(`${h}: kit has rows`, kit.length > 0);
  t.ok(`${h}: every row has a class, package and input id`, kit.every((r) => r.cls && r.pkg.startsWith("/Game/") && Number.isFinite(r.inputId)));
}
t.ok("Ronin LMB = 4 light attacks + selector", Gas.lmbGrants("Ronin").length === 5);
t.ok("FireFox measured grant has 34 specs", Gas.retailFireFoxGrants().length === 34);
t.done();
