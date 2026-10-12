// H3 Max references (Shawn's run 6, 2026-10-10): start/end storyboards as the
// first/last frame, every angle of each referenced character + other vault
// assets as "Image 1…9", wide sheets padded to fit 2.5:1, token cost priced.
import { resolveFramesRefSet, resolveFramesRefPrompt } from "../shared/prompts.js";
import { referenceUSD, videoModel } from "../server/rates.js";
import { padPlan, FalDriver } from "../server/drivers/fal.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const M = "minimax/h3-max/reference-to-video";
const ep = {
  assets: [
    { id: "ovl", type: "character", name: "Overlock Stitch", path: "a/ovl_turn.jpg", identityHold: "patchwork coat, dark bun with pins" },
    { id: "ovlf", type: "character", name: "Overlock Stitch", angle: "face closeups", path: "a/ovl_face.png", identityHold: "Keep this exact [character]: identical face, [wardrobe items]." },
    { id: "flm", type: "character", name: "Flame", path: "a/flm_turn.jpg" },
    { id: "flmf", type: "character", name: "Flame", angle: "face", path: "a/flm_face.png" },
    { id: "shop", type: "location", name: "Workshop day", path: "a/shop.jpg" },
    { id: "nopath", type: "prop", name: "Matchstick", path: "" },
  ],
};
const shot = {
  refs: ["ovl", "flm", "shop", "nopath"], move: "static", action: "Flame pulls the door open toward herself",
  beats: [
    { id: "b1", keyframe: true, role: "start", frame: { path: "sb/start.png", approved: true } },
    { id: "b2", keyframe: true, role: "end", frame: { path: "sb/end.png", approved: true } },
  ],
};
const set = resolveFramesRefSet(shot, ep);
check("every angle of each referenced character: turnaround then face", set.images.map((x) => x.assetId).join() === "ovl,ovlf,flm,flmf,shop", set.images.map((x) => x.assetId).join());
check("storyboards are NOT in the reference list (they are the start/end frames)", set.images.every((x) => !x.path.startsWith("sb/")));
check("assets without an image are skipped", !set.images.some((x) => x.assetId === "nopath"));
check("addressed as Image 1… (H3 wording)", set.images[0].ref === "Image 1" && set.images[4].ref === "Image 5");
check("capped at the model's limit", resolveFramesRefSet(shot, ep, 3).images.length === 3 && resolveFramesRefSet(shot, ep, 3).dropped === 2);
const pr = resolveFramesRefPrompt(shot, ep);
check("prompt opens with the image key", pr.text.startsWith("Image 1 is Overlock Stitch (character). Image 2 is Overlock Stitch — face closeups (character)."), pr.text.slice(0, 160));
check("…keeps identity holds and pins start AND end frame", pr.text.includes("patchwork coat, dark bun with pins") && pr.text.includes("opens exactly on the start image and ends exactly on the end image"));
check("…then the H3 brief (fal's guide shape)", pr.text.includes("Flame pulls the door open toward herself.") && pr.text.trim().endsWith("No music, no on-screen text."));
check("an unfilled template hold (\"[character]\") is never sent", !pr.text.includes("[character]") && !pr.text.includes("[wardrobe items]"));
const none = resolveFramesRefPrompt({ ...shot, refs: [] }, ep);
check("no references: still a valid prompt, no empty key", none.images.length === 0 && none.text.startsWith("The video opens exactly on the start image"));

console.log("\nimage padding (H3 refuses > 2.5:1)");
check("Overlock's 2048x768 sheet gets padded to 2.4:1", JSON.stringify(padPlan(2048, 768)) === JSON.stringify({ w: 1280, h: 480, padW: 1280, padH: 534 }), JSON.stringify(padPlan(2048, 768)));
check("a 2752x1536 turnaround needs nothing", padPlan(2752, 1536) === null);
check("a very tall image is padded sideways", padPlan(400, 1200).padW > 400 && padPlan(400, 1200).padH === 1200);

console.log("\nprice");
check("5 refs at 1280x720 = 4,500 tokens, 404 over the free 4,096 → under a cent", Math.abs(referenceUSD(M, Array(5).fill({})) - (5 * 900 - 4096) / 1000 * 0.02) < 1e-9);
check("2 refs fit inside the free tokens", referenceUSD(M, [{}, {}]) === 0);
check("model row: frames+refs, 768P, expansion balanced, fal-brief", videoModel(M).inputMode === "frames+refs" && videoModel(M).fixedParams.resolution === "768P" && videoModel(M).fixedParams.prompt_expansion_mode === "balanced" && videoModel(M).promptStyle === "fal-brief");

console.log("\nwhat the driver sends");
const d = new FalDriver(); d.key = "test";
const sent = [];
d.uploadFile = async (p) => `https://up/${p.split("/").pop()}`;
d.prepareKeyframe = async (p) => p;
d.prepareReference = async (p) => p;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ request_id: "r1" }) }; };
await d.generateVideo({ imagePath: "/x/start.png", endImagePath: "/x/end.png", referencePaths: ["/x/ovl.jpg", "/x/flm.jpg"], aspectRatio: "9:16", prompt: "P", seconds: 5.17, modelId: M });
globalThis.fetch = realFetch;
const b = sent[0].body;
check("posts to the H3 Max references endpoint", sent[0].url.endsWith("/minimax/h3-max/reference-to-video"));
check("start + end frame + reference_image_urls", b.image_url === "https://up/start.png" && b.end_image_url === "https://up/end.png" && b.reference_image_urls.join() === "https://up/ovl.jpg,https://up/flm.jpg");
check("duration as a number, 768P, expansion balanced, 9:16", b.duration === 5.17 && b.resolution === "768P" && b.prompt_expansion_mode === "balanced" && b.aspect_ratio === "9:16");

console.log(`\n${fail ? "✗" : "✓"} H3 Max references: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
