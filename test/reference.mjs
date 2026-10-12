// Reference mode (Seedance omni-reference) — the image set, the @Image prompt,
// pricing, and the fan-out path. Scratch episode in a temp root, mock driver:
// no network, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-reference-"));
process.env.RCS_PROJECT_ROOT = ROOT;

const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const { VIDEO_MODELS, videoModel } = await import("../server/rates.js");
const { newEpisode, newShot, newBeat, newAsset } = await import("../shared/schema.js");
const { resolveReferenceSet, resolveReferencePrompt, resolveVideoPrompt, MAX_REFERENCE_IMAGES } = await import("../shared/prompts.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const REF = "bytedance/seedance-2.5/reference-to-video";
const I2V = "bytedance/seedance-2.5/image-to-video";

// Shot 6c's shape: three approved storyboards and two character assets.
const frame = (n, approved = true) => ({ path: `Ep/03_storyboard/f${n}.png`, approved });
const beat = (role, n, desc, approved = true) => newBeat({ role, keyframe: true, desc, frame: frame(n, approved) });
const assets = [
  newAsset({ id: "A1", type: "character", name: "Overlock Stitch", path: "Ep/02_assets/overlock.png", identityHold: "Keep this exact Overlock." }),
  newAsset({ id: "A2", type: "character", name: "Flame", path: "Ep/02_assets/flame.png" }),
  newAsset({ id: "A3", type: "location", name: "Workshop door", path: "" }),  // no image file yet
];
const mkShot = (over = {}) => newShot({
  id: "S6c", sceneNum: "6", shotCode: "c", move: "handheld", refs: ["A1", "A2", "A3"],
  action: "Overlock: \"I'm coming, I'm coming.\" She walks towards the door and eases it open.",
  beats: [beat("start", 1, "Standing at the door"), beat("mid", 2, "Door opens, Flame revealed"), beat("mid", 3, "Flame steps across")],
  ...over,
});
const ep = newEpisode({ name: "Ep", dir: "Ep", fmt: "9:16", assets, shots: [mkShot()] });

console.log("\nREFERENCE SET — every approved storyboard, then the assets");
{
  const { images, dropped } = resolveReferenceSet(ep.shots[0], ep);
  check("3 storyboards + 2 assets with files = 5 images (an asset with no file is skipped)", images.length === 5 && dropped === 0, String(images.length));
  check("storyboards come first, in beat order", images.slice(0, 3).every((x) => x.kind === "storyboard") && images[0].path.endsWith("f1.png") && images[2].path.endsWith("f3.png"));
  check("assets follow as identity anchors", images[3].label === "Overlock Stitch (character)" && images[4].label === "Flame (character)");
  check("images are numbered @Image1…@Image5", images.map((x) => x.ref).join(",") === "@Image1,@Image2,@Image3,@Image4,@Image5");
  const s2 = mkShot({ beats: [beat("start", 1, "a"), beat("mid", 2, "b", false)] });
  check("an UNAPPROVED storyboard is never sent", resolveReferenceSet(s2, ep).images.filter((x) => x.kind === "storyboard").length === 1);
  const dup = mkShot({ beats: [beat("start", 1, "a"), beat("mid", 1, "same file")] });
  check("the same file twice is sent once", resolveReferenceSet(dup, ep).images.filter((x) => x.kind === "storyboard").length === 1);
  const longB = mkShot({ beats: [beat("start", 1, "Standing on the other side, chewing a matchstick, is Flame. They stare at each other in silence for a long moment")] });
  const lbl = resolveReferenceSet(longB, ep).images[0].label;
  check("a long storyboard description is cut at a word boundary with an ellipsis, never mid-word", /silence…$/.test(lbl) || /\S…$/.test(lbl) && !/ in si…$/.test(lbl), lbl);
  const many = mkShot({ beats: Array.from({ length: 14 }, (_, i) => beat("mid", 100 + i, `b${i}`)) });
  const r = resolveReferenceSet(many, ep);
  check(`capped at ${MAX_REFERENCE_IMAGES}, and the overflow is reported`, r.images.length === MAX_REFERENCE_IMAGES && r.dropped === 14 + 2 - MAX_REFERENCE_IMAGES, JSON.stringify([r.images.length, r.dropped]));
  check("storyboards win the cap over assets", r.images.every((x) => x.kind === "storyboard"));
}

console.log("\nREFERENCE PROMPT — shown text == sent text");
{
  const r = resolveReferencePrompt(ep.shots[0], ep);
  check("opens with the @Image map", r.text.startsWith("Reference images:\n@Image1 = storyboard 1 of 3 (start)"));
  check("names every image", ["@Image4 = Overlock Stitch (character)", "@Image5 = Flame (character)"].every((l) => r.text.includes(l)));
  check("tells the model to use the storyboards as ordered key positions", /storyboard frames \(@Image1, @Image2, @Image3\) as the key positions/.test(r.text));
  check("asks for one continuous take, no cuts or jumps between the frames (the 6c 'skip' at ~6s)", /ONE continuous, unbroken take.*no cuts, jumps or skipped moments/.test(r.text));
  check("appends the asset's own identity-hold wording verbatim", r.text.includes("Keep this exact Overlock."));
  check("still carries the shot's own direction, dialogue and camera", r.text.includes("I'm coming, I'm coming.") && r.text.includes("Camera:"), r.text.slice(-200));
  const tc = mkShot(); tc.videoPromptMode = "timecoded"; // newShot() doesn't carry this field through
  const t = resolveReferencePrompt(tc, ep).text;
  check("timecoded mode doesn't duplicate an old 'Asset map:' block", !/Asset map:/.test(t) && /\[00:00-/.test(t));
  check("the plain video prompt is unchanged for frame models", !/Reference images:/.test(resolveVideoPrompt(ep.shots[0], ep).text));
}

console.log("\nMODEL TABLE + PRICING");
{
  check("the reference model is registered as inputMode 'reference' with no start/end fields", videoModel(REF).inputMode === "reference" && !videoModel(REF).imageParams);
  const DRAFT = "bytedance/seedance-2.5/reference-to-video:draft480";
  const H3REF = "minimax/h3-max/reference-to-video";
  check("every Frames row is a frames model; every References row is reference or frames+refs", VIDEO_MODELS.every((m) => m.mode === "refs" ? ["reference", "frames+refs"].includes(m.inputMode) : (m.inputMode || "frames") === "frames"));
  check("the hand-written reference rows are References rows", [REF, DRAFT, H3REF].every((id) => videoModel(id).mode === "refs"));
  check("H3 Max references keeps start/end frames AND takes references", videoModel(H3REF).inputMode === "frames+refs" && videoModel(H3REF).imageParams.length === 2 && videoModel(H3REF).maxRefs === 9);
  check("the 480p draft row calls the SAME fal endpoint as the reference model", videoModel(DRAFT).endpoint === REF && videoModel(DRAFT).inputMode === "reference");
  check("…with draft:true and resolution 480p as fixed params", videoModel(DRAFT).fixedParams.draft === true && videoModel(DRAFT).fixedParams.resolution === "480p");
  check("…priced under half the 720p reference rate (uncalibrated)", videoModel(DRAFT).usdPerVideoSecond < videoModel(REF).usdPerVideoSecond / 2 && videoModel(DRAFT).confidence === "uncalibrated");
  check("480p tokens/s x $0.0214/1k is ~$0.206/s and the ceiling covers it", videoModel(DRAFT).usdPerVideoSecond >= (480 * 854 * 24 / 1024) * 0.0214 / 1000);
  check("only the real (non-preset) model ids are fal endpoints; presets name theirs", VIDEO_MODELS.filter((m) => m.endpoint).every((m) => m.id.startsWith(m.endpoint)));
  check("Seedance 2.5 (i2v) is $0.466/s — Shawn's real 5s take cost $2.33; the old $0.20 was a guess",
    videoModel(I2V).usdPerVideoSecond === 0.466 && videoModel(I2V).confidence === "measured" && Math.abs(videoModel(I2V).usdPerVideoSecond * 5 - 2.33) < 0.005);
  check("Seedance 2.0 Fast is $0.244/s — measured on a real 5 s take (usage CSV 2026-10-08)", videoModel("bytedance/seedance-2.0/fast/image-to-video").usdPerVideoSecond === 0.244);
  check("the reference model prices at $0.50/s and is flagged uncalibrated", videoModel(REF).usdPerVideoSecond === 0.5 && videoModel(REF).confidence === "uncalibrated");
  check("it offers 5-30s takes", videoModel(REF).durations[0] === 5 && videoModel(REF).durations.at(-1) === 30);
  // fal's own published number, reproduced by the formula the rate was derived from
  check("the token formula reproduces fal's published 2.0-Fast price ($0.2419/s)", Math.abs((1280 * 720 * 24 / 1024) * 0.0112 / 1000 - 0.2419) < 0.0001);
}

console.log("\nFAN-OUT — the take carries a frozen reference set");
{
  jobs.drivers.mock.billable = false; // rehearsal
  jobs.drivers.mock.latencyMs = 200;
  await store.scaffold("Ep");
  await store.saveEpisode("Ep", ep);
  const q = jobs.quote(await store.loadEpisode("Ep"), { shotIds: ["S6c"], modelIds: [REF], seconds: 8 });
  check("an 8s reference take quotes $4.00", q.totalUSD === 4 && q.uncalibrated.some((l) => l.startsWith("Seedance 2.5 — references")), JSON.stringify([q.totalUSD, q.uncalibrated]));

  const { versions } = await jobs.submitFanOut("Ep", { shotIds: ["S6c"], modelIds: [REF, I2V], seconds: 8, driver: "mock", confirmedUSD: q.totalUSD + jobs.quote(await store.loadEpisode("Ep"), { shotIds: ["S6c"], modelIds: [I2V], seconds: 8 }).totalUSD });
  const vr = versions.find((v) => v.modelId === REF), vf = versions.find((v) => v.modelId === I2V);
  check("the reference take stores all 5 image paths", vr.referencePaths.length === 5 && vr.referencePaths[3].endsWith("overlock.png"));
  check("…and the exact prompt that will be sent, frozen", vr.referencePrompt.startsWith("Reference images:") && vr.referencePrompt.includes("@Image5 = Flame"));
  check("…and labelled refs for the UI", vr.referenceLabels.length === 5 && vr.referenceLabels[0].ref === "@Image1");
  check("a frames model in the SAME batch gets none of that", vf.referencePaths === undefined && vf.referencePrompt === undefined);
  check("both are queued (the shot is boarded and has a move)", vr.state === "queued" && vf.state === "queued", JSON.stringify([vr.state, vf.state]));

  // A shot with no approved storyboard is blocked, not sent with nothing.
  const bare = mkShot({ id: "SB", shotCode: "z", beats: [beat("start", 9, "x", false)] });
  await store.withEpisode("Ep", (e) => { e.shots.push(bare); });
  const { versions: v2 } = await jobs.submitFanOut("Ep", { shotIds: ["SB"], modelIds: [REF], seconds: 5, driver: "mock", confirmedUSD: 2.5 });
  check("no approved storyboard = blocked with a reason, nothing submitted", v2[0].state === "error" && /approved keyframe/.test(v2[0].error), JSON.stringify(v2[0].error));

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const e = await store.loadEpisode("Ep");
    if (e.shots[0].versions.every((v) => v.state === "done" || v.state === "error")) break;
  }
  const e3 = await store.loadEpisode("Ep");
  const done = e3.shots[0].versions.find((v) => v.modelId === REF);
  check("the reference take runs to done through the queue", done.state === "done" && !!done.path, JSON.stringify([done.state, done.error]));
}

await fs.rm(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✓" : "✗"} reference mode: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
