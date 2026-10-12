// "Add sound to my Resolve cut" (Shawn, 2026-10-08). The app's own timeline is
// the full-length rough assembly; his real edit lives in Resolve. So the
// sound the app makes — Dialogue lines and per-scene room tone — is placed on
// HIS cut: read his latest Resolve FCPXML (server/cut.js says which part of
// which take plays where), work out where each line and each scene's loop
// belongs, and write a copy of his file with those audio clips added as
// connected clips. Nothing of his is changed; his file is never overwritten.
//
// Placement:
// - A line voiced from the take (origin "take") is anchored to the take: the
//   segment where that part of the take plays. A continuous take with a
//   cutaway (2e around 2c) keeps the line in sync on both sides.
// - Any other recording starts at its shot's first picture, flagged "place by
//   ear" — the app can't know where in the shot it belongs.
// - Room tone: the scene's in-edit loop tiled from the scene's first picture
//   to its last, the last copy cut to fit.
// Our clips are named "RC Dialogue — …" / "RC Room tone — …"; a re-run on an
// export that already carries them removes the old ones first.

import path from "node:path";
import * as cut from "./cut.js";
import { frameFraction, secToFrames } from "./export/timeutil.js";

export const RC_PREFIX = /^RC (Dialogue|SFX|Room tone) — /;
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---------- plan: where everything goes, in seconds on HIS timeline ----------

export function planSound(ep, analysis) {
  const warnings = [];
  const segs = analysis.segments.filter((s) => !s.gap && s.shotId);
  const segsOf = (shotId) => segs.filter((s) => s.shotId === shotId);
  const dialogue = [];

  for (const shot of ep.shots || []) {
    for (const beat of shot.beats || []) {
      const d = beat.dialogue;
      const rec = d && d.useClipId && (shot.audioClips || []).find((c) => c.id === d.useClipId);
      if (!rec || !rec.path || !(Number(rec.seconds) > 0)) continue;
      const code = `${shot.sceneNum}${shot.shotCode}`;
      const mine = segsOf(shot.id);
      if (!mine.length) { warnings.push(`${code}: “${d.line}” — the shot isn't in this cut, line skipped`); continue; }
      const dur = Number(rec.seconds);
      let at, inPoint = 0, note = "";
      if (rec.origin === "take" && Number.isFinite(Number(rec.offsetSec))) {
        const off = Number(rec.offsetSec);
        const sameTake = mine.filter((s) => s.versionId === rec.sourceVersionId);
        const anchor = sameTake.find((s) => off >= s.srcIn - 1e-3 && off < s.srcOut) || sameTake[0];
        if (anchor) {
          at = anchor.start + (off - anchor.srcIn);
          const first = mine[0].start;
          if (at < first - 0.04) note = `starts ${(first - at).toFixed(2)} s before its picture — the cut trims the take's head; this keeps the line in sync`;
        } else {
          at = mine[0].start; note = "voiced from a take that isn't in the cut — check its sync";
        }
      } else {
        at = mine[0].start; note = "place by ear (not voiced from the take, so its spot in the shot is unknown)";
      }
      if (at < 0) { inPoint = -at; at = 0; }
      if (inPoint >= dur) { warnings.push(`${code}: line falls before the cut starts, skipped`); continue; }
      dialogue.push({ shotId: shot.id, code, line: d.line, path: rec.path, seconds: dur, at: r3(at), inPoint: r3(inPoint), dur: r3(dur - inPoint), note });
      if (note) warnings.push(`${code}: ${note}`);
    }
  }

  // SFX: made from the whole take, so take time 0 = the file's start.
  // Anchored like a take-voiced line: to a segment of that take.
  const sfx = [];
  for (const shot of ep.shots || []) {
    const t = shot.sfx && shot.sfx.useId && (shot.sfx.takes || []).find((x) => x.id === shot.sfx.useId);
    if (!t || !(t.seconds > 0)) continue;
    const code = `${shot.sceneNum}${shot.shotCode}`;
    const mine = segsOf(shot.id);
    if (!mine.length) { warnings.push(`${code}: SFX — the shot isn't in this cut, skipped`); continue; }
    const sameTake = mine.filter((s) => s.versionId === t.sourceVersionId);
    let at, note = "";
    if (sameTake.length) at = sameTake[0].start - sameTake[0].srcIn;
    else { at = mine[0].start; note = "made from a take that isn't in the cut — check its sync"; warnings.push(`${code}: SFX ${note}`); }
    let inPoint = 0;
    if (at < 0) { inPoint = -at; at = 0; }
    // Only the part of the take the cut uses (plus what lies between its
    // segments) is needed: clip the tail at the last segment of that take.
    const lastEnd = Math.max(...(sameTake.length ? sameTake : mine).map((s) => s.end));
    const dur = Math.min(t.seconds - inPoint, lastEnd - at);
    if (dur <= 0.04) continue;
    sfx.push({ shotId: shot.id, code, label: t.label, path: t.path, seconds: t.seconds, at: r3(at), inPoint: r3(inPoint), dur: r3(dur), note });
  }

  const roomtone = [];
  const sceneOfShot = new Map((ep.shots || []).map((s) => [s.id, String(s.sceneNum)]));
  for (const sc of ep.scenes || []) {
    const rt = sc.roomTone;
    const take = rt && rt.useId && (rt.takes || []).find((t) => t.id === rt.useId);
    if (!take || !(take.seconds > 0)) continue;
    const mine = segs.filter((s) => sceneOfShot.get(s.shotId) === String(sc.number));
    if (!mine.length) { warnings.push(`scene ${sc.number}: has room tone but no picture in this cut, skipped`); continue; }
    const start = Math.min(...mine.map((s) => s.start)), end = Math.max(...mine.map((s) => s.end));
    const tiles = [];
    for (let at = start, n = 0; at < end - 1e-3 && n < 500; at += take.seconds, n++) {
      tiles.push({ at: r3(at), inPoint: 0, dur: r3(Math.min(take.seconds, end - at)) });
    }
    roomtone.push({ sceneNum: String(sc.number), heading: sc.heading || "", path: take.path, seconds: take.seconds, start: r3(start), end: r3(end), tiles });
  }
  return { dialogue, sfx, roomtone, warnings, cutSeconds: analysis.sequence.duration };
}

// ---------- the raw-text spine scanner ----------
// His file is edited as TEXT (never re-serialized) so everything Resolve wrote
// survives byte for byte. This finds the spine's direct children and their
// connected clips, with positions.

const TAG = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], m[2] ?? m[3]]));

export function scanSpine(xml) {
  const spineOpen = xml.search(/<spine\b[^>]*>/);
  if (spineOpen < 0) throw new Error("No <spine> in this FCPXML.");
  TAG.lastIndex = spineOpen;
  const first = TAG.exec(xml); // the <spine> tag itself
  const children = [], nested = [];
  const stack = [];
  let m;
  while ((m = TAG.exec(xml))) {
    if (m[1]) { // closing tag
      const open = stack.pop();
      if (!open) break; // </spine>
      open.closeStart = m.index; open.closeEnd = TAG.lastIndex;
      continue;
    }
    if (!m[2]) continue; // comment / pi / doctype
    const node = { tag: m[2], attrs: attrsOf(m[3]), openStart: m.index, openEnd: TAG.lastIndex, selfClosing: !!m[4] };
    if (stack.length === 0) children.push(node);
    else if (stack.length === 1) { node.parent = stack[0]; nested.push(node); }
    if (!node.selfClosing) stack.push(node);
    else { node.closeStart = node.openEnd; node.closeEnd = node.openEnd; }
  }
  if (!first) throw new Error("Malformed spine.");
  return { children, nested };
}

// ---------- write ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function writeSoundCut(xml, plan, { root, fps = 24 }) {
  const fr = (sec) => frameFraction(secToFrames(sec, fps), fps);
  const parsed = cut.parseCut(xml);

  // 1. Remove clips a previous run added (by our name prefix).
  let { nested } = scanSpine(xml);
  const ours = nested.filter((n) => RC_PREFIX.test(n.attrs.name || "")).sort((a, b) => b.openStart - a.openStart);
  let removed = 0;
  for (const n of ours) {
    // Take the line's leading whitespace with it.
    let s = n.openStart; while (s > 0 && /[ \t]/.test(xml[s - 1])) s--;
    if (xml[s - 1] === "\n") s--;
    xml = xml.slice(0, s) + xml.slice(n.closeEnd);
    removed++;
  }

  // 2. Assets: reuse an existing one for the same file, else add one.
  const ids = [...xml.matchAll(/\bid="r(\d+)"/g)].map((m) => Number(m[1]));
  let nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  const assetByAbs = new Map(Object.values(parsed.assets).map((a) => [a.path, a.id]));
  const newAssets = [];
  const assetFor = (rel, seconds) => {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (assetByAbs.has(abs)) return assetByAbs.get(abs);
    const id = `r${nextId++}`;
    assetByAbs.set(abs, id);
    newAssets.push(`        <asset id="${id}" name="${esc(path.basename(abs))}" start="0/1s" duration="${fr(seconds)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2">\n            <media-rep kind="original-media" src="file://${esc(encodeURI(abs))}"/>\n        </asset>`);
    return id;
  };

  // 3. Lanes above everything already there (ignoring our old clips).
  const scan = scanSpine(xml);
  const maxLane = Math.max(0, ...scan.nested.map((n) => Number(n.attrs.lane || 0)).filter(Number.isFinite));
  const laneDialogue = maxLane + 1, laneRoom = maxLane + 2, laneSfx = maxLane + 3;

  // 4. Each clip hangs off the spine element its start falls in; its offset
  // is in that element's own time (its start attribute + distance in).
  const hosts = scan.children.filter((c) => c.tag !== "transition").map((c) => {
    const off = cut.rt(c.attrs.offset), dur = cut.rt(c.attrs.duration), st = cut.rt(c.attrs.start);
    return { node: c, tl: off, end: off + dur, start: st };
  });
  const inserts = new Map(); // host node -> [xml lines]
  const place = (atSec, line) => {
    const h = hosts.find((x) => atSec >= x.tl - 1e-6 && atSec < x.end - 1e-6) || hosts[hosts.length - 1];
    if (!h) throw new Error("This cut has no clips to attach sound to.");
    if (!inserts.has(h)) inserts.set(h, []);
    inserts.get(h).push(line(h.start + (atSec - h.tl)));
  };
  let added = 0;
  for (const d of plan.dialogue) {
    const ref = assetFor(d.path, d.seconds);
    place(d.at, (offSec) => `            <asset-clip ref="${ref}" lane="${laneDialogue}" offset="${fr(offSec)}" name="${esc(`RC Dialogue — ${d.code} ${d.line}`.slice(0, 120))}" start="${fr(d.inPoint)}" duration="${fr(d.dur)}" audioRole="dialogue"/>`);
    added++;
  }
  for (const f of plan.sfx || []) {
    const ref = assetFor(f.path, f.seconds);
    place(f.at, (offSec) => `            <asset-clip ref="${ref}" lane="${laneSfx}" offset="${fr(offSec)}" name="${esc(`RC SFX — ${f.code} ${f.label}`.slice(0, 120))}" start="${fr(f.inPoint)}" duration="${fr(f.dur)}" audioRole="effects"/>`);
    added++;
  }
  for (const r of plan.roomtone) {
    const ref = assetFor(r.path, r.seconds);
    r.tiles.forEach((t, i) => {
      place(t.at, (offSec) => `            <asset-clip ref="${ref}" lane="${laneRoom}" offset="${fr(offSec)}" name="${esc(`RC Room tone — scene ${r.sceneNum}${i ? ` (loop ${i + 1})` : ""}`)}" start="0/1s" duration="${fr(t.dur)}" audioRole="effects"/>`);
      added++;
    });
  }

  // 5. Splice, back to front so earlier positions stay valid.
  const edits = [];
  for (const [h, lines] of inserts) {
    const n = h.node, body = `\n${lines.join("\n")}\n`;
    if (n.selfClosing) {
      const open = xml.slice(n.openStart, n.openEnd).replace(/\s*\/>$/, ">");
      edits.push({ from: n.openStart, to: n.openEnd, text: `${open}${body}                        </${n.tag}>` });
    } else {
      edits.push({ from: n.closeStart, to: n.closeStart, text: `${body}                        ` });
    }
  }
  if (newAssets.length) {
    const at = xml.indexOf("</resources>");
    if (at < 0) throw new Error("No </resources> in this FCPXML.");
    edits.push({ from: at, to: at, text: `${newAssets.join("\n")}\n    ` });
  }
  edits.sort((a, b) => b.from - a.from);
  for (const e of edits) xml = xml.slice(0, e.from) + e.text + xml.slice(e.to);
  return { xml, added, removed, lanes: { dialogue: laneDialogue, roomTone: laneRoom, sfx: laneSfx } };
}
