// Timeline assembly. Turns the shot list's selected takes into a real
// sequence: measures each file with ffprobe (never trusts a requested
// duration), places clips back-to-back on V1 in shot-list order, and pulls
// the dialogue/SFX/music text already captured per beat into a cue list for
// the edit sheet — see server/export/capcut.js for why those stay text, not
// timeline clips, until the pipeline produces separate audio files.

import * as store from "./store.js";
import { probe } from "./ffprobe.js";
import { newTimelineClip, clipDurationSec, beatAudio } from "../shared/schema.js";
import { roomToneClips } from "./roomtone.js";
import { dialogueStr } from "../shared/prompts.js";
import { trimSpans, takeTimeToTimeline } from "../shared/trim.js";

// beatAudio/dialogueStr actually live in schema.js / prompts.js respectively —
// import dialogueStr from prompts.js to reuse the exact same formatting the
// shot prompts already use, so the edit sheet and the generation prompts
// never describe the same line differently.

// Get-or-create the Nth video track (0 -> V1, 1 -> V2, ...), inserted ahead
// of the first audio track so the tracks array stays in a sane visual order.
// Alt tracks (V2+) persist even when a rebuild finds nothing for them this
// time — see the trailing loop below, which just empties their clips rather
// than removing the track, so a clip/trim route or export referencing a
// track id doesn't have to worry about it vanishing between rebuilds.
function ensureVideoTrack(ep, index) {
  const id = index === 0 ? "V1" : `V${index + 1}`;
  let t = ep.timeline.tracks.find((tr) => tr.id === id);
  if (!t) {
    t = { id, kind: "video", name: index === 0 ? "Picture" : `Alt ${index + 1}`, clips: [] };
    const audioIdx = ep.timeline.tracks.findIndex((tr) => tr.kind === "audio");
    if (audioIdx === -1) ep.timeline.tracks.push(t); else ep.timeline.tracks.splice(audioIdx, 0, t);
  }
  return t;
}

// Rebuild the video tracks from the shot list's current selections. A shot's
// FIRST selected take (index 0) is the primary — it alone drives the V1
// spine and the timeline cursor, exactly as the single-take version of this
// function always worked. Any further selected takes are alternates: they
// land on their own track (V2, V3...) starting at the SAME timeline position
// as the shot's primary clip, so Shawn can audition/razor between them in
// Resolve — they never affect pacing or the cursor. Existing clips are
// re-probed only if missing sourceDurationSec, so re-running this after
// tweaking trims elsewhere doesn't clobber those trims.
export async function rebuildFromSelection(ep) {
  const clipsByTrack = {}; // trackId -> clips this rebuild produced
  const audioCues = [];
  const dialogueClips = [];
  let cursor = 0;

  for (const shot of ep.shots || []) {
    if (shot.cutFromEdit) continue; // in the "Cut from edit" bin: not part of the edit
    const selected = shot.selectedVersions || [];
    if (!selected.length) continue;
    // The primary must resolve to a real, finished take or the shot sits out
    // of the timeline entirely this rebuild (matches the old behavior when
    // selectedVersion pointed at nothing usable) — a dangling alt elsewhere
    // in the array is fine and just leaves a gap on its own track below.
    const primary = (shot.versions || []).find((v) => v.id === selected[0] && v.state === "done" && v.path);
    if (!primary) continue;

    const shotStartSec = cursor;
    let primaryClip = null, primaryClips = [], primarySpans = [];

    for (let i = 0; i < selected.length; i++) {
      const version = (shot.versions || []).find((v) => v.id === selected[i] && v.state === "done" && v.path);
      if (!version) continue; // a deleted/unfinished alt — skip just this slot

      const track = ensureVideoTrack(ep, i);
      const existing = (track.clips || []).find((c) => c.versionId === version.id);
      let probed = existing && existing.sourceDurationSec != null
        ? { durationSec: existing.sourceDurationSec, fps: existing.fps, width: existing.width, height: existing.height, hasAudio: existing.hasAudio }
        : null;
      if (!probed) {
        const abs = store.safeResolve(version.path);
        probed = await probe(abs);
      }

      const baseName = `${shot.sceneNum}${shot.shotCode}${shot.label ? ` — ${shot.label}` : ""}${i > 0 ? ` (alt ${i + 1})` : ""}`;
      // A take's own marks: in/out plus cut-outs. Several kept pieces make
      // several clips from the same file, back to back from the shot's start.
      const tt = shot.takeTrims && shot.takeTrims[version.id];
      const spans = tt ? trimSpans(tt, probed.durationSec) : null;
      const made = [];

      if (!spans || spans.length <= 1) {
        // A clip that was once several pieces must not hand its old trims to
        // the single clip it has become.
        const prior = existing && !(existing.spanCount > 1) ? existing : null;
        const clip = newTimelineClip({
          id: prior?.id || existing?.id,
          shotId: shot.id,
          versionId: version.id,
          sourcePath: version.path,
          name: baseName,
          kind: "video",
          sourceDurationSec: probed.durationSec,
          headTrimSec: prior?.headTrimSec ?? 0,
          tailTrimSec: prior?.tailTrimSec ?? 0,
          startSec: shotStartSec,
        });
        // Remaster: a new primary take was generated at the cut's span plus a
        // handle each end, so its first build is trimmed to the cut's timing —
        // head = the handle, tail = whatever is left past the span. A clip that
        // already exists keeps its trims (Shawn may have changed them).
        const rm = shot.remaster;
        if (!prior && i === 0 && rm && Number(rm.spanSec) > 0) {
          const dur = probed.durationSec;
          const head = Math.min(Number(rm.handlesSec) || 0, dur);
          clip.headTrimSec = Math.round(head * 1000) / 1000;
          clip.tailTrimSec = Math.round(Math.max(0, dur - head - Number(rm.spanSec)) * 1000) / 1000;
        }
        // A take's own in/out ("use 3–7 s") wins over everything: Shawn set it
        // on the take, so every rebuild and export follows it.
        if (spans && spans.length === 1) {
          clip.headTrimSec = spans[0].inSec;
          clip.tailTrimSec = Math.round(Math.max(0, probed.durationSec - spans[0].outSec) * 1000) / 1000;
        }
        made.push(clip);
      } else {
        let at = shotStartSec;
        spans.forEach((sp, k) => {
          const ex = (track.clips || []).find((c) => c.versionId === version.id && c.spanCount > 1 && c.spanIndex === k);
          made.push(newTimelineClip({
            id: ex?.id,
            shotId: shot.id,
            versionId: version.id,
            sourcePath: version.path,
            name: `${baseName} [${k + 1}/${spans.length}]`,
            kind: "video",
            sourceDurationSec: probed.durationSec,
            headTrimSec: sp.inSec,
            tailTrimSec: Math.round(Math.max(0, probed.durationSec - sp.outSec) * 1000) / 1000,
            startSec: Math.round(at * 1000) / 1000,
            spanIndex: k,
            spanCount: spans.length,
          }));
          at += sp.outSec - sp.inSec;
        });
      }
      for (const clip of made) {
        clip.fps = probed.fps || 24;
        clip.width = probed.width;
        clip.height = probed.height;
        clip.hasAudio = probed.hasAudio;
        (clipsByTrack[track.id] ||= []).push(clip);
      }
      if (i === 0) {
        primaryClips = made;
        primaryClip = made[0];
        // Where each kept piece sits in the take's own time (for lines that
        // were voiced from the take).
        primarySpans = made.map((c) => ({ inSec: c.headTrimSec || 0, outSec: probed.durationSec - (c.tailTrimSec || 0) }));
      }
    }

    // Each line's "Use in edit" recording goes on the Dialogue track (A1). A
    // recording voiced from the take's own audio keeps the take's timing, so
    // it sits at the take's time: shot start + (offset in the take − the
    // clip's head trim). Anything else starts at the shot start, for Shawn
    // to slide in Resolve. A head that falls before the shot is trimmed off.
    if (primaryClip) {
      for (const beat of shot.beats || []) {
        const useId = beat.dialogue && beat.dialogue.useClipId;
        const rec = useId && (shot.audioClips || []).find((c) => c.id === useId);
        if (!rec || !rec.path) continue;
        const recSec = Number(rec.seconds);
        if (!Number.isFinite(recSec) || recSec <= 0) continue;
        let at = shotStartSec, head = 0;
        if (rec.origin === "take" && Number.isFinite(Number(rec.offsetSec))) {
          at = takeTimeToTimeline(primarySpans, shotStartSec, Number(rec.offsetSec));
          if (rec.sourceVersionId && rec.sourceVersionId !== primaryClip.versionId) {
            audioCues.push({ kind: "Note", atSec: shotStartSec, shotCode: `${shot.sceneNum}${shot.shotCode}`, text: "Dialogue was voiced from a different take than the one selected — check its sync." });
          }
        }
        if (at < shotStartSec) { head = shotStartSec - at; at = shotStartSec; }
        if (head >= recSec) continue;
        dialogueClips.push(newTimelineClip({
          shotId: shot.id, sourcePath: rec.path, kind: "dialogue",
          name: `${shot.sceneNum}${shot.shotCode} dialogue — ${(rec.label || "").slice(0, 60)}`,
          sourceDurationSec: recSec, headTrimSec: Math.round(head * 1000) / 1000, startSec: Math.round(at * 1000) / 1000,
          text: beat.dialogue.line,
        }));
      }
    }

    // Audio cues from the shot's beats, positioned at this clip's timeline
    // start — a beat-accurate offset within the clip isn't tracked once video
    // generation has flattened the beats into one take, so the cue marks the
    // shot's start, which is enough for an editor to find the moment by eye.
    for (const beat of shot.beats || []) {
      const dia = dialogueStr(beat, ep);
      if (dia) audioCues.push({ kind: "Dialogue", atSec: shotStartSec, shotCode: `${shot.sceneNum}${shot.shotCode}`, text: dia });
      const a = beatAudio(shot, beat);
      if (a.sfx && a.sfx.trim()) audioCues.push({ kind: "SFX", atSec: shotStartSec, shotCode: `${shot.sceneNum}${shot.shotCode}`, text: a.sfx.trim() });
      if (a.music && a.music.trim()) audioCues.push({ kind: "Music", atSec: shotStartSec, shotCode: `${shot.sceneNum}${shot.shotCode}`, text: a.music.trim() });
    }

    cursor = shotStartSec + primaryClips.reduce((t, c) => t + clipDurationSec(c), 0);
  }

  for (const t of ep.timeline.tracks) {
    if (t.kind === "video") t.clips = clipsByTrack[t.id] || [];
  }
  // Audio-only clips: no picture, so the exporter writes them without a
  // video format.
  for (const c of dialogueClips) { c.hasVideo = false; c.hasAudio = true; c.fps = ep.timeline.fps || 24; }
  let a1 = ep.timeline.tracks.find((t) => t.id === "A1");
  if (!a1) { a1 = { id: "A1", kind: "audio", name: "Dialogue", clips: [] }; ep.timeline.tracks.push(a1); }
  a1.clips = dialogueClips;
  // SFX (A2): each shot's in-edit variant, made from the whole take, so it
  // starts at the take's time zero (shot start − the picture's head trim).
  const sfxClips = [];
  for (const c of clipsByTrack.V1 || []) {
    const shot = (ep.shots || []).find((x) => x.id === c.shotId);
    const t = shot && shot.sfx && shot.sfx.useId && shot.sfx.takes.find((x) => x.id === shot.sfx.useId);
    if (!t || !(t.seconds > 0)) continue;
    let at = c.startSec - (c.headTrimSec || 0), head = 0;
    if (at < c.startSec) { head = c.startSec - at; at = c.startSec; }
    if (head >= t.seconds) continue;
    const clip = newTimelineClip({ shotId: shot.id, sourcePath: t.path, kind: "sfx", name: `${shot.sceneNum}${shot.shotCode} SFX — ${t.label}`, sourceDurationSec: t.seconds, headTrimSec: Math.round(head * 1000) / 1000, startSec: Math.round(at * 1000) / 1000, text: t.prompt });
    // A take cut into several pieces: each piece carries only its own stretch
    // of the SFX, so the sound does not run on across a cut-out.
    if (c.spanCount > 1) clip.tailTrimSec = Math.round(Math.max(0, t.seconds - head - clipDurationSec(c)) * 1000) / 1000;
    clip.hasVideo = false; clip.hasAudio = true; clip.fps = ep.timeline.fps || 24;
    sfxClips.push(clip);
  }
  let a2 = ep.timeline.tracks.find((t) => t.id === "A2");
  if (!a2) { a2 = { id: "A2", kind: "audio", name: "SFX", clips: [] }; ep.timeline.tracks.push(a2); }
  a2.clips = sfxClips;
  // Room tone (A4): each scene's in-edit loop tiled across the scene.
  const v1Spans = (clipsByTrack.V1 || []).map((c) => ({ shotId: c.shotId, startSec: c.startSec, durationSec: clipDurationSec(c) }));
  const rtClips = roomToneClips(ep, v1Spans, newTimelineClip);
  for (const c of rtClips) { c.hasVideo = false; c.hasAudio = true; c.fps = ep.timeline.fps || 24; }
  let a4 = ep.timeline.tracks.find((t) => t.id === "A4");
  if (!a4) { a4 = { id: "A4", kind: "audio", name: "Room tone", clips: [] }; ep.timeline.tracks.push(a4); }
  a4.clips = rtClips;
  ep.timeline.fps = clipsByTrack.V1?.[0]?.fps || ep.timeline.fps || 24;
  ep.timeline.audioCues = audioCues; // the export routes read this, not recompute it
  return { clips: clipsByTrack.V1 || [], audioCues, totalSec: cursor };
}

// { inSec, outSec } on a take → head/tail trims for a file `dur` long. Nulls
// mean the file's own start / end; values are clamped into the file.
export function trimFromInOut({ inSec, outSec } = {}, dur) {
  const d = Number(dur) || 0;
  const a = Math.min(Math.max(0, Number(inSec) || 0), d);
  const b = outSec == null ? d : Math.min(Math.max(a, Number(outSec)), d);
  const r = (x) => Math.round(x * 1000) / 1000;
  return { headTrimSec: r(a), tailTrimSec: r(Math.max(0, d - b)) };
}

// Re-sequence startSec for every clip on a track after a trim or reorder
// changes an earlier clip's effective duration — keeps clips back-to-back
// with no manual offset bookkeeping.
export function resequence(track) {
  let cursor = 0;
  for (const c of track.clips) {
    c.startSec = cursor;
    cursor += clipDurationSec(c);
  }
  return cursor;
}

export function clipsByTrackId(ep) {
  const out = {};
  for (const t of ep.timeline.tracks) out[t.id] = t.clips;
  return out;
}
