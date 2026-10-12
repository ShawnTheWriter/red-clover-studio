// Price watch: fal unit prices converted to $ per video second, compared with
// the table and the last check; live prices feed the estimates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-prices-"));
process.env.RCS_PRICES_FILE = path.join(TMP, "prices.json");
process.env.FAL_KEY = "test-fal-key";
delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENROUTER_API_KEY;
const pw = await import("../server/pricewatch.js");
const rates = await import("../server/rates.js");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`); };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// fal's answer on 2026-10-12 (read through the fal MCP), as the API returns it.
let falPrices = [
  { endpoint_id: "minimax/h3-max/image-to-video", unit_price: 0.03, unit: "seconds", currency: "USD" },
  { endpoint_id: "minimax/h3-max/reference-to-video", unit_price: 0.05, unit: "seconds", currency: "USD" },
  { endpoint_id: "minimax/h3/image-to-video", unit_price: 0.05, unit: "seconds", currency: "USD" },
  { endpoint_id: "bytedance/seedance-2.5/image-to-video", unit_price: 0.0214, unit: "1000 tokens", currency: "USD" },
  { endpoint_id: "alibaba/wan-3.0/image-to-video", unit_price: 0.05, unit: "seconds", currency: "USD" },
  { endpoint_id: "bytedance/seedream/v5/pro/text-to-image", unit_price: 0.0675, unit: "units", currency: "USD" },
];
let lastUrl = "", lastAuth = "";
const fakeFetch = async (url, opts = {}) => {
  lastUrl = url; lastAuth = (opts.headers || {}).authorization || "";
  return { ok: true, json: async () => ({ prices: falPrices, next_cursor: null, has_more: false }) };
};

let st = await pw.checkPrices({ fetchImpl: fakeFetch });
check("asks fal with the key", lastAuth === "Key test-fal-key" && lastUrl.includes("endpoint_id="), lastUrl.slice(0, 80));
check("H3 Max: $0.03 x 1.6 = $0.048/s", near(st.prices["minimax/h3-max/image-to-video"].usd, 0.048));
check("H3 Max references: $0.05 x 1.6 = $0.08/s", near(st.prices["minimax/h3-max/reference-to-video"].usd, 0.08));
check("references now match the table ($0.08), so no change reported", !st.changes.some((c) => c.id === "minimax/h3-max/reference-to-video"));
check("Seedance 2.5: tokens converted (~$0.462/s)", Math.abs(st.prices["bytedance/seedance-2.5/image-to-video"].usd - 0.46224) < 1e-4);
check("Seedream asked by its real address, priced per image", near(st.prices["bytedance/seedream/v5/pro"].usd, 0.0675) && lastUrl.includes(encodeURIComponent("bytedance/seedream/v5/pro/text-to-image")));
check("Wan 3.0 left unconverted, not guessed", st.unconverted.some((u) => u.id === "alibaba/wan-3.0/image-to-video"));
check("an endpoint fal didn't return is reported", st.unknown.some((u) => u.id === "fal-ai/kling-video/v3/standard/image-to-video"));
check("quotes use the live price", near(rates.estimateVideoUSD("minimax/h3-max/reference-to-video", 5).usd, 0.4) && rates.estimateVideoUSD("minimax/h3-max/reference-to-video", 5).confidence === "live");
check("a model without a live price keeps the table", rates.estimateVideoUSD("alibaba/wan-3.0/image-to-video", 5).confidence !== "live");

// Next check: H3 Max drops to $0.02/unit -> $0.032/s, against the LAST CHECK.
falPrices = falPrices.map((p) => (p.endpoint_id === "minimax/h3-max/image-to-video" ? { ...p, unit_price: 0.02 } : p));
st = await pw.checkPrices({ fetchImpl: fakeFetch });
const drop = st.changes.find((c) => c.id === "minimax/h3-max/image-to-video");
check("a same-model price drop is reported against the last check", drop && drop.direction === "down" && drop.basis === "last check" && near(drop.from, 0.048) && near(drop.to, 0.032), JSON.stringify(drop));
check("unchanged prices aren't reported twice", !st.changes.some((c) => c.id === "minimax/h3-max/reference-to-video"));

console.log(`\n${fail === 0 ? "✓" : "✗"} pricewatch: ${pass} passed, ${fail} failed`);
await fs.rm(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
