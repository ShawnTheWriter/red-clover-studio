// Claude helpers (server/llm.js) against a FAKE Anthropic server — no network,
// no key, no cost. Checks what is sent (model, cached system prompt with the
// right guide, storyboard images, structured output, refusal fallback) and
// that every billed call lands in the ledger.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-llm-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// ---- fake Anthropic ----
const seen = [];
let nextReply = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    seen.push({ url: req.url, headers: req.headers, body: json });
    const reply = nextReply ? nextReply(json) : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.RCS_ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const msg = (model, obj, usage, stop = "end_turn") => ({
  id: "msg_test", type: "message", role: "assistant", model, stop_reason: stop, stop_details: null,
  content: [{ type: "text", text: JSON.stringify(obj) }],
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
});

const store = await import("../server/store.js");
const llm = await import("../server/llm.js");

// ---- a small episode: one shot with two approved storyboards, a script ----
const EP = "Show/S1E1";
await store.scaffold(EP);
const png = async (rel, color) => {
  const abs = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=360x640`, "-frames:v", "1", abs]);
};
await png(`${EP}/03_storyboard/05b_start.png`, "red");
await png(`${EP}/03_storyboard/05b_end.png`, "blue");
await fs.writeFile(path.join(ROOT, `${EP}/script.fountain`), [
  "INT. SECRET WORKSHOP - DAY", "",
  "Flame pulls the heavy door open. Overlock stands inside.", "",
  "OVERLOCK", "(tired)", "What do YOU want?", "",
  "FLAME", "It true?", "",
].join("\n"));
await store.saveEpisode(EP, {
  name: "S1E1", dir: EP, fmt: "9:16", style: "gritty fairytale realism", scriptPath: `${EP}/script.fountain`,
  ledger: { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] },
  scenes: [{ id: "sc5", number: "5", heading: "INT. Secret Workshop - DAY", intext: "INT.", loc: "Secret Workshop", time: "DAY", scriptNumber: "1" }],
  assets: [
    { id: "ovl", type: "character", name: "Overlock Stitch", identityHold: "dark-haired woman, patchwork coat" },
    { id: "flm", type: "character", name: "Flame", identityHold: "red-haired, fringed jacket" },
  ],
  shots: [{
    id: "s5b", sceneNum: "5", shotCode: "b", label: "Flame pulls open the door", subjects: "Flame, Overlock", move: "static",
    action: "Flame pulls the door open toward herself", audio: "the door groaning",
    beats: [
      { id: "b1", keyframe: true, role: "start", frame: { path: `${EP}/03_storyboard/05b_start.png`, approved: true } },
      { id: "b2", keyframe: true, role: "end", frame: { path: `${EP}/03_storyboard/05b_end.png`, approved: true }, dialogue: { charId: "ovl", line: "What do YOU want?", delivery: "tired" } },
    ],
    versions: [], selectedVersions: [],
  }],
});

console.log("draft a prompt (Opus 5.5, H3 Max)");
nextReply = (b) => msg(b.model, { prompt: "The red-haired woman pulls the door toward the camera.", notes: ["Named nobody."] }, { input_tokens: 3000, output_tokens: 1000, cache_creation_input_tokens: 2000 });
const d = await llm.draftPrompt(EP, { shotId: "s5b", videoModelId: "minimax/h3-max/image-to-video", llm: "claude-opus-5-5", intent: "she pulls, not pushes" });
const req = seen.at(-1);
check("returns the draft and notes", d.prompt.startsWith("The red-haired woman") && d.notes.length === 1);
check("calls Opus 5.5 on /v1/messages", req.body.model === "claude-opus-5-5" && /\/v1\/messages/.test(req.url));
check("structured output with prompt + notes", req.body.output_config.format.type === "json_schema" && req.body.output_config.format.schema.required.join() === "prompt,notes");
check("effort medium for a prompt", req.body.output_config.effort === "medium");
check("refusal fallback on (Opus): header + fallbacks:'default'", String(req.headers["anthropic-beta"] || "").includes("server-side-fallback-2026-07-01") && req.body.fallbacks === "default");
check("system prompt carries the H3 Max guide and is cached", req.body.system[0].text.includes("How To Use MiniMax H3 Max") && req.body.system[0].cache_control.type === "ephemeral");
const imgs = req.body.messages[0].content.filter((c) => c.type === "image");
check("sends the start AND end storyboard as images", imgs.length === 2 && imgs.every((i) => i.source.media_type === "image/jpeg"));
const shotText = req.body.messages[0].content.at(-1).text;
check("sends the shot fields, dialogue and the creator's note", shotText.includes('"What do YOU want?"'.slice(1, -1)) && shotText.includes("she pulls, not pushes") && shotText.includes("creators_current_prompt"));
const cost = (3000 * 4 + 2000 * 4 * 1.25 + 1000 * 20) / 1e6;
check(`cost from usage: $${cost.toFixed(4)}`, Math.abs(d.usd - cost) < 1e-9, String(d.usd));
let ep = await store.loadEpisode(EP);
const e1 = ep.ledger.entries.at(-1);
check("the ledger gets an llm entry with tokens", e1.kind === "llm" && e1.model === "claude-opus-5-5" && e1.tokens.out === 1000 && Math.abs(e1.chargedUSD - Math.round(cost * 1e4) / 1e4) < 1e-9);
check("spent goes up by the call", Math.abs(ep.ledger.spentUSD - Math.round(cost * 1e4) / 1e4) < 1e-9);

check("the draft is kept on the episode until used (shows after a reload)", ep.claude.drafts.s5b.prompt.startsWith("The red-haired woman") && ep.claude.drafts.s5b.videoModelId === "minimax/h3-max/image-to-video");
await llm.keepResult(EP, "drafts", "s5b", null);
check("discard removes it", !(await store.loadEpisode(EP)).claude.drafts.s5b);

console.log("\nHaiku 5.5: no fallback (not offered for Haiku)");
nextReply = (b) => msg(b.model, { prompt: "x", notes: [] }, { input_tokens: 4000, output_tokens: 500 });
await llm.draftPrompt(EP, { shotId: "s5b", videoModelId: "alibaba/wan-3.0/image-to-video", llm: "claude-haiku-5-5" });
const rh = seen.at(-1);
check("no fallbacks field, no fallback beta", rh.body.fallbacks === undefined && !String(rh.headers["anthropic-beta"] || "").includes("fallback"));
check("a model with no guide (Wan 3.0) gets the general guide", rh.body.system[0].text.includes("no model-specific guide yet"));
for (const [mid, needle] of [["bytedance/seedance-2.5/image-to-video", "Seedance 2.5 Workflows"], ["fal-ai/kling-video/v3/standard/image-to-video", "Kling 3.0 Prompting Guide"], ["minimax/h3/image-to-video", "How To Use MiniMax H3 Max"]]) {
  await llm.draftPrompt(EP, { shotId: "s5b", videoModelId: mid, llm: "claude-haiku-5-5" });
  check(`${mid.split("/").slice(0, 2).join("/")} gets its own guide`, seen.at(-1).body.system[0].text.includes(needle));
}

console.log("\npropose shots for a scene");
nextReply = (b) => msg(b.model, { shots: [
  { label: "Door pulled open", size: "MS", angle: "ots", move: "static", subjects: "Flame, Overlock", action: "Flame pulls the door open", dialogue: [{ character: "OVERLOCK", line: "What do YOU want?", delivery: "tired" }], sound: "door groan", seconds: 5, risk: "doors", matches_existing: "5b" },
  { label: "Flame asks", size: "CU", angle: "eye", move: "push", subjects: "Flame", action: "Flame asks", dialogue: [{ character: "FLAME", line: "It true?", delivery: "blunt" }, { character: "STRANGER", line: "Hm.", delivery: "" }], sound: "", seconds: 3, risk: "", matches_existing: "" },
], notes: ["ok"] }, { input_tokens: 2500, output_tokens: 4000 });
const p = await llm.proposeShots(EP, { sceneNum: "5", llm: "claude-opus-5-5" });
const rs = seen.at(-1);
check("sends the scene's own script text (matched by heading)", rs.body.messages[0].content[0].text.includes("Flame pulls the heavy door open") && rs.body.messages[0].content[0].text.includes("What do YOU want?"));
check("effort high for a breakdown", rs.body.output_config.effort === "high");
check("schema limits size/angle/move to the app's codes", rs.body.output_config.format.schema.properties.shots.items.properties.move.enum.includes("static"));
check("returns the proposals", p.shots.length === 2 && p.notes[0] === "ok");
check("proposals are kept on the episode by scene id", (await store.loadEpisode(EP)).claude.proposals.sc5.shots.length === 2);

console.log("\nthe previous scene goes along as context");
{
  const E2 = "Show/S1E2";
  await store.scaffold(E2);
  await fs.writeFile(path.join(ROOT, `${E2}/script.fountain`), [
    "EXT. VILLAGE - NIGHT", "", "Overlock runs in the rain with her hood up.", "", "Guards march into the town square.", "",
    "EXT. VILLAGE ALLEYWAY - CONTINUOUS", "", "Overlock runs down a side alley with puddles.", "",
    "INT. SECRET WORKSHOP - NIGHT", "", "She lights a candle.", "",
  ].join("\n"));
  await store.saveEpisode(E2, {
    name: "S1E2", dir: E2, fmt: "9:16", scriptPath: `${E2}/script.fountain`,
    ledger: { budgetCapUSD: 25, confirmAboveUSD: 2, spentUSD: 0, entries: [] },
    scenes: [
      { id: "v1", number: "1", heading: "EXT. Village - NIGHT" },
      { id: "v2", number: "2", heading: "EXT. Village Alleyway - CONTINUOUS" },
      { id: "v3", number: "3", heading: "INT. Secret Workshop - NIGHT" },
    ],
    shots: [], assets: [],
    claude: { drafts: {}, proposals: { v1: { shots: [{ label: "Overlock runs, hood up, rain" }, { label: "Guards cut off the square" }] } } },
  });
  nextReply = (b) => msg(b.model, { shots: [], notes: [] }, { input_tokens: 2000, output_tokens: 500 });
  await llm.proposeShots(E2, { sceneNum: "2", llm: "claude-opus-5-5" });
  const t2 = seen.at(-1).body.messages[0].content[0].text;
  check("scene 2 gets scene 1's script (the rain) as context", /PREVIOUS SCENE \(context only/.test(t2) && t2.includes("runs in the rain"));
  check("and scene 1's proposed shots, marked as proposals", t2.includes("Overlock runs, hood up, rain") && t2.includes("proposed, not yet approved"));
  check("its own script is still the one to break down", t2.indexOf("SCENE SCRIPT (break this one down)") > t2.indexOf("runs in the rain") && t2.includes("side alley with puddles"));
  check("the next scene's heading comes along for the hand-off", /NEXT SCENE HEADING: INT\. Secret Workshop - NIGHT/.test(t2));
  check("the system prompt says the previous scene is context only", /PREVIOUS SCENE \(when given\) is context only/.test(seen.at(-1).body.system[0].text));
  await llm.proposeShots(E2, { sceneNum: "1", llm: "claude-opus-5-5" });
  const t1 = seen.at(-1).body.messages[0].content[0].text;
  check("scene 1 has no previous scene", !/PREVIOUS SCENE \(context only/.test(t1) && /NEXT SCENE HEADING: EXT\. Village Alleyway/.test(t1));
  // The creator's own shots win over Claude's proposals.
  await store.withEpisode(E2, (e) => { e.shots = [{ id: "x1", sceneNum: "1", shotCode: "a", label: "Wagon in the rain", beats: [], versions: [], selectedVersions: [] }]; });
  await llm.proposeShots(E2, { sceneNum: "2", llm: "claude-opus-5-5" });
  const t3 = seen.at(-1).body.messages[0].content[0].text;
  check("the creator's own shots replace the proposals", t3.includes("Wagon in the rain") && !t3.includes("proposed, not yet approved"));
}

console.log("\nadd ticked proposals");
ep = await store.loadEpisode(EP);
const added = llm.addProposedShots(ep, "5", p.shots);
const scene5 = ep.shots.filter((s) => s.sceneNum === "5");
check("added at the end of the scene, letters follow", added.length === 2 && scene5.map((s) => s.shotCode).join("") === "abc");
const n1 = ep.shots.find((s) => s.id === added[0]);
check("fields carry over (size, angle, move, action, sound)", n1.size === "MS" && n1.angle === "ots" && n1.action === "Flame pulls the door open" && n1.audio === "door groan");
check("speaker matched to the Identity Vault by name", n1.beats[0].dialogue.charId === "ovl" && n1.beats[0].dialogue.line === "What do YOU want?");
const n2 = ep.shots.find((s) => s.id === added[1]);
check("a second line goes on its own timing beat", n2.beats.length === 2 && n2.beats[1].dialogue.line === "Hm.");
check("an unknown speaker is flagged in the shot notes", /STRANGER/.test(n2.notes));
check("risk and length land in notes", /Risk \(Claude\): doors/.test(n1.notes) && /Suggested length: 5 s/.test(n1.notes));

console.log("\nrefusal and errors");
nextReply = (b) => ({ ...msg(b.model, {}, { input_tokens: 100, output_tokens: 10 }, "refusal"), stop_details: { type: "refusal", category: null, explanation: "no" } });
let err = null;
try { await llm.draftPrompt(EP, { shotId: "s5b", videoModelId: "minimax/h3-max/image-to-video", llm: "claude-opus-5-5" }); } catch (e) { err = e; }
ep = await store.loadEpisode(EP);
check("a refusal is an error the creator can read", err && /declined/.test(err.message));
check("a billed refusal is still charged, marked failed", /failed/.test(ep.ledger.entries.at(-1).note));
ep.ledger.budgetCapUSD = ep.ledger.spentUSD + 0.2; await store.saveEpisode(EP, ep);
err = null; const before = seen.length;
try { await llm.draftPrompt(EP, { shotId: "s5b", videoModelId: "minimax/h3-max/image-to-video" }); } catch (e) { err = e; }
check("refused before calling when the cap leaves under $0.50", err && /cap/.test(err.message) && seen.length === before);
delete process.env.ANTHROPIC_API_KEY;
check("no key: says how to add it", llm.status().ready === false && /ANTHROPIC_API_KEY/.test(llm.status().reason));

server.close();
await fs.rm(ROOT, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} Claude helpers: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
