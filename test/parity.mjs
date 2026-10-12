// Parity harness: the v1 prompt builders (copied verbatim out of
// "Red Clover Production Desk.html", pure functions only) run against a v1 shot,
// versus the v2 builders running against the SAME shot after migration.
// Any diff here is a craft regression, not a refactor detail.

import { migrateShotV1, migrateAssetV1, newEpisode, ensureV2, newAsset } from "../shared/schema.js";
import { buildNano as v2Nano, buildGPT as v2GPT, buildVideo as v2Video, draftTimecodeText as v2TC } from "../shared/prompts.js";
import { SIZES, LENSES, ANGLES, ANGLE_FX, MOVES, TREATMENTS, stripStaleLabelPrefix } from "../shared/grammar.js";
import { newAssetAudit } from "../shared/audit.js";

/* ---------- v1 originals ---------- */
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const hslug = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pad2 = s => { s = (s == null ? "" : s).toString().trim(); return /^\d+$/.test(s) ? s.padStart(2, "0") : s; };
const shotCodeStr = shot => (pad2(shot.sceneNum) || "") + (shot.shotCode || "");
const locSlug = shot => { const ie = (shot.intext || "INT.").replace(/[^A-Za-z]/g, "").toLowerCase(); return ie + "-" + hslug(shot.time || "day") + "-" + hslug(shot.loc || "loc"); };
const frameBaseName = shot => (shotCodeStr(shot) || "shot") + "_" + locSlug(shot) + "_" + hslug(shot.label || shot.size || "frame");
function shotTreatments(shot) { return shot.treatments || []; }
function treatmentLines(shot) { const ph = shotTreatments(shot).map(id => { const t = TREATMENTS.find(x => x.id === id); return t ? t.phrase : null; }).filter(Boolean); if (shot.custom && shot.custom.trim()) ph.push(shot.custom.trim()); return ph; }
function refNames(shot, p) { return shot.refs.map(id => (p.assets.find(a => a.id === id) || {}).name).filter(Boolean); }
function kfCam(shot, prefix) { if (!prefix) return { size: shot.size, angle: shot.angle, lens: shot.lens, move: shot.move }; return { size: shot[prefix + "Size"] || shot.size, angle: shot[prefix + "Angle"] || shot.angle, lens: shot[prefix + "Lens"] || shot.lens, move: shot[prefix + "Move"] || shot.move }; }
const labelPrefix = l => l === "START" ? "start" : l === "MIDDLE" ? "mid" : l === "END" ? "end" : null;
function camPhrase(c) { let s = "Shot as " + (SIZES[c.size] || "a shot") + " on " + (LENSES[c.lens] || "a lens") + ", " + (ANGLES[c.angle] || "at eye level"); if (ANGLE_FX[c.angle]) s += ANGLE_FX[c.angle]; return s; }
const aspectWord = p => p.fmt === "9:16" ? "vertical 9:16" : "horizontal 16:9";
function locPhrase(shot, p) { if (p && p.lean) { const lr = (p.assets || []).find(a => a.type === "location" && (shot.refs || []).includes(a.id)); if (lr) return "the " + lr.name + ", as in the reference"; } return shot.location || ""; }

function v1Nano(shot, p) {
  const refs = refNames(shot, p);
  const refLine = refs.length ? ` Use the provided reference image(s) — ${refs.join(", ")} — as the ABSOLUTE anchor for character identity and the environment; do not restyle or reinterpret them.` : "";
  const dir = treatmentLines(shot); const dirBlock = dir.length ? "\nDIRECTION: " + dir.join("; ") + "." : "";
  return `Cinematic ${aspectWord(p)} storyboard frame${p.style ? ", " + p.style : ""}.
SUBJECT: ${shot.subjects}.
ACTION: ${shot.action}.
LOCATION: ${locPhrase(shot, p)}.
CAMERA: ${camPhrase(kfCam(shot))}.
LIGHTING: ${shot.lighting}.${shot.atmos ? "\nATMOSPHERE: " + shot.atmos + "." : ""}${dirBlock}${refLine}
Photographic realism, consistent detail.
Negative: ${p.ban}.`;
}
function v1FrameNano(shot, p, label, desc) {
  const refs = refNames(shot, p);
  const refLine = refs.length ? ` Use the provided reference image(s) — ${refs.join(", ")} — as the ABSOLUTE anchor for character identity and the environment; do not restyle or reinterpret them.` : "";
  const dir = treatmentLines(shot); const dirBlock = dir.length ? "\nDIRECTION: " + dir.join("; ") + "." : "";
  const moment = label === "START" ? "the START of the shot" : label === "END" ? "the END of the shot" : label === "MIDDLE" ? "the MIDDLE of the shot" : "the shot";
  return `Cinematic ${aspectWord(p)} storyboard keyframe — ${moment}${p.style ? ", " + p.style : ""}.
SUBJECT: ${shot.subjects}.
MOMENT: ${desc || shot.action}.
LOCATION: ${locPhrase(shot, p)}.
CAMERA: ${camPhrase(kfCam(shot, labelPrefix(label)))}.
LIGHTING: ${shot.lighting}.${shot.atmos ? "\nATMOSPHERE: " + shot.atmos + "." : ""}${dirBlock}${refLine}
Photographic realism, consistent detail.
Negative: ${p.ban}.`;
}
function v1GPT(shot, p) {
  const refs = refNames(shot, p); const refLine = refs.length ? ` Keep ${refs.join(" and ")} consistent with the uploaded reference image(s).` : "";
  const dir = treatmentLines(shot); const dirS = dir.length ? " Direction: " + dir.join("; ") + "." : "";
  return `A cinematic film still, ${aspectWord(p)}${p.style ? ", " + p.style : ""}. ${cap(shot.subjects)} — ${shot.action} — in ${locPhrase(shot, p)}. ${camPhrase(kfCam(shot))}. ${cap(shot.lighting)}.${shot.atmos ? " Mood: " + shot.atmos + "." : ""}${dirS} Photorealistic, richly detailed, filmic color grade, natural skin and fabric texture.${refLine} Avoid distortion of hands or faces, text, and watermarks.`;
}
function v1FrameGPT(shot, p, label, desc) {
  const refs = refNames(shot, p); const refLine = refs.length ? ` Keep ${refs.join(" and ")} consistent with the uploaded reference image(s).` : "";
  const dir = treatmentLines(shot); const dirS = dir.length ? " Direction: " + dir.join("; ") + "." : "";
  return `A cinematic film still, ${aspectWord(p)}${p.style ? ", " + p.style : ""}. ${cap(shot.subjects)} — ${desc || shot.action} — in ${locPhrase(shot, p)}. ${camPhrase(kfCam(shot, labelPrefix(label)))}. ${cap(shot.lighting)}.${shot.atmos ? " Mood: " + shot.atmos + "." : ""}${dirS} Photorealistic, richly detailed, filmic color grade, natural skin and fabric texture.${refLine} Avoid distortion of hands or faces, text, and watermarks.`;
}
function v1DialogueStr(shot, p) {
  if (!shot.diaLine || !shot.diaLine.trim()) return null;
  const a = (p.assets || []).find(x => x.id === shot.diaChar);
  const name = a ? a.name : (shot.diaChar || "Character");
  const bits = [(shot.diaDelivery && shot.diaDelivery !== "neutral") ? shot.diaDelivery : "", (a && a.voice) ? a.voice : ""].filter(Boolean).join(", ");
  return name + (bits ? " (" + bits + ")" : "") + ': "' + shot.diaLine.trim() + '"';
}
function v1Video(shot, p) {
  const o = {};
  o.subject_motion = [shot.subjects, shot.action].map(x => (x || "").trim()).filter(Boolean).join(" — ");
  o.camera_move = MOVES[shot.move] || "static (locked-off)";
  o.audio = { dialogue: v1DialogueStr(shot, p), sfx: shot.audio || "", music: (shot.music && shot.music.trim()) ? shot.music.trim() : null };
  o.negative = p.ban;
  return JSON.stringify(o, null, 2);
}
const secToTC = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), ss = s % 60; return String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0"); };
const splitBeats = t => { t = (t || "").trim(); if (!t) return []; return t.split(/(?<=[.;!?])\s+|\s+(?:then|as|while)\s+/i).map(s => s.trim()).filter(Boolean); };
const estBeatDuration = t => { const w = (t.trim().match(/\S+/g) || []).length; return Math.min(4, Math.max(1.5, w / 2.2)); };
function v1TC(shot, p) {
  const kfSlots = [["start", shot.startDesc], ["mid", shot.midDesc], ["end", shot.endDesc]].filter(([, d]) => (d || "").trim());
  let beatSlots;
  if (kfSlots.length > 1) beatSlots = kfSlots.map(([prefix, desc]) => ({ prefix, desc: desc.trim() }));
  else { const split = splitBeats(shot.action || shot.subjects || ""); beatSlots = (split.length ? split : ["(describe the beat)"]).map(desc => ({ prefix: null, desc })); }
  const dia = v1DialogueStr(shot, p);
  let t = 0; const shotLines = [];
  const sentence = s => s.trim().replace(/[.!?]+$/, "") + ".";
  beatSlots.forEach((b, i) => {
    const dur = estBeatDuration(b.desc); const isLast = i === beatSlots.length - 1;
    const c = kfCam(shot, b.prefix);
    const camHeader = `${SIZES[c.size] || "a shot"}, ${ANGLES[c.angle] || "eye level"}, ${MOVES[c.move] || "static"}`;
    const bits = [sentence(b.desc)];
    if (isLast && dia) bits.push("Dialogue: " + sentence(dia));
    if (isLast && shot.audio && shot.audio.trim()) bits.push("SFX: " + sentence(shot.audio));
    shotLines.push(`[${secToTC(t)}-${secToTC(t + dur)}] Shot ${i + 1}${shot.label ? ": " + shot.label : ""} (${camHeader}). ${bits.join(" ")}`);
    t += dur;
  });
  const rA = (p.assets || []).filter(a => (shot.refs || []).includes(a.id));
  const assetMap = rA.length ? rA.map((a, i) => `@Image${i + 1} = ${a.name} (${a.type})`).join("\n") : "(no reference assets attached to this shot — add some above to anchor identity)";
  const style = p.style || "cinematic, natural color grade";
  return `【Style】${style}
【Duration】${Math.round(t)} seconds · 【Aspect】${p.fmt}

Asset map:
${assetMap}

${shotLines.join("\n")}

Constraints (negative — keep in this separate block, don't fold into the lines above): ${p.ban}`;
}

/* ---------- fixtures: the real seeded Fashion Heist cold open ---------- */
const assets = [
  { id: "a1", type: "character", name: "Overlock Stitch", file: "overlock portrait.png" },
  { id: "a2", type: "character", name: "Bobbin (hummingbird)", file: "Bobbin1.png", voice: "high bright chirp" },
  { id: "a3", type: "location", name: "Secret Workshop (day)", file: "Scene1_shot01_establishing.jpg" },
  { id: "a4", type: "prop", name: "rusty scissors", file: "" },
];
const P = { fmt: "9:16", style: "cinematic period microdrama, gritty 19th-century fairytale realism, filmic color grade", ban: "no extra fingers, no extra limbs, no deformed or melted faces, no text, no watermarks", lean: false, assets };

const v1Shots = [
  { id: "s1", sceneNum: "1", shotCode: "a", intext: "INT.", loc: "Secret Workshop", time: "DAY", label: "WS establishing", size: "WS", angle: "eye", lens: "24mm", move: "static", action: "dust motes drift through the light; establish the dingy workshop", subjects: "the empty workshop", location: "a dingy secret dressmaker's workshop", lighting: "hard key light from the high barred window", atmos: "grimy, desaturated, ominous calm", audio: "faint room creak, distant town, a single fly buzz", refs: ["a3"] },
  { id: "s2", sceneNum: "1", shotCode: "b", intext: "INT.", loc: "Secret Workshop", time: "DAY", label: "Bobbin enters", size: "MS", angle: "eye", lens: "35mm", move: "push", kf: "start_end", startDesc: "the hummingbird at the high barred window", endDesc: "the hummingbird hovering mid-room, wings motion-blurred", action: "the hummingbird darts in through the barred window", subjects: "Bobbin the hummingbird", location: "the dingy workshop, barred window backlit", lighting: "backlit by the bright window", atmos: "sudden small energy", audio: "rapid wing thrum, a small chirp", refs: ["a2", "a3"] },
  { id: "s3", sceneNum: "1", shotCode: "d", intext: "INT.", loc: "Secret Workshop", time: "DAY", label: "terror freeze (HOOK)", size: "MCU", angle: "eye", lens: "50mm", move: "handheld", kf: "start_mid_end", startDesc: "Overlock half-asleep, eyes beginning to open", midDesc: "her eyes snap wide", endDesc: "Overlock bolt upright, rusty scissors thrust toward camera", endSize: "CU", endAngle: "low", action: "she jolts awake and thrusts the scissors up toward camera", subjects: "Overlock Stitch, dirty face, wild dark hair, pale blue eyes", location: "the workshop floor amid laundry", lighting: "hard light slivers rake across her face", atmos: "shock, danger", audio: "a sharp gasp, cloth rustle, a stinger hit", treatments: ["emo_peak", "dutch_tension"], custom: "desaturate hard on the freeze", diaChar: "a1", diaLine: "Who's there?!", diaDelivery: "fearful", refs: ["a1", "a4"] },
];

/* ---------- run ---------- */
const ep = newEpisode({ ...P, assets: assets.map(migrateAssetV1) });
let pass = 0, fail = 0;
const check = (name, a, b) => {
  if (a === b) { pass++; return; }
  fail++;
  console.log(`\n✗ MISMATCH: ${name}`);
  const al = a.split("\n"), bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) console.log(`  line ${i + 1}\n    v1: ${JSON.stringify(al[i])}\n    v2: ${JSON.stringify(bl[i])}`);
  }
};

for (const v1 of v1Shots) {
  const v2 = migrateShotV1(v1);
  ep.shots = [v2];
  const kf = v1.kf || "single";
  const labels = kf === "single" ? ["START"] : kf === "start_end" ? ["START", "END"] : ["START", "MIDDLE", "END"];
  const descs = kf === "single" ? [v1.startDesc || v1.action] : kf === "start_end" ? [v1.startDesc, v1.endDesc] : [v1.startDesc, v1.midDesc, v1.endDesc];

  if (kf === "single") {
    check(`${v1.id} nano (single)`, v1Nano(v1, P), v2Nano(v2, ep, v2.beats[0]));
    check(`${v1.id} gpt (single)`, v1GPT(v1, P), v2GPT(v2, ep, v2.beats[0]));
  } else {
    labels.forEach((L, i) => {
      check(`${v1.id} nano ${L}`, v1FrameNano(v1, P, L, descs[i]), v2Nano(v2, ep, v2.beats[i]));
      check(`${v1.id} gpt ${L}`, v1FrameGPT(v1, P, L, descs[i]), v2GPT(v2, ep, v2.beats[i]));
    });
  }
  check(`${v1.id} video json`, v1Video(v1, P), v2Video(v2, ep));
  check(`${v1.id} timecode`, v1TC(v1, P), v2TC(v2, ep));
}
console.log(`\n${fail === 0 ? "✓" : "✗"} parity: ${pass} passed, ${fail} failed`);

/* ---------- schema-evolution backfill regression ----------
 * Real bug, caught 2026-09-11: a field added to newEpisode() (or a nested
 * constructor) after episodes already existed on disk was silently
 * undefined on every pre-existing episode — ensureV2() short-circuited on
 * "schemaVersion already matches" and returned the raw disk document
 * as-is. The first thing that touched the new field threw, AFTER a file
 * had already been written by the same request, so the write silently
 * succeeded while its own log entry silently didn't.
 *
 * The first fix attempt introduced a WORSE bug: newLedger() ignored its
 * argument entirely, so routing an existing episode's ledger back through
 * it to backfill one new field would have reset budgetCapUSD, spentUSD and
 * every entry to hardcoded defaults on every single load — silently
 * erasing real spend history. Caught before it ever touched real data by
 * reading the diff, not by a test — which is exactly why this assertion
 * exists now: the next constructor that grows a field should fail HERE if
 * it doesn't merge its partial, not get discovered by luck. */

// parity's `check()` diffs two STRINGS; this section asserts plain booleans,
// so it gets its own tiny helper rather than abusing the string differ.
const checkBool = (name, cond, detail = "") => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`\n✗ FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
};

console.log("\nSCHEMA BACKFILL (new fields on existing v2 documents)");
{
  const onDisk = {
    schemaVersion: 2, id: "ep1", name: "Old Episode", shots: [], assets: [],
    ledger: { budgetCapUSD: 12.5, confirmAboveUSD: 3, spentUSD: 4.25, entries: [{ at: "x", chargedUSD: 4.25 }] },
    timeline: { fps: 24, tracks: [{ id: "V1", kind: "video", name: "Picture", clips: [{ id: "c1" }] }] },
    // no `exports` field — simulates a Phase 0-3 episode predating Phase 4
  };
  const healed = ensureV2(onDisk);
  checkBool("backfill adds a missing top-level field (exports)", Array.isArray(healed.exports) && healed.exports.length === 0);
  checkBool("backfill preserves an existing ledger's budget cap", healed.ledger.budgetCapUSD === 12.5, `got ${healed.ledger.budgetCapUSD}`);
  checkBool("backfill preserves existing spend, does not reset it", healed.ledger.spentUSD === 4.25, `got ${healed.ledger.spentUSD}`);
  checkBool("backfill preserves existing ledger entries", healed.ledger.entries.length === 1 && healed.ledger.entries[0].chargedUSD === 4.25);
  checkBool("backfill adds a missing nested field (timeline.audioCues)", Array.isArray(healed.timeline.audioCues));
  checkBool("backfill preserves existing timeline clips", healed.timeline.tracks[0].clips.length === 1 && healed.timeline.tracks[0].clips[0].id === "c1");
}

console.log("\nSTALE LABEL PREFIX (carryover take labels — Shawn's \"2c - Overlock wakes\" example)");
{
  checkBool("dash-separated shot code is stripped",
    stripStaleLabelPrefix("2c - Overlock wakes and thrusts the scissors up") === "Overlock wakes and thrusts the scissors up");
  checkBool("em-dash-separated shot code is stripped",
    stripStaleLabelPrefix("3b — Boot kicks in the front door") === "Boot kicks in the front door");
  checkBool("space-only shot code (no separator) is stripped",
    stripStaleLabelPrefix("1a overlock workshop establishing") === "Overlock workshop establishing");
  checkBool("a real model label is left alone", stripStaleLabelPrefix("MiniMax H3") === "MiniMax H3");
  checkBool("a CapCut carryover note with no leading shot code is left alone",
    stripStaleLabelPrefix("CapCut draft 0629 (reused) — primary take") === "CapCut draft 0629 (reused) — primary take");
  checkBool("a shot_N style label (a different staleness, not this pattern) is left alone",
    stripStaleLabelPrefix("shot_10_overlock_peering.mp4") === "shot_10_overlock_peering.mp4");
}

console.log("\nASSET ALIASES (a script name linked to an existing registry asset counts as standing)");
{
  const registry = [newAsset({ type: "character", name: "Serge Stitch", seriesCanon: true, approved: true })];
  const scenesBefore = [{ number: "3", characters: ["Serge"], extras: [], props: [] }];
  const before = newAssetAudit(scenesBefore, registry);
  checkBool("without an alias, a naming mismatch shows as new",
    before.new.some((r) => r.name === "Serge") && !before.standing.some((r) => r.name === "Serge"),
    JSON.stringify({ new: before.new, standing: before.standing }));

  registry[0].aliases = ["Serge"];
  const after = newAssetAudit(scenesBefore, registry);
  checkBool("once aliased, the same script name counts as standing",
    after.standing.some((r) => r.name === "Serge" && r.assetId === registry[0].id) && !after.new.some((r) => r.name === "Serge"),
    JSON.stringify({ new: after.new, standing: after.standing }));
  checkBool("the alias resolves to the RIGHT registry asset, not just any match",
    after.standing.find((r) => r.name === "Serge").assetId === registry[0].id);
}

console.log(`\n${fail === 0 ? "✓" : "✗"} parity (incl. schema backfill): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
