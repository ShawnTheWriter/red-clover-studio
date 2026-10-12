// H3 Max prompts follow fal's guide (fal.ai/learn/tools/how-to-use-minimax-h3-max):
// motion, what to keep from the still, quoted dialogue with delivery, concrete
// sound, "No music, no on-screen text." And the generic models stay as before.
import { buildFalBrief, resolveVideoPrompt, shotPrompts, buildDirection } from "../shared/prompts.js";
import { videoModel, H3MAX_PROMO_ENDS } from "../server/rates.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const ep = { assets: [{ id: "ovl", type: "character", name: "Overlock Stitch" }] };
const frame = (p) => ({ path: p, approved: true });
const shot = {
  action: "Overlock pulls the heavy door inward and stops, holding its edge",
  move: "static", audio: "a creaking door, rain outside",
  beats: [
    { id: "b1", keyframe: true, role: "start", frame: frame("a.png") },
    { id: "b2", keyframe: true, role: "end", frame: frame("b.png"), dialogue: { charId: "ovl", line: "What do YOU want?", delivery: "resigned, tired" } },
  ],
};
const t = buildFalBrief(shot, ep);
check("starts with the action", t.startsWith("Overlock pulls the heavy door inward and stops, holding its edge."), t);
check("dialogue in double quotes with its delivery", t.includes('Overlock Stitch says, resigned, tired: "What do YOU want?"'), t);
check("names what to keep, start AND end frame", t.includes("exactly as they are in the start frame, and end on the end frame's composition; keep the camera locked off throughout."), t);
check("concrete sound, said once", t.includes("Sound: a creaking door, rain outside.") && t.split(/no music/i).length === 2, t);
check("closes with no music, no on-screen text", t.endsWith("No music, no on-screen text."), t);

const one = buildFalBrief({ ...shot, move: "push", beats: [shot.beats[0]], audio: "" }, ep);
check("single still + a camera move", one.includes("exactly as they are in the still; the camera makes a slow push-in."), one);
check("no sound field: no empty Sound line", !one.includes("Sound:"), one);
check("music on the shot: no 'no music'", buildFalBrief({ ...shot, music: "a low cello" }, ep).endsWith("No on-screen text."));

check("resolver: fal-brief style gives the brief", resolveVideoPrompt(shot, ep, { style: "fal-brief" }).text === t);
check("resolver: no style = the generic shot direction (other models unchanged)", resolveVideoPrompt(shot, ep).text === buildDirection(shot, ep));
const hand = { ...shot, videoPromptOverride: "My own words." };
check("a hand-edited prompt still wins for H3 Max", resolveVideoPrompt(hand, ep, { style: "fal-brief" }).text === "My own words.");
const sp = shotPrompts(shot, ep, { style: "fal-brief" });
check("shown == sent: the Video prompt box shows the brief", sp.direction === t && sp.videoSent === t);

const m = videoModel("minimax/h3-max/image-to-video");
check("H3 Max sends prompt expansion 'balanced' (fal's recommended setting)", m.fixedParams.prompt_expansion_mode === "balanced");
check("H3 Max uses the fal-brief style", m.promptStyle === "fal-brief");
check("price follows fal's promo date", m.usdPerVideoSecond === (Date.now() < H3MAX_PROMO_ENDS ? 0.048 : 0.08));

{
  const hh = buildFalBrief({ move: "handheld", action: "Guards stride in.", beats: [] }, { assets: [] });
  check("handheld reads as a camera style, not 'makes a handheld'", /camera is handheld/.test(hh) && !/makes a handheld/.test(hh), hh);
}
console.log(`\n${fail ? "✗" : "✓"} H3 Max prompts: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
