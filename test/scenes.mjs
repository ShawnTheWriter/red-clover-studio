// Scene/shot renumbering tools (Sept 2026) — moveShotToScene and
// shiftSceneNumbers. Both mutate a plain episode object in memory; no
// server, no disk, no fixtures needed.

import { newEpisode, newShot, newScene, newAsset, normalizeTags, moveShotToScene, shiftSceneNumbers } from "../shared/schema.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const throws = (name, fn) => {
  try { fn(); fail++; console.log(`  ✗ ${name}\n      expected to throw, didn't`); }
  catch (e) { pass++; console.log(`  ✓ ${name} (${e.message})`); }
};

function codes(ep) { return ep.shots.map((s) => `${s.sceneNum}${s.shotCode}`); }

console.log("\nMOVE SHOT TO SCENE — Shawn's actual case (a lone '1a' really belongs inside scene 2)");
{
  const ep = newEpisode({
    name: "Test", dir: "Test",
    scenes: [
      newScene({ number: "1", heading: "(no slugline)" }),
      newScene({ number: "2", heading: "INT. A Secret Workshop - DAY", intext: "INT.", loc: "A Secret Workshop", time: "DAY" }),
      newScene({ number: "3", heading: "INT. Hut - NIGHT" }),
    ],
    shots: [
      newShot({ sceneNum: "1", shotCode: "a", label: "establishing, she sleeps", loc: "" }),
      newShot({ sceneNum: "2", shotCode: "a", label: "flies in window" }),
      newShot({ sceneNum: "2", shotCode: "b", label: "stirs under blanket" }),
      newShot({ sceneNum: "3", shotCode: "a", label: "boot kicks door" }),
    ],
  });
  const oneA = ep.shots.find((s) => s.sceneNum === "1");
  moveShotToScene(ep, oneA.id, "2", "start");
  check("moved shot now carries scene 2's sceneNum", oneA.sceneNum === "2");
  check("landed at the START of scene 2 (array order)", codes(ep).slice(0, 3).join(",") === "2a,2b,2c", codes(ep).join(","));
  check("what was 2a/2b re-lettered to 2b/2c", ep.shots.find((s) => s.label === "flies in window").shotCode === "b");
  check("slugline fields synced from the target scene", oneA.loc === "A Secret Workshop" && oneA.intext === "INT." && oneA.time === "DAY");
  check("scene 1 now has zero shots (safe to retire)", !ep.shots.some((s) => s.sceneNum === "1"));

  // Now close the gap left behind: scene 2-> 1, 3 -> 2.
  ep.scenes = ep.scenes.filter((sc) => sc.number !== "1"); // Shawn deletes the now-empty placeholder himself
  const result = shiftSceneNumbers(ep, 2, -1);
  check("shift reports 2 scenes affected (2 and 3)", result.shifted === 2, JSON.stringify(result));
  check("old scene 2's shots are now scene 1", ep.shots.filter((s) => s.sceneNum === "1").length === 3);
  check("old scene 3's shot is now scene 2", ep.shots.find((s) => s.label === "boot kicks door").sceneNum === "2");
  check("ep.scenes numbers shifted too", ep.scenes.map((sc) => sc.number).sort().join(",") === "1,2");
  check("final sequence reads 1a,1b,1c,2a", codes(ep).join(",") === "1a,1b,1c,2a", codes(ep).join(","));
}

console.log("\nMOVE SHOT TO SCENE — edge cases");
{
  const ep = newEpisode({
    name: "T2", dir: "T2",
    shots: [
      newShot({ sceneNum: "1", shotCode: "a", label: "1a" }),
      newShot({ sceneNum: "2", shotCode: "a", label: "2a" }),
      newShot({ sceneNum: "2", shotCode: "b", label: "2b" }),
    ],
  });
  const s1a = ep.shots.find((s) => s.label === "1a");
  moveShotToScene(ep, s1a.id, "2", "end");
  check("position 'end' lands after the target scene's last shot", codes(ep).join(",") === "2a,2b,2c", codes(ep).join(","));

  throws("moving a shot into the scene it's already in is refused", () => {
    const s2a = ep.shots.find((s) => s.label === "2a");
    moveShotToScene(ep, s2a.id, s2a.sceneNum);
  });

  const ep2 = newEpisode({
    name: "T3", dir: "T3",
    shots: [
      newShot({ sceneNum: "1", shotCode: "a" }),
      newShot({ sceneNum: "5", shotCode: "a" }),
    ],
  });
  const shot1 = ep2.shots.find((s) => s.sceneNum === "1");
  moveShotToScene(ep2, shot1.id, "3"); // scene 3 doesn't exist yet, no shots there
  check("moving into a scene with no shots yet still keeps ascending order",
    ep2.shots.map((s) => s.sceneNum).join(",") === "3,5",
    ep2.shots.map((s) => s.sceneNum).join(","));
}

console.log("\nSHIFT SCENE NUMBERS — safety rails");
{
  const ep = newEpisode({
    name: "T4", dir: "T4",
    shots: [
      newShot({ sceneNum: "1", shotCode: "a" }),
      newShot({ sceneNum: "2", shotCode: "a" }),
    ],
  });
  throws("shifting down onto an OCCUPIED, non-participating scene is refused", () => {
    shiftSceneNumbers(ep, 2, -1); // would land scene 2's shot on scene 1, which still has content
  });
  check("the refused shift left the data untouched", ep.shots.map((s) => s.sceneNum).join(",") === "1,2");

  throws("delta of 0 is refused", () => shiftSceneNumbers(ep, 1, 0));
  throws("a non-integer delta is refused", () => shiftSceneNumbers(ep, 1, 1.5));
  throws("a non-numeric fromSceneNum is refused", () => shiftSceneNumbers(ep, "3A", -1));
  throws("shifting from a scene number nothing occupies is refused", () => shiftSceneNumbers(ep, 99, -1));

  const up = newEpisode({
    name: "T5", dir: "T5",
    shots: [
      newShot({ sceneNum: "3", shotCode: "a" }),
      newShot({ sceneNum: "4", shotCode: "a" }),
    ],
  });
  shiftSceneNumbers(up, 4, 1); // open a slot at 4 for new content, pushing the old 4 to 5
  check("shifting UP always succeeds (nothing to collide with above the range)",
    up.shots.map((s) => s.sceneNum).join(",") === "3,5", up.shots.map((s) => s.sceneNum).join(","));
}

console.log("\nASSET TAGS — organizing labels for the Identity Vault");
{
  check("tags are trimmed, blank-dropped and de-duplicated case-insensitively (first spelling wins)",
    normalizeTags([" Workshop ", "workshop", "", "Heist crew", null]).join("|") === "Workshop|Heist crew");
  check("non-array input becomes an empty list, not a crash", normalizeTags("nope").length === 0 && normalizeTags(undefined).length === 0);
  check("an asset saved before tags existed backfills to []", Array.isArray(newAsset({ name: "Old" }).tags) && newAsset({ name: "Old" }).tags.length === 0);
  check("newAsset keeps and normalizes supplied tags", newAsset({ tags: ["A", "a", "B"] }).tags.join(",") === "A,B");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} scene tools: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
