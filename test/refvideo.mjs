// Blocking opt-in and reference videos in the prompt package.
const { blockingSentence } = await import("../shared/blocking.js");
const { refVideoSet, resolveFramesRefPrompt, resolveReferencePrompt, resolveVideoPrompt } = await import("../shared/prompts.js");
const { newShot, newEpisode } = await import("../shared/schema.js");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`); };

// Camera below the pair, looking up the diagram: Jack (left) is screen-left.
const blk = { chars: [{ key: "j", name: "Jack", x: 0.3, y: 0.4 }, { key: "s", name: "Serge", x: 0.7, y: 0.65 }], camera: { x: 0.5, y: 0.95 } };
const sent = blockingSentence(blk);
check("screen sides from the camera's view", /Jack screen-left/.test(sent) && /Serge screen-right/.test(sent), sent);
check("nearer character named", /Serge nearest the camera/.test(sent), sent);
const flipped = blockingSentence({ ...blk, camera: { x: 0.5, y: 0.0 } });
check("camera on the other side flips the sides", /Serge screen-left/.test(flipped) && /Jack screen-right/.test(flipped), flipped);
check("no camera, no sentence", blockingSentence({ chars: blk.chars }) === "");

const ep = newEpisode({ name: "t" });
const shot = newShot({ sceneNum: "1", shotCode: "a", action: "Jack crouches.", move: "static" });
shot.blocking = blk;
check("blocking stays out of the prompt by default", !/Blocking:/.test(resolveVideoPrompt(shot, ep).text));
shot.blockingInPrompt = true;
check("blocking joins the prompt when the shot opts in", /Blocking: Jack screen-left/.test(resolveVideoPrompt(shot, ep).text));

const H3 = { param: "reference_video_urls", max: 3, minSec: 2, maxSec: 15, totalSec: 15 };
shot.refVideos = [
  { id: "a", path: "x/a.mp4", label: "Blender previs", seconds: 6, use: true },
  { id: "b", path: "x/b.mp4", label: "off", seconds: 4, use: false },
  { id: "c", path: "x/c.mp4", label: "too long", seconds: 12, use: true },
];
const set = refVideoSet(shot, H3);
check("only switched-on clips, within limits", set.videos.map((v) => v.id).join() === "a", JSON.stringify(set.videos.map((v) => v.id)));
check("the over-limit clip is reported", set.skipped.some((s) => s.v.id === "c" && /combined/.test(s.why)));
check("a model without reference video takes none", refVideoSet(shot, null).videos.length === 0);

const fr = resolveFramesRefPrompt(shot, ep, { max: 9, videos: set.videos });
check("H3 prompt names Video 1 as motion only", /Video 1 is Blender previs/.test(fr.text) && /camera movement, staging and timing only/.test(fr.text), fr.text.slice(0, 200));
const sd = resolveReferencePrompt(shot, ep, { videos: set.videos });
check("Seedance prompt lists @Video1", /@Video1 = Blender previs/.test(sd.text), sd.text.slice(0, 200));

console.log(`\n${fail === 0 ? "✓" : "✗"} refvideo: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
