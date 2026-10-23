// Cancelling a take: waiting in our queue = free and never sent; sent and the
// provider can drop it = cancelled, not charged; sent and the provider can't =
// stays running (and is refused). Stub driver, no network.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-cancel-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

let submitted = 0, cancelCalls = 0, canCancel = true;
jobs.drivers.fal = {
  name: "fal", billable: true,
  status: () => ({ ready: true, reason: "" }),
  generateVideo: async () => ({ jobId: `req_${++submitted}`, statusUrl: null, responseUrl: null }),
  getJob: async () => ({ state: "running" }),
  cancelJob: async () => { cancelCalls++; return canCancel ? { cancelled: true } : { cancelled: false, reason: "already started" }; },
};

const DIR = "Show/E1";
await store.scaffold(DIR);
await fs.writeFile(path.join(ROOT, DIR, "03_storyboard", "a.png"), "png");
const shot = (id) => ({ id, sceneNum: "1", shotCode: id, label: id, move: "static", action: "She turns.", beats: [{ id: "b" + id, keyframe: true, role: "start", frame: { path: `${DIR}/03_storyboard/a.png`, approved: true } }], versions: [], selectedVersions: [] });
await store.saveEpisode(DIR, { name: "E1", dir: DIR, fmt: "9:16", shots: ["a", "b", "c", "d", "e"].map(shot), ledger: { budgetCapUSD: 500, confirmAboveUSD: 500, spentUSD: 0, entries: [] } });
const fan = (ids) => jobs.submitFanOut(DIR, { shotIds: ids, modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "fal" });
const ver = async (shotId) => (await store.loadEpisode(DIR)).shots.find((s) => s.id === shotId).versions[0];
const wait = async (f) => { for (let i = 0; i < 60; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

// 5 takes, concurrency 3: the last two wait in our queue.
await fan(["a", "b", "c", "d", "e"]);
await wait(async () => (await ver("a")).jobId && (await ver("b")).jobId && (await ver("c")).jobId);
console.log("waiting in our own queue");
{
  const before = submitted;
  const r = await jobs.cancelVersion(DIR, (await ver("e")).id);
  check("a waiting take becomes cancelled", r.version.state === "cancelled" && (await ver("e")).state === "cancelled");
  check("nothing was sent to the provider for it", submitted === before && cancelCalls === 0);
}
console.log("\nsent, and the provider can drop it");
{
  const v = await ver("a");
  const r = await jobs.cancelVersion(DIR, v.id);
  check("it is marked cancelled", r.version.state === "cancelled");
  const ep = await store.loadEpisode(DIR);
  check("and NOT charged", ep.ledger.entries.length === 0 && ep.ledger.spentUSD === 0, JSON.stringify(ep.ledger));
  await new Promise((r) => setTimeout(r, 1500));
  check("the poll loop does not turn it back into an error", (await ver("a")).state === "cancelled");
}
console.log("\nsent, and the provider cannot drop it");
{
  canCancel = false;
  const v = await ver("b");
  let msg = "";
  try { await jobs.cancelVersion(DIR, v.id); } catch (e) { msg = e.message; }
  check("refused with a reason", /Could not cancel/.test(msg) && /already started/.test(msg), msg);
  check("the take keeps running", (await ver("b")).state === "running");
}
console.log("\nalready finished");
{
  let msg = "";
  try { await jobs.cancelVersion(DIR, (await ver("a")).id); } catch (e) { msg = e.message; }
  check("a cancelled take can't be cancelled again", /already cancelled/.test(msg), msg);
}

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
