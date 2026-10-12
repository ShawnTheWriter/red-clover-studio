// Read an edited cut back from Resolve (FCPXML 1.x, a .fcpxml file or a
// .fcpxmld bundle) and map every clip to the shot and take it came from.
//
// This is the shared first step of two tools: "Organize folders and footage
// from XML" and "Create Remaster project from XML". Nothing here writes: it
// returns an analysis that both tools preview before anything changes.
//
// The rules below come from Shawn's own reading of his first Resolve cut
// (2026-10-07):
// - What counts is the VISIBLE picture: at each moment, the enabled video clip
//   on the highest lane. A clip that is fully covered by another is editing
//   mess, not a choice.
// - A shot can be "in" the cut (some visible picture), "audio" (its sound is
//   used but no picture), or "cut" (nothing used). Cut shots are kept, never
//   deleted — they may come back.
// - Connected clips can hang off a <gap> as well as off a clip. Missing those
//   once made a 2 s shot look like black.
// - Scene order is the order scenes first appear in the cut.

import fs from "node:fs/promises";
import path from "node:path";

// ---------- minimal XML reader (zero deps) ----------
// FCPXML is attribute-heavy and has no meaningful text content, so a tag-level
// tokenizer is enough: elements, attributes, nesting. Text nodes are ignored.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});

export function parseXml(text) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) {
      if (stack.length > 1 && stack[stack.length - 1].tag === m[1]) stack.pop();
      else throw new Error(`Malformed XML: unexpected </${m[1]}>`);
    } else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node = { tag: m[2], attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!m[4]) stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: <${stack[stack.length - 1].tag}> is never closed`);
  return root;
}

const find = (node, tag) => {
  for (const c of node.children) {
    if (c.tag === tag) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return null;
};
const all = (node, tag, out = []) => {
  for (const c of node.children) { if (c.tag === tag) out.push(c); all(c, tag, out); }
  return out;
};

// FCPXML rational time: "1067/8s", "0s", "5s".
export function rt(s) {
  if (!s) return 0;
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(String(s).trim());
  if (!m) throw new Error(`Bad FCPXML time "${s}"`);
  return Number(m[1]) / Number(m[2] || 1);
}

const r3 = (n) => Math.round(n * 1000) / 1000;

export function fileUrlToPath(src) {
  if (!src) return null;
  if (!src.startsWith("file://")) return src;
  return decodeURIComponent(src.replace(/^file:\/\//, ""));
}

// ---------- FCPXML -> flat clip list ----------

export function parseCut(xmlText) {
  const doc = parseXml(xmlText);
  const fcpxml = find(doc, "fcpxml") || doc;
  const formats = Object.fromEntries(all(fcpxml, "format").map((f) => [f.attrs.id, f.attrs]));
  const assets = {};
  for (const a of all(fcpxml, "asset")) {
    const rep = a.children.find((c) => c.tag === "media-rep");
    assets[a.attrs.id] = {
      id: a.attrs.id,
      name: a.attrs.name,
      path: fileUrlToPath(rep ? rep.attrs.src : a.attrs.src),
      hasVideo: a.attrs.hasVideo === "1",
      hasAudio: a.attrs.hasAudio === "1",
      duration: rt(a.attrs.duration),
      durationRaw: a.attrs.duration || "0s",
      format: a.attrs.format || null,
    };
  }
  const project = find(fcpxml, "project");
  const sequence = find(project || fcpxml, "sequence");
  if (!sequence) throw new Error("No <sequence> in this FCPXML.");
  const spine = sequence.children.find((c) => c.tag === "spine");
  if (!spine) throw new Error("The sequence has no <spine>.");
  const fmt = formats[sequence.attrs.format] || {};
  const fd = fmt.frameDuration ? rt(fmt.frameDuration) : 1 / 24;

  const clips = [];
  // A connected clip's offset is in its PARENT's time, which starts at the
  // parent's `start` (gaps commonly start at 3600s). Timeline position =
  // parent's timeline position + (offset - parent.start).
  const walk = (node, parentTl, parentStart, parentEnabled) => {
    for (const c of node.children) {
      if (!["asset-clip", "clip", "gap", "ref-clip", "sync-clip"].includes(c.tag)) continue;
      const off = rt(c.attrs.offset), start = rt(c.attrs.start), dur = rt(c.attrs.duration);
      const tl = parentTl == null ? off : parentTl + (off - parentStart);
      const enabled = parentEnabled && c.attrs.enabled !== "0";
      const lane = Number(c.attrs.lane || 0);
      if (c.tag === "asset-clip") {
        const a = assets[c.attrs.ref] || {};
        const srcEnable = c.attrs.srcEnable || "all";
        if (a.hasVideo && srcEnable !== "audio") clips.push({ kind: "video", tl, dur, srcIn: start, lane, enabled, assetId: c.attrs.ref, name: c.attrs.name });
        if (a.hasAudio && srcEnable !== "video" && (!a.hasVideo || srcEnable === "audio")) clips.push({ kind: "audio", tl, dur, srcIn: start, lane, enabled, assetId: c.attrs.ref, name: c.attrs.name });
      } else if (c.tag === "clip") {
        // Resolve writes a plain <clip> wrapping a <video> and/or <audio> that
        // carry the asset ref. Source in = clip.start mapped through the child.
        for (const k of c.children) {
          if (k.tag !== "video" && k.tag !== "audio") continue;
          const srcIn = start - rt(k.attrs.offset) + rt(k.attrs.start);
          clips.push({ kind: k.tag, tl, dur, srcIn, lane, enabled, assetId: k.attrs.ref, name: c.attrs.name });
        }
      }
      walk(c, tl, start, enabled);
    }
  };
  walk(spine, null, 0, true);

  return {
    sequence: {
      name: (project && project.attrs.name) || "",
      duration: rt(sequence.attrs.duration),
      fps: Math.round(1 / fd),
      width: Number(fmt.width) || null,
      height: Number(fmt.height) || null,
    },
    assets,
    clips: clips.map((c) => ({ ...c, tl: r3(c.tl), dur: r3(c.dur), srcIn: r3(c.srcIn) })),
  };
}

// ---------- visible picture ----------
// Split the timeline at every clip edge; in each slice the enabled video clip
// on the highest lane is what the viewer sees. Adjacent slices of the same
// clip merge back together. Empty slices are gaps.
// Edges are snapped to whole frames first: summing float seconds otherwise
// leaves 1 ms slivers that read as false gaps.
export function flattenPicture(clips, seqDuration, fps = 24) {
  const vids = clips.filter((c) => c.kind === "video" && c.enabled);
  const fr = (sec) => Math.round(sec * fps) / fps;
  const edges = new Set([0]);
  for (const c of vids) { edges.add(fr(c.tl)); edges.add(fr(c.tl + c.dur)); }
  if (seqDuration) edges.add(fr(seqDuration));
  const pts = [...edges].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    let top = null;
    for (const c of vids) if (c.tl <= mid && mid < c.tl + c.dur && (!top || c.lane > top.lane)) top = c;
    const last = segs[segs.length - 1];
    if (last && last.clip === top) last.end = b;
    else segs.push({ start: a, end: b, clip: top });
  }
  const visible = new Set(segs.filter((s) => s.clip).map((s) => s.clip));
  return {
    segments: segs.map((s) => ({
      start: r3(s.start), end: r3(s.end), gap: !s.clip,
      ...(s.clip ? { assetId: s.clip.assetId, lane: s.clip.lane, srcIn: r3(s.clip.srcIn + (s.start - s.clip.tl)), srcOut: r3(s.clip.srcIn + (s.end - s.clip.tl)) } : {}),
    })),
    covered: vids.filter((c) => !visible.has(c)),
  };
}

// ---------- map to the episode ----------
// A take's file name ends in its version id (…_<id>.mp4) for everything the
// app generated or imported. Carryovers keep their old names, so they match
// on the full path instead. Shot codes in file names are NOT trusted: they go
// stale every time shots move.
export function takeIndex(ep, root) {
  const byId = new Map(), byPath = new Map(), byRel = [];
  for (const s of ep.shots || []) {
    for (const v of s.versions || []) {
      byId.set(v.id, { shot: s, version: v });
      if (v.path) {
        const abs = path.isAbsolute(v.path) ? v.path : path.join(root, v.path);
        if (!byPath.has(abs)) byPath.set(abs, []);
        byPath.get(abs).push({ shot: s, version: v });
        if (!path.isAbsolute(v.path)) byRel.push({ rel: v.path, shot: s, version: v });
      }
    }
  }
  return {
    lookup(absPath) {
      if (!absPath) return null;
      const stem = path.basename(absPath).replace(/\.[^.]+$/, "");
      const id = stem.split("_").pop();
      if (byId.has(id)) return byId.get(id);
      // Fallback: the file sits under a DIFFERENT project root (a scratch
      // copy, a moved Drive folder, another machine) — match the tail.
      let hits = byPath.get(absPath) || [];
      if (!hits.length) hits = byRel.filter((h) => absPath.endsWith(`/${h.rel}`));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        // Same carryover file on several shots: prefer the shot that has it selected.
        const sel = hits.filter((h) => (h.shot.selectedVersions || []).includes(h.version.id));
        return sel.length === 1 ? sel[0] : { ambiguous: hits };
      }
      return null;
    },
  };
}

const shotCode = (s) => `${s.sceneNum ?? ""}${s.shotCode ?? ""}`;

export function analyzeCut(ep, parsed, root) {
  const idx = takeIndex(ep, root);
  const matchAsset = new Map();
  const unmatched = [], ambiguous = [];
  for (const a of Object.values(parsed.assets)) {
    const hit = idx.lookup(a.path);
    if (!hit) unmatched.push({ name: a.name, path: a.path });
    else if (hit.ambiguous) ambiguous.push({ name: a.name, path: a.path, shots: hit.ambiguous.map((h) => shotCode(h.shot)) });
    else matchAsset.set(a.id, hit);
  }
  const { segments, covered } = flattenPicture(parsed.clips, parsed.sequence.duration, parsed.sequence.fps);

  const perShot = new Map();
  const entry = (shot) => {
    if (!perShot.has(shot.id)) perShot.set(shot.id, { shotId: shot.id, code: shotCode(shot), sceneNum: String(shot.sceneNum ?? ""), label: shot.label || "", firstAt: null, visibleSeconds: 0, parts: [], audioUses: [] });
    return perShot.get(shot.id);
  };

  const outSegments = [];
  for (const sg of segments) {
    if (sg.gap) { outSegments.push(sg); continue; }
    const hit = matchAsset.get(sg.assetId);
    if (!hit) { outSegments.push({ ...sg, unmatched: parsed.assets[sg.assetId]?.name || sg.assetId }); continue; }
    const e = entry(hit.shot);
    if (e.firstAt == null) e.firstAt = sg.start;
    e.visibleSeconds = r3(e.visibleSeconds + (sg.end - sg.start));
    // One part per (shot, take): the span from the earliest to the latest
    // source frame used. A cutaway inside a continuous take (2e around 2c)
    // stays one part; two different takes (3a) become two parts.
    let p = e.parts.find((x) => x.versionId === hit.version.id);
    if (!p) { p = { versionId: hit.version.id, srcIn: sg.srcIn, srcOut: sg.srcOut, at: [] }; e.parts.push(p); }
    p.srcIn = Math.min(p.srcIn, sg.srcIn);
    p.srcOut = Math.max(p.srcOut, sg.srcOut);
    p.at.push({ start: sg.start, end: sg.end });
    outSegments.push({ ...sg, shotId: hit.shot.id, code: shotCode(hit.shot), versionId: hit.version.id });
  }

  for (const c of parsed.clips) {
    if (c.kind !== "audio" || !c.enabled) continue;
    const hit = matchAsset.get(c.assetId);
    if (!hit) continue;
    entry(hit.shot).audioUses.push({ versionId: hit.version.id, start: c.tl, end: r3(c.tl + c.dur), srcIn: c.srcIn, lane: c.lane });
  }

  const shots = (ep.shots || []).map((s) => {
    const e = perShot.get(s.id) || { shotId: s.id, code: shotCode(s), sceneNum: String(s.sceneNum ?? ""), label: s.label || "", firstAt: null, visibleSeconds: 0, parts: [], audioUses: [] };
    const status = e.parts.length ? "in" : e.audioUses.length ? "audio" : "cut";
    return { ...e, status };
  });

  // Scene order = first appearance of any of its shots' picture in the cut.
  const firstByScene = new Map();
  for (const s of shots) if (s.firstAt != null && (!firstByScene.has(s.sceneNum) || s.firstAt < firstByScene.get(s.sceneNum))) firstByScene.set(s.sceneNum, s.firstAt);
  const sceneOrder = [...firstByScene.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  const allScenes = [...new Set([...(ep.scenes || []).map((s) => String(s.number)), ...shots.map((s) => s.sceneNum)])];
  const scenesNotInCut = allScenes.filter((n) => !firstByScene.has(n));

  return {
    sequence: parsed.sequence,
    segments: outSegments,
    shots,
    sceneOrder,
    scenesNotInCut,
    gaps: outSegments.filter((s) => s.gap).map((s) => ({ start: s.start, end: s.end })),
    covered: covered.map((c) => ({ start: c.tl, end: r3(c.tl + c.dur), lane: c.lane, name: c.name, versionId: matchAsset.get(c.assetId)?.version.id || null })),
    unmatched,
    ambiguous,
  };
}

// Accept a .fcpxml file or a .fcpxmld bundle (a folder holding Info.fcpxml).
export async function readCutFile(absPath) {
  const st = await fs.stat(absPath);
  const file = st.isDirectory() ? path.join(absPath, "Info.fcpxml") : absPath;
  return fs.readFile(file, "utf8");
}
