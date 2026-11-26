// Build the cosmetics/hero/map catalog from a list of package paths taken from the user's OWN install.
//
// Input: a text file with one packaged path per line (e.g. `Loki/Content/Loki/Maps/Foo/LVL_Foo.umap`),
// or a directory of files exported from the install with a tool of the user's choice. Both forms
// (`Loki/Content/...`, `/Game/...`, or a leading install folder) are accepted.
// Output: `<data>/generated/catalog.json`. Nothing here is uploaded anywhere.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** `ids` holds every candidate PrimaryAssetId. The real primary-asset name is authored inside the asset
 *  and is not always derivable from the file name, so ownership is granted to each plausible spelling
 *  (FName comparison in the engine is case-insensitive, so case never matters). */
export type Entry = { id: string; ids: string[]; type: string; name: string; path: string; hero?: string; slot?: string };
export type Catalog = {
  generatedAt: string; source: string;
  heroes: Entry[]; heroCosmetics: Entry[]; emotes: Entry[]; titles: Entry[];
  slotCosmetics: Entry[]; lobbyPlatforms: Entry[]; maps: Entry[];
};

export function readListing(input: string): string[] {
  const st = statSync(input);
  if (st.isFile()) return readFileSync(input, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(relative(input, p).replace(/\\/g, "/"));
    }
  };
  walk(input);
  return out;
}

/** Normalise any accepted form to `Loki/Content/<rest>` with forward slashes. */
export function normalise(p: string): string | null {
  let s = p.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const i = s.indexOf("Loki/Content/");
  if (i >= 0) return s.slice(i);
  if (s.startsWith("Game/")) return "Loki/Content/" + s.slice(5);
  return null;
}

const gamePath = (pkg: string) => {
  const noExt = pkg.replace(/\.(uasset|umap|json)$/i, "");
  const name = noExt.split("/").pop()!;
  return { name, objectPath: `${noExt.replace(/^Loki\/Content\//, "/Game/")}.${name}`, packagePath: noExt.replace(/^Loki\/Content\//, "/Game/") };
};

function spellings(core: string): string[] {
  const parts = core.split("_").filter(Boolean);
  const out = new Set([core, parts.join("")]);
  if (parts.length > 1) { out.add(parts.slice(0, -1).join("") + "_" + parts.at(-1)); out.add(parts[0] + "_" + parts.slice(1).join("")); }
  return [...out];
}

function entry(type: string, core: string, file: string, path: string, extra: Partial<Entry> = {}, prefix = ""): Entry {
  const names = spellings(core).map((n) => prefix + n);
  return { id: `${type}:${names[0]}`, ids: names.map((n) => `${type}:${n}`), type, name: names[0], path, ...extra, ...(file ? {} : {}) };
}

export function buildCatalog(lines: string[], source: string): Catalog {
  const c: Catalog = { generatedAt: new Date().toISOString(), source, heroes: [], heroCosmetics: [], emotes: [], titles: [], slotCosmetics: [], lobbyPlatforms: [], maps: [] };
  const seen = new Set<string>();
  const put = (list: Entry[], e: Entry) => { if (!seen.has(e.id)) { seen.add(e.id); list.push(e); } };
  const C = "Loki/Content/Loki/";
  for (const raw of lines) {
    const f = normalise(raw);
    if (!f || !/\.(uasset|umap|json)$/i.test(f)) continue;
    if (/\/(_Generated_|__ExternalActors__|__ExternalObjects__|HLOD)\//.test(f) || /_ExternalActors_|_ExternalObjects_/.test(f)) continue;
    const { name, objectPath, packagePath } = gamePath(f);
    const isBp = name.startsWith("BP_") || name.startsWith("DA_");
    if (f.startsWith(C + "Characters/Heroes/") && name.startsWith("BP_HeroAsset_")) {
      const core = name.slice("BP_HeroAsset_".length);
      put(c.heroes, entry("Hero", core, name, objectPath, { hero: core }));
    } else if (f.startsWith(C + "Characters/") && isBp && /Cosmetics?Bundle$/i.test(name)) {
      const hero = f.match(/Characters\/Heroes\/([^/]+)\//)?.[1];
      put(c.heroCosmetics, entry("HeroCosmeticsBundle", name.replace(/^(BP|DA)_/, "").replace(/_?Cosmetics?Bundle$/i, ""), name, objectPath, { hero }));
    } else if (f.startsWith(C + "Personalization/Emotes/") && /^(BP|DA)_Emote_/.test(name)) {
      put(c.emotes, entry("Emote", name.replace(/^(BP|DA)_Emote_/, ""), name, objectPath));
    } else if (f.startsWith(C + "Personalization/") && /^BP_PlayerT[iI]tle_/.test(name)) {
      put(c.titles, entry("PlayerTitle", name.replace(/^BP_PlayerT[iI]tle_/, ""), name, objectPath));
    } else if (f.startsWith(C + "Personalization/") && /^BP_(Avatar|Glider|Wisp|Callsign|Spray|Deathbox|Finisher|Banner)_/i.test(name)) {
      const slot = name.split("_")[1];
      const e = entry("SlotCosmetics", name.replace(/^BP_[^_]+_/, ""), name, objectPath, { slot }, `${slot.toUpperCase()}_`);
      e.ids.push(...e.ids.map((id) => id.replace(`:${slot.toUpperCase()}_`, `:${slot.toUpperCase()}_${slot}_`)));
      put(c.slotCosmetics, e);
    } else if (f.startsWith(C + "Personalization/") && isBp && /LobbyPlatform/i.test(name)) {
      put(c.lobbyPlatforms, entry("LobbyPlatform", name.replace(/^(BP|DA)_/, ""), name, objectPath));
    } else if (f.startsWith(C + "Maps/") && /\.umap$/i.test(f) && name.startsWith("LVL_")) {
      put(c.maps, { id: `Map:${packagePath}`, ids: [`Map:${packagePath}`], type: "Map", name, path: packagePath });
    }
  }
  return c;
}
