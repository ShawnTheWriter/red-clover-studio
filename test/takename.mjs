// Take file names (Shawn, 2026-10-08): <shot>_<slug>_<model code>_<id>.mp4,
// readable in Finder, version id last so the cut reader and Organize still
// match files to takes.
import { takeFileName, slugForFile } from "../server/jobs.js";
import { modelShort } from "../server/rates.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const shot2a = { sceneNum: "2", shotCode: "a", intext: "EXT.", loc: "Village", time: "NIGHT" };
const v = { id: "muzzlobl20y19", modelId: "minimax/h3-max/image-to-video", modelLabel: "MiniMax H3 Max (768P)" };
const n = takeFileName(shot2a, v);
check("2a H3 Max reads as Shawn approved", n === "2a_EXT-Village-Night_H3Max768_muzzlobl20y19.mp4", n);
check("version id stays last (cut reader + Organize match on it)", /_muzzlobl20y19\.mp4$/.test(n));
check("possessive stray 'S dropped", slugForFile({ intext: "INT.", loc: "Overlocks'S Hut", time: "NIGHT" }) === "INT-Overlocks-Hut-Night");
check("INSERT shots keep their tag", slugForFile({ intext: "INSERT", loc: "Overlocks'S Hut", time: "NIGHT" }) === "INSERT-Overlocks-Hut-Night");
const long = slugForFile({ intext: "EXT.", loc: "The Very Long Abandoned Railway Station Platform", time: "CONTINUOUS" });
check("long slugs cut at a word, ≤ 32 chars", long.length <= 32 && !long.endsWith("-") && long.startsWith("EXT-The-Very"), long);
check("no location: no empty slug segment", takeFileName({ sceneNum: "1", shotCode: "b", intext: "", loc: "", time: "" }, v) === "1b_H3Max768_muzzlobl20y19.mp4");
check("no shot: 'take' prefix", takeFileName(null, v) === "take_H3Max768_muzzlobl20y19.mp4");
check("Seedance 2.5 code", modelShort("bytedance/seedance-2.5/image-to-video") === "SD25");
check("lip sync code", modelShort("fal-ai/sync-lipsync/v3") === "LipSync3");
check("unknown model falls back to a cleaned label", modelShort("new/model", "Veo 4 (beta)") === "Veo4beta");
check("only filename-safe characters", /^[A-Za-z0-9_.-]+$/.test(takeFileName({ sceneNum: "3", shotCode: "a", intext: "EXT.", loc: "Café / Bar", time: "DAY" }, v)));

console.log(`\n${fail ? "✗" : "✓"} take file names: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
