// The Dialogue lane's list: every spoken line, its recordings and lip-sync
// takes. Fixture mirrors S1E1_v2: two lines on one shot (5d), a recording
// made before lines could be linked, a binned shot that must not appear.
import { dialogueLines, speakers, lineStatus, hasLine } from "../shared/dialogue.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const ep = {
  assets: [
    { id: "flame", type: "character", name: "Flame" },
    { id: "ovl", type: "character", name: "Overlock Stitch" },
    { id: "ovl2", type: "character", name: "Overlock Stitch", angle: "face" },
    { id: "loc", type: "location", name: "Workshop" },
  ],
  shots: [
    { id: "s1", sceneNum: "5", shotCode: "d", label: "Flame's questions",
      beats: [
        { id: "b1", dialogue: { charId: "flame", line: "It true?", delivery: "blunt" } },
        { id: "b2", dialogue: { charId: "flame", line: "About your dad?" } },
        { id: "b3", dialogue: { charId: "flame", line: "   " } },
      ],
      audioClips: [
        { id: "a0", path: "p/old.wav", label: "old", seconds: 2 },                       // unlinked: shows under line 1
        { id: "a2", path: "p/dad.wav", label: "dad", seconds: 1.2, beatId: "b2", kind: "voiced" },
      ],
      versions: [
        { id: "v1", op: "lipsync", state: "done", audioClipId: "a2", audioPath: "p/dad.wav" },
        { id: "v0", state: "done" },
      ],
      selectedVersions: ["v1"] },
    { id: "s2", sceneNum: "5", shotCode: "e", beats: [{ id: "b4" }] },
    { id: "s3", sceneNum: "X", shotCode: "a", beats: [{ id: "b5", dialogue: { charId: "ovl", line: "cut line" } }] },
  ],
};

const rows = dialogueLines(ep);
check("one row per spoken line; blank lines and binned shots are skipped", rows.length === 2, JSON.stringify(rows.map((r) => r.line)));
check("rows carry code, speaker and delivery", rows[0].code === "5d" && rows[0].speaker === "Flame" && rows[0].delivery === "blunt");
check("two lines on one shot are told apart", rows[0].linesInShot === 2 && rows[1].lineIndex === 1);
check("an unlinked recording shows under the shot's first line", rows[0].recordings.map((r) => r.id).join() === "a0" && rows[0].recordings[0].linked === false);
check("a linked recording shows under its own line", rows[1].recordings.map((r) => r.id).join() === "a2");
check("a lip-sync take belongs to the line whose recording it used", rows[1].lipsyncTakes.length === 1 && rows[1].lipsyncTakes[0].selected && rows[0].lipsyncTakes.length === 0);
check("status: recorded / lip-synced", lineStatus(rows[0]) === "recorded" && lineStatus(rows[1]) === "lip-synced");
check("status: no recording", lineStatus({ recordings: [], lipsyncTakes: [] }) === "no recording");
check("status: voiced", lineStatus({ recordings: [{ kind: "voiced" }], lipsyncTakes: [] }) === "voiced");
check("speakers: one per character name, characters only", speakers(ep).map((s) => s.name).join("|") === "Flame|Overlock Stitch");
check("hasLine ignores whitespace", !hasLine({ dialogue: { line: "  " } }) && hasLine({ dialogue: { line: "x" } }));

console.log(`\n${fail === 0 ? "✓" : "✗"} dialogue: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
