// A model's content refusal (fal 422 at the RESULT) is not billed, so the
// ledger must not charge it; any other failure after submission still is
// (the provider may have billed). Stub fal driver, no network.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-refusal-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");
const jobs = await import("../server/jobs.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

let nextError = "";
jobs.drivers.fal = {
  name: "fal", billable: true,
  status: () => ({ ready: true, reason: "" }),
  generateVideo: async () => ({ jobId: "req_1", statusUrl: null, responseUrl: null }),
  getJob: async () => ({ state: "error", error: nextError }),
};

const DIR = "Show/E1";
await store.scaffold(DIR);
const img = path.join(ROOT, DIR, "03_storyboard", "a.png");
await fs.writeFile(img, "png");
const mk = async () => store.saveEpisode(DIR, {
  name: "E1", dir: DIR, fmt: "9:16",
  shots: [{ id: "s1", sceneNum: "1", shotCode: "a", label: "turn", move: "static", action: "She turns.", beats: [{ id: "b1", keyframe: true, role: "start", frame: { path: `${DIR}/03_storyboard/a.png`, approved: true } }], versions: [], selectedVersions: [] }],
  ledger: { budgetCapUSD: 50, confirmAboveUSD: 20, spentUSD: 0, entries: [] },
});
const run = async (err) => {
  await mk(); nextError = err;
  const o = await jobs.submitFanOut(DIR, { shotIds: ["s1"], modelIds: ["minimax/h3/image-to-video"], seconds: 5, driver: "fal" });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const ep = await store.loadEpisode(DIR);
    const v = ep.shots[0].versions[0];
    if (v && (v.state === "error" || v.state === "done")) return { v, ep, est: o.versions[0].estimateUSD };
  }
  return null;
};

console.log("a model refusal (422 at the result)");
{
  const { v, ep, est } = await run('result 422: {"detail":[{"loc":["body"],"msg":"Invalid parameters in input, please check inputs and try again.","type":"invalid_request"}]}');
  check("the take is marked failed, with a message that says nothing was billed", v.state === "error" && /nothing was billed/.test(v.error) && /realistic face/.test(v.error), v.error);
  check("the original fal text is kept in the message", /Invalid parameters in input/.test(v.error));
  check("the ledger was NOT charged (the estimate was $" + est.toFixed(2) + ")", ep.ledger.spentUSD === 0 && ep.ledger.entries.length === 0, JSON.stringify(ep.ledger));
}

console.log("\nany other failure after submission");
{
  const { v, ep, est } = await run("status 500: upstream error");
  check("the take fails with fal's own text", v.state === "error" && /status 500/.test(v.error) && !/nothing was billed/.test(v.error), v.error);
  check("and IS still charged the estimate (the provider may have billed)", ep.ledger.entries.length === 1 && Math.abs(ep.ledger.spentUSD - est) < 0.005 && ep.ledger.entries[0].outcome === "failed", JSON.stringify(ep.ledger));
}

await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fail === 0 ? "✓" : "✗"} refusal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
