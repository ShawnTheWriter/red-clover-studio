// CapCut fallback path — not an XML import, an ordered folder plus a
// human-readable edit sheet.
//
// Per the plan's own open item: Resolve is the NLE target because it's the
// only one where the researched XML-export feature works as advertised, but
// CapCut stays Shawn's habit and its import formats are restrictive. Rather
// than resolve that by guessing what Shawn's CapCut build accepts, this gives
// him the one format every edit tool accepts — numbered files in cut order —
// plus the same trim/dialogue/SFX notes house-style.md's "Edit handoff notes"
// already call for, generated from the real beat data instead of invented.

import path from "node:path";
import { clipDurationSec } from "../../shared/schema.js";

export function buildEditSheet(clipsByTrack, opts = {}) {
  const v1 = clipsByTrack.V1 || [];
  const altTrackIds = [];
  for (let i = 2; clipsByTrack[`V${i}`]; i++) altTrackIds.push(`V${i}`);
  const lines = [];
  lines.push(`# ${opts.projectName || "Edit sheet"}`);
  lines.push("");
  lines.push("Cut order, trims, and audio cues per house-style.md's Phase 6 edit handoff notes.");
  lines.push("Trim range is a suggestion to confirm by eye per clip, not an applied value.");
  lines.push("");
  lines.push("| # | Source file | Duration (trimmed) | Head trim | Tail trim | Notes |");
  lines.push("|---|---|---|---|---|---|");

  let running = 0;
  v1.forEach((c, i) => {
    const dur = clipDurationSec(c);
    running += dur;
    // A take cut into several pieces is ONE file: every piece's row names the
    // numbered copy made for the first piece.
    const firstIdx = v1.findIndex((x) => x.sourcePath === c.sourcePath && x.versionId === c.versionId);
    const numbered = `${String((firstIdx >= 0 ? firstIdx : i) + 1).padStart(2, "0")}_${path.basename(c.sourcePath)}`;
    const suggestedHead = c.headTrimSec ? `${c.headTrimSec.toFixed(2)}s` : "0.5–2s — untrimmed, check ramp-up";
    const suggestedTail = c.tailTrimSec ? `${c.tailTrimSec.toFixed(2)}s` : "0s";
    lines.push(`| ${i + 1} | ${numbered} | ${dur.toFixed(2)}s | ${suggestedHead} | ${suggestedTail} | ${c.name || ""} |`);
  });
  lines.push("");
  lines.push(`**Total running time (trimmed): ~${running.toFixed(1)}s**`);

  // Audio cues come from the shot/beat text fields directly (opts.audioCues),
  // not from A1-A3 timeline clips — the real pipeline doesn't produce separate
  // dialogue/SFX/music FILES yet (takes carry baked-in audio), so there is
  // nothing to attach as a clip. This still surfaces the same information
  // house-style.md's edit-handoff notes call for; it's just text, not media.
  const audioLines = (opts.audioCues || []).map(
    (cue) => `- **${cue.kind}** @ ${cue.atSec.toFixed(1)}s (shot ${cue.shotCode}) — ${cue.text}`,
  );
  if (audioLines.length) {
    lines.push("");
    lines.push("## Audio cues");
    lines.push(...audioLines);
  }

  // This numbered folder/copy plan only ever carries the PRIMARY take per
  // shot (v1, below) — CapCut has no multi-track XML import to stack
  // alternates onto the way FCPXML/OTIO do. Alternates still get listed here
  // as reference so they're not silently invisible on this path; Shawn pulls
  // the file himself if he wants to cut with one.
  const altLines = [];
  altTrackIds.forEach((trackId, i) => {
    for (const c of clipsByTrack[trackId] || []) {
      const v1Match = v1.find((p) => p.shotId === c.shotId);
      altLines.push(`- Alt ${i + 2} for shot ${v1Match ? v1Match.name : c.shotId} — \`${c.sourcePath}\``);
    }
  });
  if (altLines.length) {
    lines.push("");
    lines.push("## Alternate takes (not in the numbered folder — Resolve import stacks these; CapCut doesn't)");
    lines.push(...altLines);
  }

  lines.push("");
  lines.push("## Standing house-style notes");
  lines.push("- Hard cuts over dissolves.");
  lines.push("- Beat-sync to the dialogue/SFX cues above.");
  lines.push("- Simple grade: cool for night, warm for dawn.");

  return lines.join("\n") + "\n";
}

// Returns the list of {from, to} copy operations the caller should perform —
// this module doesn't touch the filesystem itself, store.js does, keeping the
// path-safety boundary in one place.
export function orderedCopyPlan(clipsByTrack) {
  const v1 = clipsByTrack.V1 || [];
  // One copy per file: a take cut into several pieces is copied once, under the
  // number of its first piece (the edit sheet's rows point at that copy).
  return v1
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => v1.findIndex((x) => x.sourcePath === c.sourcePath && x.versionId === c.versionId) === i)
    .map(({ c, i }) => ({
      from: c.sourcePath,
      toName: `${String(i + 1).padStart(2, "0")}_${path.basename(c.sourcePath)}`,
    }));
}
