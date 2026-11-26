// Per-player loadout and ownership. The Local Edition has no shop and no economy: every asset in the
// catalog generated from your own install is owned by everyone.
import { collection, save } from "./store.ts";
import { allEntries, catalog, defaultHero, defaultSkinFor } from "./catalog.ts";
import { nowIso } from "./http.ts";

type Loadout = {
  version: number; hero: string; skins: Record<string, string>; chromas: Record<string, string>;
  emotes: string[]; titles: string[]; slots: { Slot: string; Asset: string }[]; lobbyPlatform: string;
  clientProfile: Record<string, unknown>;
};
const db = collection("players", { byId: {} as Record<string, Loadout> });

export function loadoutOf(uid: string): Loadout {
  let l = db.byId[uid];
  if (!l) {
    const hero = defaultHero();
    l = db.byId[uid] = { version: 1, hero, skins: hero ? { [hero]: defaultSkinFor(hero) } : {}, chromas: {}, emotes: [], titles: [], slots: [], lobbyPlatform: "", clientProfile: {} };
    save("players");
  }
  return l;
}

export function changed(uid: string) { loadoutOf(uid).version++; save("players"); }

export function rememberHero(uid: string, hero: string, skin: string) {
  const l = loadoutOf(uid);
  if (hero) l.hero = hero;
  if (hero && skin) l.skins[hero] = skin;
  changed(uid);
}

export function personalization(uid: string) {
  const l = loadoutOf(uid);
  return {
    ID: uid, PlayerID: uid, Version: l.version, Token: `p-${uid}-${l.version}`, IsAnonymous: false,
    HeroCosmeticsBundlePreferences: { ...l.skins }, LuxeSkinChromaPreferences: { ...l.chromas },
    LobbyPlatformPreference: l.lobbyPlatform, EmoteIDs: [...l.emotes], TitleIDs: [...l.titles], SlotCosmeticsEntries: [...l.slots],
  };
}

/** Every spelling of every catalog asset, marked owned. */
export function inventory(uid: string) {
  const l = loadoutOf(uid);
  const ids = [...new Set(allEntries().flatMap((e) => e.ids))];
  return {
    PlayerID: uid, Version: l.version, ETag: `inv-${ids.length}-${l.version}`,
    AssetEntries: ids.map((AssetID) => ({ AssetID, IsFree: true, IsOwned: true, IsDefault: true, IsPremiumBenefit: false, EntitlementIDs: [], AdditionalDetails: {} })),
  };
}

export function heroesOut(uid: string) {
  const ids = catalog().heroes.flatMap((h) => h.ids);
  return { Heroes: ids, UnlockedHeroes: ids, PlayerID: uid, Version: loadoutOf(uid).version, Etag: `heroes-${ids.length}` };
}

/** The content manifest: every catalog entry enabled. */
export function contentManifest() {
  const c = catalog();
  const map = (list: typeof c.heroes) => Object.fromEntries(list.flatMap((e) => e.ids.map((id) => [id, {
    PrimaryAssetType: e.type, PrimaryAssetName: id.slice(e.type.length + 1), AssetPath: e.path, Status: "Enabled", IsDefault: true,
  }])));
  return {
    ID: "local", ETag: `manifest-${c.generatedAt}`, Version: 1, CurrentSeason: "", CurrentPatchVersion: "", PatchVersions: [],
    Heroes: map(c.heroes), HeroCosmeticsBundles: map(c.heroCosmetics), Emotes: map(c.emotes), PlayerTitles: map(c.titles),
    SlotCosmetics: map(c.slotCosmetics), LobbyPlatforms: map(c.lobbyPlatforms),
    Items: {}, Minions: {}, GameFeatures: {}, GameAugments: {}, Equipment: {}, Powers: {}, StoreOffers: {}, Missions: {}, MissionPools: {},
    ExchangeTokens: {}, Seasons: {}, Capsules: {}, LoginReward: {}, EventTrack: {}, HeroMastery: {}, ProgressionTracks: {}, ArmoryCraftOffers: {},
    LastUpdated: nowIso(),
  };
}
