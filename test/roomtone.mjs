// Sound → Room tone: prompt per scene, generated loops, one in the edit,
// tiled across the scene on A4. ElevenLabs is a fake server — no network,
// no credits.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-roomtone-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const rt = await import("../server/roomtone.js");
const voice = await import("../server/voice.js");
const timeline = await import("../server/timeline.js");
const { buildFCPXML } = await import("../server/export/fcpxml.js");
const { ElevenLabsDriver, silentWav } = await import("../server/drivers/elevenlabs.js");
const { newTimelineClip } = await import("../shared/schema.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 0.01;

console.log("prompts");
const p = rt.defaultPrompt({ heading: "INT. Overlock's Hut - NIGHT" });
check("the default prompt carries the full slugline", p.includes("INT. Overlock's Hut - NIGHT") && /no voices, no music/.test(p));
check("no heading: built from INT/EXT, location, time", rt.defaultPrompt({ intext: "EXT.", loc: "Village", time: "NIGHT" }).includes("EXT. Village - NIGHT"));

const EP = "Show/S1E1";
await store.scaffold(EP);
// Two 5 s takes so the rebuild can measure real files.
const mkTake = async (rel) => {
  await fs.mkdir(path.dirname(path.join(ROOT, rel)), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=5", "-f", "lavfi", "-i", "sine=duration=5", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(ROOT, rel)]);
};
const T = `${EP}/05_delivery/takes`;
await mkTake(`${T}/1a.mp4`); await mkTake(`${T}/1b.mp4`); await mkTake(`${T}/2a.mp4`);
const shot = (id, sceneNum, shotCode, vid) => ({ id, sceneNum, shotCode, beats: [], versions: [{ id: vid, state: "done", path: `${T}/${shotCode === "a" && sceneNum === "2" ? "2a" : `1${shotCode}`}.mp4` }], selectedVersions: [vid] });
await store.saveEpisode(EP, {
  name: "S1E1", dir: EP,
  scenes: [{ id: "c1", number: "1", heading: "INT. HUT - NIGHT" }, { id: "c2", number: "2", heading: "EXT. VILLAGE - NIGHT" }],
  shots: [shot("A", "1", "a", "va"), shot("B", "1", "b", "vb"), shot("C", "2", "a", "vc")],
});

console.log("\nscene rows");
let ep = await store.loadEpisode(EP);
const set = rt.setPrompt(ep, "1", "Steady rain on a thatched roof, interior hut, night. No voices.");
check("a prompt is stored on the scene", ep.scenes[0].roomTone.prompt.startsWith("Steady rain") && set.takes.length === 0);
await store.saveEpisode(EP, ep);
let threw = null;
try { rt.useTake(ep, "1", "nope"); } catch (e) { threw = e; }
check("using an unknown take is refused", threw && threw.status === 404);

console.log("\ngenerate (mock)");
voice.voiceDrivers.mock.soundEffect = async ({ seconds }) => silentWav(seconds); // shorter test loops
const g1 = await rt.generate(EP, { sceneNum: "1", seconds: 4, driver: "mock" });
ep = await store.loadEpisode(EP);
check("a loop is generated with the scene's own prompt", g1.take.prompt.startsWith("Steady rain") && near(g1.take.seconds, 4));
check("the first loop is in the edit by default", ep.scenes[0].roomTone.useId === g1.take.id);
const g2 = await rt.generate(EP, { sceneNum: "1", seconds: 3, driver: "mock" });
ep = await store.loadEpisode(EP);
check("a second loop is kept beside the first, the first stays in the edit", ep.scenes[0].roomTone.takes.length === 2 && ep.scenes[0].roomTone.useId === g1.take.id);
check("mock runs leave the ledger alone", !(ep.ledger.entries || []).length);

console.log("\ntiling on the timeline");
await timeline.rebuildFromSelection(ep);
const a4 = ep.timeline.tracks.find((t) => t.id === "A4").clips;
// Scene 1 = shots A + B = 0–10 s; a 4 s loop -> 4 + 4 + 2 (tail-trimmed 2).
check("the loop is tiled across the whole scene", a4.length === 3 && near(a4[0].startSec, 0) && near(a4[1].startSec, 4) && near(a4[2].startSec, 8), JSON.stringify(a4.map((c) => c.startSec)));
check("the last copy is trimmed to end with the scene", near(a4[2].tailTrimSec, 2) && near(a4[0].tailTrimSec, 0));
check("scene 2 has no loop in the edit, so nothing there", a4.every((c) => c.startSec < 10));
const xml = buildFCPXML(ep.timeline, timeline.clipsByTrackId(ep), { projectName: "T", rootAbs: ROOT, sequenceSize: { width: 1080, height: 1920 } });
check("FCPXML: room tone on lane 4, as audio-only", /lane="4"[^>]*name="Room tone/.test(xml) && xml.includes('hasVideo="0"'));
const xp = path.join(ROOT, "rt.fcpxml"); await fs.writeFile(xp, xml);
let wf = true; try { execFileSync("xmllint", ["--noout", xp], { stdio: "pipe" }); } catch { wf = false; }
check("the FCPXML is well-formed (xmllint)", wf);
rt.useTake(ep, "1", null);
await timeline.rebuildFromSelection(ep);
check("taking the loop out of the edit empties the track", ep.timeline.tracks.find((t) => t.id === "A4").clips.length === 0);

console.log("\nElevenLabs (fake server)");
const calls = [];
voice.voiceDrivers.elevenlabs = new ElevenLabsDriver({ key: "k", fetch: async (url, opts) => { calls.push({ url, opts }); return new Response(silentWav(1), { status: 200 }); } });
// The fake returns a WAV; the real API returns mp3. probe reads either.
const g3 = await rt.generate(EP, { sceneNum: "2", seconds: 40, driver: "elevenlabs" });
const body = JSON.parse(calls[0].opts.body);
check("the sound-generation endpoint is called with the key", calls[0].url.includes("/v1/sound-generation") && calls[0].opts.headers["xi-api-key"] === "k");
check("it asks for a seamless loop with the v2 model", body.loop === true && body.model_id === "eleven_text_to_sound_v2");
check("length is capped at 22 s", body.duration_seconds === 22);
check("the prompt defaults to the scene's slugline", body.text.includes("EXT. VILLAGE - NIGHT"));
ep = await store.loadEpisode(EP);
const led = (ep.ledger.entries || []).filter((e) => e.kind === "sfx");
check("a real generation is logged at $0 (plan credits)", led.length === 1 && led[0].chargedUSD === 0 && /credits/.test(led[0].note) && g3.take.driver === "elevenlabs");
threw = null;
try { await rt.generate(EP, { sceneNum: "2", prompt: "x".repeat(451), driver: "elevenlabs" }); } catch (e) { threw = e; }
check("a prompt over 450 characters is refused before any call", threw && /450/.test(threw.message) && calls.length === 1);

console.log(`\n${fail === 0 ? "✓" : "✗"} room tone: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
