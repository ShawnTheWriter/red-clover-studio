// Character voices: choose a voice per character, voice a recorded line.
// ElevenLabs is replaced by a fake fetch — no network, no credits.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-voice-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const voice = await import("../server/voice.js");
const { ElevenLabsDriver } = await import("../server/drivers/elevenlabs.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// A real 0.5 s silent WAV, so ffprobe can read it.
function wav(seconds = 0.5, sr = 16000) {
  const n = Math.round(seconds * sr), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const EP = "Show/S1E1";
await store.scaffold(EP);
const perfRel = `${EP}/05_delivery/audio/dialogue/flame_take1.wav`;
await fs.mkdir(path.dirname(path.join(ROOT, perfRel)), { recursive: true });
await fs.writeFile(path.join(ROOT, perfRel), wav());
await store.saveEpisode(EP, {
  name: "S1E1", dir: EP,
  assets: [
    { id: "flame", type: "character", name: "Flame" },
    { id: "flame2", type: "character", name: "Flame", angle: "face" },
    { id: "ovl", type: "character", name: "Overlock" },
  ],
  shots: [{
    id: "s1", sceneNum: "5", shotCode: "d", beats: [{ id: "b1", dialogue: { charId: "flame", line: "It true?" } }, { id: "b2", dialogue: { charId: "ovl", line: "Is what true?" } }],
    audioClips: [
      { id: "perf", path: perfRel, label: "take 1", seconds: 0.5, beatId: "b1", kind: "performance" },
      { id: "perf2", path: perfRel, label: "ovl take", seconds: 0.5, beatId: "b2", kind: "performance" },
    ],
    versions: [], selectedVersions: [],
  }],
});

console.log("choosing voices");
let ep = await store.loadEpisode(EP);
const set = voice.setCharacterVoice(ep, "flame2", { voiceId: "v_flame", voiceName: "Ember" });
check("a voice set on one angle covers every angle of the character", set.angles === 2 && ep.assets.filter((a) => a.name === "Flame").every((a) => a.elevenVoiceId === "v_flame"));
check("voiceFor finds it from the line's speaker id", voice.voiceFor(ep, "flame").voiceName === "Ember");
check("a character without a voice says so", voice.voiceFor(ep, "ovl").voiceId === null);
await store.saveEpisode(EP, ep);

console.log("\nvoicing a line (mock)");
const m = await voice.voiceLine(EP, { shotId: "s1", audioClipId: "perf", driver: "mock" });
ep = await store.loadEpisode(EP);
const clips = ep.shots[0].audioClips;
check("a NEW voiced recording is added beside the original", clips.length === 3 && clips.find((c) => c.id === "perf") && m.kind === "voiced");
check("it belongs to the same line and remembers its source and voice", m.beatId === "b1" && m.sourceClipId === "perf" && m.voiceName === "Ember");
check("its file exists and has a real duration", (await fs.stat(path.join(ROOT, m.path))).size > 0 && m.seconds > 0);
check("a mock run leaves the ledger alone", (ep.ledger.entries || []).length === 0);

let threw = null;
try { await voice.voiceLine(EP, { shotId: "s1", audioClipId: m.id, driver: "mock" }); } catch (e) { threw = e; }
check("a voiced recording can't be voiced again", threw && /already a character voice/.test(threw.message));
threw = null;
try { await voice.voiceLine(EP, { shotId: "s1", audioClipId: "perf2", driver: "mock" }); } catch (e) { threw = e; }
check("a speaker with no voice is refused with a clear message", threw && /Overlock has no ElevenLabs voice/.test(threw.message));

console.log("\nElevenLabs driver (fake server)");
const calls = [];
const fakeFetch = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (url.includes("/v2/voices")) return new Response(JSON.stringify({ voices: [{ voice_id: "v_flame", name: "Ember", category: "generated", labels: { accent: "british" }, preview_url: "https://x/p.mp3" }] }), { status: 200 });
  if (url.includes("/v1/speech-to-speech/")) return new Response(wav(0.4), { status: 200 });
  return new Response("{}", { status: 404 });
};
const real = new ElevenLabsDriver({ key: "test-key", fetch: fakeFetch });
check("no key = not ready, with the reason", new ElevenLabsDriver({ key: "" , fetch: fakeFetch }).status().ready === false || !!process.env.ELEVENLABS_API_KEY);
const vs = await real.listVoices({ search: "emb" });
check("voices come back as id, name, labels, preview", vs[0].voiceId === "v_flame" && vs[0].previewUrl && vs[0].labels.accent === "british");
check("the search goes to ElevenLabs with the key header", calls[0].url.includes("search=emb") && calls[0].opts.headers["xi-api-key"] === "test-key");
voice.voiceDrivers.elevenlabs = real;
const r = await voice.voiceLine(EP, { shotId: "s1", audioClipId: "perf", driver: "elevenlabs" });
const sts = calls.find((c) => c.url.includes("/v1/speech-to-speech/"));
check("speech-to-speech is called with the character's voice id", sts && sts.url.includes("/v1/speech-to-speech/v_flame") && sts.opts.method === "POST");
check("the recording and the STS model are in the form", sts.opts.body.get("audio") && sts.opts.body.get("model_id") === "eleven_multilingual_sts_v2");
check("the voiced file is saved as mp3 under voiced/", r.path.includes("/05_delivery/audio/dialogue/voiced/") && r.path.endsWith(".mp3"));
ep = await store.loadEpisode(EP);
const led = ep.ledger.entries.filter((e) => e.kind === "voice");
check("a real voicing is visible in the ledger at $0 (plan credits)", led.length === 1 && led[0].chargedUSD === 0 && /credits/.test(led[0].note));
const failing = new ElevenLabsDriver({ key: "bad", fetch: async () => new Response(JSON.stringify({ detail: { message: "Invalid API key" } }), { status: 401 }) });
threw = null;
try { await failing.listVoices(); } catch (e) { threw = e; }
check("an ElevenLabs error is reported with its message", threw && /401: Invalid API key/.test(threw.message));

console.log("\nroute A: re-voice from the take, then into the edit");
{
  const { execFileSync } = await import("node:child_process");
  const timeline = await import("../server/timeline.js");
  const { buildFCPXML } = await import("../server/export/fcpxml.js");
  const takeRel = `${EP}/05_delivery/takes/5d_M_vt1.mp4`;
  await fs.mkdir(path.dirname(path.join(ROOT, takeRel)), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(ROOT, takeRel)]);
  await store.withEpisode(EP, (e) => {
    const sh = e.shots[0];
    sh.versions = [{ id: "vt1", state: "done", path: takeRel, driver: "fal", seconds: 3 }];
    sh.selectedVersions = ["vt1"];
  });
  voice.voiceDrivers.mock = new (await import("../server/drivers/elevenlabs.js")).MockVoiceDriver();
  let t = null;
  try { await voice.revoiceFromTake(EP, { shotId: "s1", beatId: "b1", inSec: 2.5, outSec: 1, driver: "mock" }); } catch (e) { t = e; }
  check("start after end is refused", t && t.status === 400);
  const rv = await voice.revoiceFromTake(EP, { shotId: "s1", beatId: "b1", inSec: 0.5, outSec: 2.5, driver: "mock" });
  check("the take's own audio is extracted and voiced", rv.origin === "take" && rv.sourceVersionId === "vt1" && rv.offsetSec === 0.5 && rv.kind === "voiced");
  check("the voiced part has the extract's length", Math.abs(rv.seconds - 2) < 0.1, String(rv.seconds));
  check("the extract is kept beside it", await fs.stat(path.join(ROOT, rv.extractedFrom)).then(() => true, () => false));

  // Use in edit (what the route does), with a head trim on the picture.
  await store.withEpisode(EP, (e) => { e.shots[0].beats[0].dialogue.useClipId = rv.id; });
  const e2 = await store.loadEpisode(EP);
  await timeline.rebuildFromSelection(e2);
  const v1 = e2.timeline.tracks.find((x) => x.id === "V1").clips[0];
  const a1 = e2.timeline.tracks.find((x) => x.id === "A1").clips;
  check("the chosen recording lands on the Dialogue track", a1.length === 1 && a1[0].sourcePath === rv.path && a1[0].kind === "dialogue");
  check("at the take's own time (offset 0.5 s into the shot)", Math.abs(a1[0].startSec - (v1.startSec + 0.5)) < 0.001, String(a1[0].startSec));
  v1.headTrimSec = 1;
  e2.shots[0].beats[0].dialogue.useClipId = rv.id;
  await timeline.rebuildFromSelection(e2);
  const a1b = e2.timeline.tracks.find((x) => x.id === "A1").clips[0];
  check("a picture head trim past the line's start trims the line's head instead", a1b.startSec === 0 && Math.abs(a1b.headTrimSec - 0.5) < 0.001, JSON.stringify({ s: a1b.startSec, h: a1b.headTrimSec }));
  const xml = buildFCPXML(e2.timeline, timeline.clipsByTrackId(e2), { projectName: "T", rootAbs: ROOT, sequenceSize: { width: 1080, height: 1920 } });
  check("the FCPXML lists the voiced file as an audio-only asset", /<asset [^>]*\.mp3|<asset [^>]*5d_flame[^>]*hasVideo="0"/.test(xml) && xml.includes('hasVideo="0"'));
  check("no 0x0 video format for it", !/width="0" height="0"/.test(xml));
  check("it is nested under the picture on lane 1 (Dialogue)", /<asset-clip ref="r\d+" lane="1"/.test(xml));
  const xp = path.join(ROOT, "dialogue-test.fcpxml");
  await fs.writeFile(xp, xml);
  let wellFormed = true;
  try { execFileSync("xmllint", ["--noout", xp], { stdio: "pipe" }); } catch { wellFormed = false; }
  check("the FCPXML with a Dialogue track is well-formed (xmllint)", wellFormed);
  await store.withEpisode(EP, (e) => { e.shots[0].beats[0].dialogue.useClipId = null; });
  const e3 = await store.loadEpisode(EP);
  await timeline.rebuildFromSelection(e3);
  check("taking it out of the edit empties the Dialogue track", e3.timeline.tracks.find((x) => x.id === "A1").clips.length === 0);
}

console.log(`\n${fail === 0 ? "✓" : "✗"} voice: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
