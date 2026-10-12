// Budget-guard tests. These exist because every other part of the cost control
// is only trustworthy if the refusals have actually been watched refusing.
// Run against a scratch episode in a temp root — no real project data, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-budget-"));
process.env.RCS_PROJECT_ROOT = ROOT;

const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");
const { newEpisode, newShot, newBeat } = await import("../shared/schema.js");

// The mock driver bills nothing in real use — that is the whole point of it,
// and the NON-BILLING DRIVER section at the bottom pins that down. Everything
// between here and there uses it as a stand-in for a REAL backend, so it is
// flipped billable to exercise the same accounting path fal takes.
jobs.drivers.mock.billable = true;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// A scratch episode with two shots, each carrying an APPROVED board frame so
// the keyframe requirement is satisfied and we're testing budget, not boarding.
const DIR = "Scratch/S1E01";
await store.scaffold(DIR);
const frameAbs = store.safeResolve(DIR, "03_storyboard", "f.jpg");
await fs.mkdir(path.dirname(frameAbs), { recursive: true });
await fs.writeFile(frameAbs, "not-a-real-jpeg");

const mkShot = (code) => newShot({
  sceneNum: "1", shotCode: code, action: "she turns and walks away", move: "push",
  beats: [newBeat({ role: "start", keyframe: true, desc: "start", frame: { path: `${DIR}/03_storyboard/f.jpg`, approved: true } })],
});
let ep = newEpisode({ name: "Scratch", dir: DIR, shots: [mkShot("a"), mkShot("b")] });
ep.ledger = { budgetCapUSD: 5, confirmAboveUSD: 1, spentUSD: 0, entries: [] };
await store.saveEpisode(DIR, ep);
const shotIds = ep.shots.map((s) => s.id);

console.log("\nQUOTING");
ep = await store.loadEpisode(DIR);
const q1 = jobs.quote(ep, { shotIds, modelIds: ["minimax/h3/image-to-video"], seconds: 5 });
check("2 shots x 1 model = 2 clips", q1.clips === 2, `got ${q1.clips}`);
check("h3 5s x2 prices at $1.30", Math.abs(q1.totalUSD - 1.3) < 0.001, `got ${q1.totalUSD}`);
check("h3 is flagged 'measured', not a guess", q1.lines[0].confidence === "measured", q1.lines[0].confidence);

const q2 = jobs.quote(ep, { shotIds, modelIds: ["alibaba/wan-3.0/image-to-video"], seconds: 5 });
check("uncalibrated model is named in the warning", q2.uncalibrated.includes("Wan 3.0"), JSON.stringify(q2.uncalibrated));

const qUnknown = jobs.quote(ep, { shotIds: [shotIds[0]], modelIds: ["some/model/nobody/knows"], seconds: 5 });
check("unknown model estimates at the WORST known rate, never cheap",
  qUnknown.lines[0].rate === Math.max(...(await import("../server/rates.js")).VIDEO_MODELS.map((m) => m.usdPerVideoSecond)),
  `rate ${qUnknown.lines[0].rate}`);

console.log("\nGUARD 1 — HARD CAP");
// 2 shots x 5 models x 10s is far past the $5 cap.
const allModels = (await import("../server/rates.js")).VIDEO_MODELS.map((m) => m.id);
try {
  await jobs.submitFanOut(DIR, { shotIds, modelIds: allModels, seconds: 10, driver: "mock", confirmedUSD: 999 });
  check("over-cap batch refused", false, "it was ACCEPTED");
} catch (e) {
  check("over-cap batch refused", e.status === 402, e.message);
  check("refusal names the numbers", /exceeds/.test(e.message) && /cap/.test(e.message), e.message);
}

console.log("\nGUARD 2 — CONFIRMATION");
try {
  await jobs.submitFanOut(DIR, { shotIds, modelIds: ["fal-ai/kling-video/v3/standard/image-to-video"], seconds: 5, driver: "mock" });
  check("over-threshold batch without confirmation refused", false, "it was ACCEPTED");
} catch (e) {
  check("over-threshold batch without confirmation refused", e.status === 402, e.message);
  check("refusal says confirmation is what's missing", /Confirmation required/.test(e.message), e.message);
}

try {
  // NaN fails every comparison, so a confirmation that doesn't coerce to a
  // number used to sail past the mismatch test below and approve the spend.
  await jobs.submitFanOut(DIR, { shotIds, modelIds: ["fal-ai/kling-video/v3/standard/image-to-video"], seconds: 5, driver: "mock", confirmedUSD: "I agree" });
  check("a non-numeric confirmation is refused", false, "it was ACCEPTED — NaN slipped past the echo-back check");
} catch (e) {
  check("a non-numeric confirmation is refused", e.status === 402, e.message);
}

try {
  // The attack this guard exists for: a UI that displays $0.10 while actually
  // submitting a $1.40 batch. The server recomputes and must reject.
  await jobs.submitFanOut(DIR, { shotIds, modelIds: ["fal-ai/kling-video/v3/standard/image-to-video"], seconds: 5, driver: "mock", confirmedUSD: 0.1 });
  check("confirmed-amount mismatch refused", false, "it was ACCEPTED — a UI could under-display cost");
} catch (e) {
  check("confirmed-amount mismatch refused", e.status === 402, e.message);
  check("refusal quotes both figures", /confirmed/.test(e.message) && /actually prices/.test(e.message), e.message);
}

console.log("\nGUARD 3 — IN-FLIGHT COUNTS AGAINST THE CAP");
ep = await store.loadEpisode(DIR);
ep.ledger.budgetCapUSD = 2.70;   // room for exactly two $1.30 h3 batches
ep.ledger.confirmAboveUSD = 100; // take confirmation out of the picture
await store.saveEpisode(DIR, ep);

const first = await jobs.submitFanOut(DIR, { shotIds, modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
check("first $1.30 batch accepted", first.versions.length === 2, `${first.versions.length} versions`);

ep = await store.loadEpisode(DIR);
const led = jobs.ledgerState(ep);
check("in-flight work is counted as committed", led.inFlightUSD === 1.3, `inFlight ${led.inFlightUSD}`);
check("remaining reflects in-flight, not just spent", Math.abs(led.remainingUSD - 1.4) < 0.001, `remaining ${led.remainingUSD}`);

try {
  // Without in-flight accounting this would "fit" — nothing has been *spent*
  // yet. This is the double-spend the accounting exists to stop.
  await jobs.submitFanOut(DIR, { shotIds, modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
  await jobs.submitFanOut(DIR, { shotIds, modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
  check("concurrent batches cannot collectively exceed the cap", false, "both were ACCEPTED");
} catch (e) {
  check("concurrent batches cannot collectively exceed the cap", e.status === 402, e.message);
}

console.log("\nCOMPLETION & LEDGER");
// Let the mock jobs finish and post to the ledger. The queue polls every 5s at
// concurrency 3, so a 4th clip only starts once a slot frees — wait past two
// poll cycles rather than racing the scheduler.
await new Promise((r) => setTimeout(r, 16000));
ep = await store.loadEpisode(DIR);
const done = (ep.shots || []).flatMap((s) => s.versions || []).filter((v) => v.state === "done");
check("mock jobs completed", done.length >= 2, `${done.length} done`);
check("a take file was written", !!done[0]?.path, JSON.stringify(done[0]?.path));
const led2 = jobs.ledgerState(ep);
check("ledger charged the completed work", led2.spentUSD >= 0.5, `spent ${led2.spentUSD}`);
check("in-flight cleared once done", led2.inFlightUSD === 0, `inFlight ${led2.inFlightUSD}`);
check("a ledger entry was recorded per clip", led2.entries.length >= 2, `${led2.entries.length} entries`);
check("entry records estimate AND actual separately",
  "estimateUSD" in led2.entries[0] && "actualUSD" in led2.entries[0], JSON.stringify(led2.entries[0]));

console.log("\nNON-BILLING DRIVER (a rehearsal must not eat the cap)");
jobs.drivers.mock.billable = false;
ep = await store.loadEpisode(DIR);
ep.ledger = { budgetCapUSD: 5, confirmAboveUSD: 100, spentUSD: 0, entries: [] };
await store.saveEpisode(DIR, ep);
const rehearsal = await jobs.submitFanOut(DIR, { shotIds, modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
const rehearsalIds = new Set(rehearsal.versions.map((v) => v.id));
check("a rehearsal reserves nothing against the cap",
  rehearsal.versions.every((v) => v.estimateUSD === 0), JSON.stringify(rehearsal.versions.map((v) => v.estimateUSD)));
check("a rehearsal still records what it WOULD have cost",
  rehearsal.versions.every((v) => v.quotedUSD === 0.65), JSON.stringify(rehearsal.versions.map((v) => v.quotedUSD)));
check("committed spend is unmoved by a rehearsal",
  jobs.ledgerState(await store.loadEpisode(DIR)).committedUSD === 0,
  `committed ${jobs.ledgerState(await store.loadEpisode(DIR)).committedUSD}`);
await new Promise((r) => setTimeout(r, 12000));
const ledR = jobs.ledgerState(await store.loadEpisode(DIR));
check("a COMPLETED rehearsal posts no ledger entry",
  !ledR.entries.some((e) => rehearsalIds.has(e.versionId)), JSON.stringify(ledR.entries.map((e) => e.versionId)));

console.log("\nLEDGER ATOMICITY (no window where a clip counts as neither in-flight nor spent)");
{
  // Real bug: marking a version done and charging its ledger entry used to be
  // two SEPARATE lock acquisitions (two separate writes to studio.json). In
  // between them, a version was "done" on disk with no matching ledger entry
  // yet — ledgerState() no longer counted it as in-flight (state isn't
  // queued/running) and hadn't counted it as spent either. Any concurrent
  // withEpisode call in that gap read inflated headroom.
  //
  // Proven here by polling the RAW FILE on disk (not the app's in-memory
  // model) at high frequency while a mock job completes, and asserting we
  // never observe a snapshot where a version is terminal but its charge is
  // missing. Atomic writes mean any read sees a fully-written snapshot; the
  // question is only whether that snapshot's two related facts ever
  // disagree with each other.
  // The NON-BILLING DRIVER section above deliberately leaves the mock driver
  // flagged non-billable and never restores it — this section needs it billing
  // again, the same stand-in-for-a-real-backend role it plays everywhere else
  // in this file, or every job here prices at $0 and "charged" is trivially
  // true regardless of whether the fix actually works.
  jobs.drivers.mock.billable = true;

  // A fresh shot, not one reused from an earlier section: those already carry
  // completed versions with their OWN ledger entries on disk. Resetting the
  // ledger to empty while leaving that old version history in place would have
  // the poller see a pre-existing "done" version with no matching entry on its
  // very first read — a false positive from stale fixture data, not a race.
  ep = await store.loadEpisode(DIR);
  const atomicityShot = newShot({
    sceneNum: "9", shotCode: "z", action: "atomicity probe", move: "push",
    beats: [newBeat({ role: "start", keyframe: true, desc: "start", frame: { path: `${DIR}/03_storyboard/f.jpg`, approved: true } })],
  });
  ep.shots.push(atomicityShot);
  ep.ledger = { budgetCapUSD: 50, confirmAboveUSD: 100, spentUSD: 0, entries: [] };
  await store.saveEpisode(DIR, ep);

  const studioJsonPath = `${store.ROOT}/${DIR}/studio.json`;
  let inconsistentSnapshot = null;
  let sawTerminal = false;
  const poller = (async () => {
    while (!inconsistentSnapshot && !sawTerminal) {
      try {
        const raw = JSON.parse(await fs.readFile(studioJsonPath, "utf8"));
        const s = (raw.shots || []).find((x) => x.id === atomicityShot.id);
        for (const v of s?.versions || []) {
          if (v.state !== "done" && v.state !== "error") continue;
          sawTerminal = true;
          const charged = (raw.ledger?.entries || []).some((e) => e.versionId === v.id);
          if (!charged) {
            inconsistentSnapshot = { versionId: v.id, state: v.state, ledgerEntries: raw.ledger?.entries?.length ?? 0 };
          }
        }
      } catch { /* mid-write; readFile can race a rename, just retry */ }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  const atomicity = await jobs.submitFanOut(DIR, { shotIds: [atomicityShot.id], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
  await new Promise((r) => setTimeout(r, 2500)); // mock latency is 1500ms
  await poller;

  check("polling saw the job reach a terminal state", sawTerminal);
  check("no disk snapshot ever showed a terminal version with no matching ledger entry",
    inconsistentSnapshot === null, JSON.stringify(inconsistentSnapshot));
}

console.log("\nKEYFRAME REQUIREMENT (board-before-video)");
ep = await store.loadEpisode(DIR);
ep.ledger = { budgetCapUSD: 50, confirmAboveUSD: 100, spentUSD: 0, entries: [] };
const unboarded = newShot({ sceneNum: "2", shotCode: "a", action: "x" });
ep.shots.push(unboarded);
await store.saveEpisode(DIR, ep);
const res = await jobs.submitFanOut(DIR, { shotIds: [unboarded.id], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
check("a duration the model does not sell is refused, not silently under-priced",
  (() => { try { jobs.quote(ep, { shotIds, modelIds: ["minimax/h3/image-to-video"], seconds: -5 }); return false; } catch { return true; } })(),
  "a negative duration priced a batch at a negative total");
// H3's menu is now every whole second 5-15 (Sept 2026 — it used to be just
// [5, 10], which is what this test originally exercised the round-up on).
// The model still only ever sells WHOLE seconds, so a fractional request is
// the realistic remaining "off-list" case — 6.5s isn't sellable, snaps up to 7.
check("an off-list duration is billed as the take that actually gets made",
  jobs.quote(ep, { shotIds: [shotIds[0]], modelIds: ["minimax/h3/image-to-video"], seconds: 6.5 }).lines[0].seconds === 7,
  JSON.stringify(jobs.quote(ep, { shotIds: [shotIds[0]], modelIds: ["minimax/h3/image-to-video"], seconds: 6.5 }).lines[0]));

check("shot with no approved board frame errors instead of generating",
  res.versions[0].state === "error" && /board it first/.test(res.versions[0].error || ""), JSON.stringify(res.versions[0].error));

const noMove = newShot({
  sceneNum: "2", shotCode: "b", action: "x",
  beats: [newBeat({ role: "start", keyframe: true, desc: "start", frame: { path: `${DIR}/03_storyboard/f.jpg`, approved: true } })],
});
ep.shots.push(noMove);
await store.saveEpisode(DIR, ep);
const res2 = await jobs.submitFanOut(DIR, { shotIds: [noMove.id], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
check("boarded shot with no camera move chosen errors instead of generating",
  res2.versions[0].state === "error" && /camera move/.test(res2.versions[0].error || ""), JSON.stringify(res2.versions[0].error));

console.log("\nSTART/END KEYFRAMES (a model that takes two images gets two)");
{
  // Every model in rates.js caps at 2 image slots (checked against each
  // model's live fal schema 2026-09-25) — a 3rd approved keyframe is real
  // data (continuity planning, a cutaway reference) but isn't sent to the
  // video model. The LAST approved beat, not the 2nd, fills the end slot.
  const frame2Abs = store.safeResolve(DIR, "03_storyboard", "f2.jpg");
  await fs.writeFile(frame2Abs, "not-a-real-jpeg-2");
  const frame3Abs = store.safeResolve(DIR, "03_storyboard", "f3.jpg");
  await fs.writeFile(frame3Abs, "not-a-real-jpeg-3");

  const multiKf = newShot({
    sceneNum: "2", shotCode: "c", action: "x", move: "push",
    beats: [
      newBeat({ role: "start", keyframe: true, desc: "start", frame: { path: `${DIR}/03_storyboard/f.jpg`, approved: true } }),
      newBeat({ role: "mid", keyframe: true, desc: "mid", frame: { path: `${DIR}/03_storyboard/f2.jpg`, approved: true } }),
      newBeat({ role: "end", keyframe: true, desc: "end", frame: { path: `${DIR}/03_storyboard/f3.jpg`, approved: true } }),
    ],
  });
  ep = await store.loadEpisode(DIR);
  ep.shots.push(multiKf);
  await store.saveEpisode(DIR, ep);
  const res3 = await jobs.submitFanOut(DIR, { shotIds: [multiKf.id], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
  const v3 = res3.versions[0];
  check("start slot is the FIRST approved keyframe",
    v3.keyframePath === `${DIR}/03_storyboard/f.jpg`, v3.keyframePath);
  check("end slot is the LAST approved keyframe, not the 2nd",
    v3.endKeyframePath === `${DIR}/03_storyboard/f3.jpg`, v3.endKeyframePath);

  // Shawn's ask: several approved storyboards exist to compare combos, and he
  // picks which two actually feed the model — not always first/last.
  // Direct loadEpisode+saveEpisode (not store.withEpisode) races the previous
  // check's still-in-flight mock job — its own eventual withEpisode-wrapped
  // completion write can load a pre-edit snapshot and clobber this one. Route
  // through withEpisode like every other episode-mutating caller must.
  await store.withEpisode(DIR, (epw) => {
    const shotRef = epw.shots.find((s) => s.id === multiKf.id);
    shotRef.endBeatId = shotRef.beats[1].id; // the "mid" beat (f2.jpg), not the last
  });
  const res4 = await jobs.submitFanOut(DIR, { shotIds: [multiKf.id], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "mock" });
  const v4 = res4.versions[0];
  check("a manually chosen end beat overrides the auto-picked last one",
    v4.endKeyframePath === `${DIR}/03_storyboard/f2.jpg`, v4.endKeyframePath);
}

// ---------- ADJUSTMENTS ----------
// An invoice correction is its own entry, counts against the cap, and leaves
// every earlier entry exactly as it was.
{
  console.log("\nledger adjustments");
  const ADIR = "Scratch/S1E02";
  await store.scaffold(ADIR);
  await store.saveEpisode(ADIR, newEpisode({ name: "Adj", dir: ADIR, shots: [] }));
  await store.withEpisode(ADIR, (e) => {
    e.ledger.budgetCapUSD = 10;
    e.ledger.spentUSD = 4;
    e.ledger.entries = [{ kind: "video", chargedUSD: 4, outcome: "done" }];
  });
  const before = JSON.stringify((await store.loadEpisode(ADIR)).ledger.entries[0]);
  const st = await jobs.recordAdjustment(ADIR, { amountUSD: 7.5, note: "invoice says more", source: "test.csv" });
  const e2 = await store.loadEpisode(ADIR);
  check("adjustment raises spentUSD", e2.ledger.spentUSD === 11.5, String(e2.ledger.spentUSD));
  check("adjustment is a visible entry of its own",
    e2.ledger.entries.length === 2 && e2.ledger.entries[1].kind === "adjustment" && e2.ledger.entries[1].chargedUSD === 7.5);
  check("earlier entries are untouched", JSON.stringify(e2.ledger.entries[0]) === before);
  check("over-cap after adjustment leaves nothing remaining", st.remainingUSD === 0, String(st.remainingUSD));
  let threw = false;
  try { await jobs.recordAdjustment(ADIR, { amountUSD: 1 }); } catch { threw = true; }
  check("adjustment without a note is refused", threw);
  threw = false;
  try { await jobs.recordAdjustment(ADIR, { amountUSD: "abc", note: "x" }); } catch { threw = true; }
  check("non-numeric adjustment is refused", threw);
}

console.log(`\n${fail === 0 ? "✓" : "✗"} budget guards: ${pass} passed, ${fail} failed`);
// Best-effort: a take file landing mid-walk makes rm throw ENOTEMPTY on macOS,
// and a scratch dir in /tmp is not worth failing a green suite over.
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
