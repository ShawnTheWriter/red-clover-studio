// Cheapest route: the same model sold by more than one connected service goes
// through the cheaper one, live prices win over the table, a service with no
// key is never chosen, and quote and submit agree. No network, no spend.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-route-"));
process.env.RCS_SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.RCS_PRICES_FILE = path.join(TMP, "prices.json");
const R = await import("../server/rates.js");
const jobs = await import("../server/jobs.js");
const { writeSettings } = await import("../server/settings.js");

const FAL = "bytedance/seedance-2.5/image-to-video";
const ATL = "atlas:bytedance/seedance-2.5/image-to-video";
// Sume (added 2026-10-23) has its own tests in sume.mjs; here it is "not connected".
const all = (v) => v !== "sume";
const SUME = "sume:seedance-2.5/image-to-video@720p";

console.log("siblings");
check("Seedance 2.5 frames 720p: fal, Atlas and Sume", R.routeSiblings(FAL).map((m) => m.id).sort().join() === [ATL, FAL, SUME].sort().join());
check("1080p only pairs with 1080p", R.routeSiblings(`${FAL}@1080p`).map((m) => m.id).sort().join() === [`${ATL}@1080p`, `${FAL}@1080p`, "sume:seedance-2.5/image-to-video@1080p"].sort().join());
check("references never pair with frames", !R.routeSiblings("bytedance/seedance-2.5/reference-to-video").some((m) => m.mode !== "refs"));
check("a model only fal sells has no other route", R.routeSiblings("fal-ai/kling-video/v3/standard/image-to-video").length === 1);

console.log("\nchoice");
check("both connected: the cheaper table price wins (Atlas)", R.cheapestRoute(FAL, all).modelId === ATL);
check("Atlas not connected: stays on fal", R.cheapestRoute(FAL, (v) => v === "fal").modelId === FAL);
check("pick isn't connected, the other is: goes to the connected one", R.cheapestRoute(ATL, (v) => v === "fal").modelId === FAL);
check("nothing connected: keeps the pick", R.cheapestRoute(FAL, () => false).modelId === FAL);
R.setLivePrice(FAL, { usd: 0.2, unit: "1000 tokens", unitPrice: 0.0093 });
check("a live fal promo below Atlas moves it back to fal", R.cheapestRoute(ATL, all).modelId === FAL && R.cheapestRoute(FAL, all).routed === false);
R.setLivePrice(FAL, { usd: 0.33 * 0.998 });
check("a near-tie (<0.5%) keeps the pick", R.cheapestRoute(ATL, all).modelId === ATL);
R.setLivePrice(FAL, null);
check("an unknown model id is returned unchanged", R.cheapestRoute("nobody/knows", all).modelId === "nobody/knows");

console.log("\nquote and submit");
const shot = { id: "s1", sceneNum: 1, shotCode: "a", move: "static", beats: [{ id: "b1", frame: { path: "f.png", approved: true }, approved: true }], versions: [] };
const ep = { shots: [shot], assets: [], ledger: { budgetCapUSD: 50, confirmAboveUSD: 100, spentUSD: 0, entries: [] } };
const saved = { fal: jobs.drivers.fal.status, atlas: jobs.drivers.atlas.status };
jobs.drivers.fal.status = () => ({ ready: true, reason: "" });
jobs.drivers.atlas.status = () => ({ ready: true, reason: "" });
const q = jobs.quote(ep, { shotIds: ["s1"], modelIds: [FAL], seconds: 5 });
check("the quote line runs on Atlas and says it was moved", q.lines[0].modelId === ATL && q.lines[0].routedFrom === FAL, JSON.stringify(q.lines[0]));
check("the saving is the fal price minus Atlas's", Math.abs(q.routedSavingUSD - (0.466 - 0.33) * 5) < 0.011, String(q.routedSavingUSD));
check("total is priced on the route used", Math.abs(q.totalUSD - 0.33 * 5) < 0.011, String(q.totalUSD));
const off = jobs.quote(ep, { shotIds: ["s1"], modelIds: [FAL], seconds: 5, route: false });
check("route off: priced and sent as picked", off.lines[0].modelId === FAL && !off.lines[0].routedFrom && off.routedSavingUSD === 0);
writeSettings({ cheapestRoute: false });
check("the setting turns it off", !jobs.cheapestRouteOn() && jobs.quote(ep, { shotIds: ["s1"], modelIds: [FAL], seconds: 5 }).lines[0].modelId === FAL);
writeSettings({ cheapestRoute: null });
check("cleared setting = on (the default)", jobs.cheapestRouteOn());
jobs.drivers.atlas.status = () => ({ ready: false, reason: "no key" });
check("Atlas disconnected: the quote stays on fal", jobs.quote(ep, { shotIds: ["s1"], modelIds: [FAL], seconds: 5 }).lines[0].modelId === FAL);
jobs.drivers.atlas.status = () => ({ ready: true, reason: "" });

// Submit re-quotes with the same routing, so the confirmed figure matches and
// the take records the service it actually went to.
const qq = jobs.quote(ep, { shotIds: ["s1"], modelIds: [FAL], seconds: 5 });
const again = jobs.quote(ep, { shotIds: ["s1"], modelIds: [FAL], seconds: 5 });
check("quoting twice gives the same route and total (submit's re-quote matches)", qq.totalUSD === again.totalUSD && qq.lines[0].modelId === again.lines[0].modelId);
check("the routed driver is Atlas's", jobs.driverForModel(qq.lines[0].modelId) === "atlas");

Object.assign(jobs.drivers.fal, { status: saved.fal });
Object.assign(jobs.drivers.atlas, { status: saved.atlas });
await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✓" : "✗"} cheapest route: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
