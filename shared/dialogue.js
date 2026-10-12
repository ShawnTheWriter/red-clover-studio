// The Dialogue lane of Post-Production > Sound. Every spoken line lives on a
// beat (beat.dialogue = { charId, line, delivery }); this gathers them into
// one list with what each line has so far:
//   recordings  — shot.audioClips linked to the line by beatId. Shawn records
//                 his own performance ("performance"), then ElevenLabs turns it
//                 into the character's voice ("voiced").
//   lip sync    — takes made from a take with one of those recordings.
// Shared by the server (tests) and the browser (the list itself).

export function hasLine(beat) {
  return !!(beat && beat.dialogue && beat.dialogue.line && beat.dialogue.line.trim());
}

export function dialogueLines(ep) {
  const assets = ep.assets || [];
  const rows = [];
  for (const shot of ep.shots || []) {
    if (shot.sceneNum === "X") continue; // Cut from edit: not in the episode
    const lineBeats = (shot.beats || []).filter(hasLine);
    if (!lineBeats.length) continue;
    const clips = shot.audioClips || [];
    const lipsync = (shot.versions || []).filter((v) => v.op === "lipsync");
    lineBeats.forEach((beat, i) => {
      const d = beat.dialogue;
      const speaker = assets.find((a) => a.id === d.charId);
      // A recording made before lines could be linked has no beatId: it shows
      // under the shot's first line until Shawn links it.
      const recs = clips.filter((c) => c.beatId === beat.id || (!c.beatId && i === 0));
      const recIds = new Set(recs.map((c) => c.id));
      const recPaths = new Set(recs.map((c) => c.path));
      rows.push({
        shotId: shot.id,
        code: `${shot.sceneNum}${shot.shotCode}`,
        sceneNum: shot.sceneNum,
        label: shot.label || "",
        beatId: beat.id,
        lineIndex: i,
        linesInShot: lineBeats.length,
        charId: d.charId || null,
        speaker: speaker ? speaker.name : (d.charId || "Unknown speaker"),
        line: d.line.trim(),
        delivery: d.delivery || "",
        useClipId: d.useClipId || null,
        recordings: recs.map((c) => ({ id: c.id, label: c.label, path: c.path, seconds: c.seconds, kind: c.kind || "performance", origin: c.origin || (c.kind === "voiced" ? "performance" : "recording"), offsetSec: c.offsetSec ?? null, linked: !!c.beatId, inEdit: c.id === d.useClipId })),
        lipsyncTakes: lipsync.filter((v) => recIds.has(v.audioClipId) || recPaths.has(v.audioPath)).map((v) => ({ id: v.id, state: v.state, selected: (shot.selectedVersions || []).includes(v.id) })),
      });
    });
  }
  return rows;
}

// Characters a line can be given to: one entry per character name (an asset
// card can hold several angles), first angle's id.
export function speakers(ep) {
  const seen = new Map();
  for (const a of ep.assets || []) {
    if (a.type !== "character") continue;
    const k = a.name.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, { id: a.id, name: a.name.trim() });
  }
  return [...seen.values()];
}

export function lineStatus(row) {
  if (row.lipsyncTakes.some((t) => t.state === "done")) return "lip-synced";
  if (row.recordings.some((r) => r.kind === "voiced")) return "voiced";
  if (row.recordings.length) return "recorded";
  return "no recording";
}
