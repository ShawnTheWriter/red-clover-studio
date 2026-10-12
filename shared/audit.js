// The new-asset audit (gate G2) — reference/series-pm.md calls this "the real
// per-episode budget driver": diff what an episode's scenes actually need
// against the series bible's approved registry. Standing assets cost nothing
// marginal; new ones are the true cost of the episode and the thing worth
// pushing back on at G1 if there are too many.

// Normalize a name for matching across sources that will never agree on case
// or whitespace: script extraction, the series registry, and a human typing
// into the vault.
// Registry names get typed by a human (straight quotes); script extraction
// keeps whatever the writer's tool produced (curly quotes, from Final Draft).
// Fold both to the same form before comparing, or "Li's Bathroom" typed by
// Shawn will never match "Li’s Bathroom" pulled from the .fdx.
const norm = (s) => (s || "").trim().toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+/g, " ");

// Indexes both an asset's canonical name and any aliases it's been given
// ("Serge" -> the "Serge Stitch" registry asset) — a script name landing on
// either counts as standing, not a new-asset false positive.
function registryIndex(registry, type) {
  const idx = new Map();
  for (const a of registry || []) {
    if (a.type !== type) continue;
    idx.set(norm(a.name), a);
    for (const alias of a.aliases || []) idx.set(norm(alias), a);
  }
  return idx;
}

// Collect every character/extra/location/prop a set of scenes calls for,
// deduped, with the scene numbers that reference each — so a "new" item in
// the audit can be traced back to where it's needed.
function collectNeeds(scenes) {
  const need = { character: new Map(), location: new Map(), prop: new Map() };
  const touch = (bucket, name, sceneNumber) => {
    const key = norm(name);
    if (!key) return;
    if (!bucket.has(key)) bucket.set(key, { name, scenes: [] });
    bucket.get(key).scenes.push(sceneNumber);
  };
  for (const s of scenes) {
    (s.characters || []).forEach((c) => touch(need.character, c, s.number));
    (s.extras || []).forEach((c) => touch(need.character, c, s.number));
    (s.props || []).forEach((p) => touch(need.prop, p, s.number));
    if (s.loc) touch(need.location, s.loc, s.number);
  }
  return need;
}

// registry: the series' approved asset list (schema `newAsset[]`, filtered to
// `seriesCanon`). scenes: the episode's parsed/edited scene list.
export function newAssetAudit(scenes, registry) {
  const need = collectNeeds(scenes);
  const idxByType = {
    character: registryIndex(registry, "character"),
    location: registryIndex(registry, "location"),
    prop: registryIndex(registry, "prop"),
  };

  const result = { standing: [], new: [], byType: { character: [], location: [], prop: [] } };
  for (const type of ["character", "location", "prop"]) {
    for (const [key, hit] of need[type]) {
      const approved = idxByType[type].get(key);
      const row = { type, name: hit.name, scenes: [...new Set(hit.scenes)] };
      if (approved) {
        row.status = "standing";
        row.assetId = approved.id;
        result.standing.push(row);
      } else {
        row.status = "new";
        result.new.push(row);
      }
      result.byType[type].push(row);
    }
  }
  result.summary = {
    standing: result.standing.length,
    new: result.new.length,
    newByType: {
      character: result.byType.character.filter((r) => r.status === "new").length,
      location: result.byType.location.filter((r) => r.status === "new").length,
      prop: result.byType.prop.filter((r) => r.status === "new").length,
    },
  };
  return result;
}

// Images that probably already depict an audit row, so a waived or new item
// can be judged by eye instead of by name alone. Script names rarely match
// asset names exactly — the .fdx says "Serge" and "A Secret Workshop", the
// episode's assets are "Serge Stitch" and "Secret Workshop — day master" —
// so match on words, not strings: every word of the script name (minus
// articles) must appear in the asset's name. Same type only, and only assets
// that actually have an image.
const STOP = new Set(["a", "an", "the"]);
const words = (s) => norm(s).replace(/'s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

export function matchAssetImages(row, assets) {
  const want = words(row.name);
  if (!want.length) return [];
  return (assets || [])
    .filter((a) => a.type === row.type && a.path)
    .filter((a) => { const have = new Set(words(a.name)); return want.every((w) => have.has(w)); })
    .map((a) => ({ id: a.id, name: a.name, path: a.path }));
}
