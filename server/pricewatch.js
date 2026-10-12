// Price watch: the same model getting cheaper (or dearer).
//
// At startup and every 6 hours, ask each provider that publishes prices for
// the current price of every model the app uses: fal's pricing API (needs the
// fal key; account discounts included) and OpenRouter's public model list for
// the Claude models. Converted prices (rates.js convertFalPrice) replace the
// table's estimates via setLivePrice, so quotes and the budget cap use them.
// Changes are measured against the previous check (persisted in
// .rcs-prices.json beside the app) and, on the first check, against the price
// table. It never switches models: it reports.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VIDEO_MODELS, IMAGE_MODELS, convertFalPrice, setLivePrice } from "./rates.js";
import { LLM_MODELS, openRouterId } from "./llm.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = process.env.RCS_PRICES_FILE || path.join(REPO, ".rcs-prices.json");
const FAL_PRICING = process.env.RCS_FAL_PRICING_URL || "https://api.fal.ai/v1/models/pricing";
const OPENROUTER_MODELS = process.env.RCS_OPENROUTER_MODELS_URL || "https://openrouter.ai/api/v1/models";
const EVERY_MS = 6 * 60 * 60 * 1000;
const TOLERANCE = 0.02; // ignore moves under 2%

let STATE = { checkedAt: null, prices: {}, changes: [], errors: [], unconverted: [], unknown: [] };
let timer = null;

export function priceState() { return STATE; }

async function loadCache() {
  try { return JSON.parse(await fs.readFile(CACHE, "utf8")); } catch { return null; }
}

// Re-apply the last known live prices at startup, before the first check returns.
export async function restoreLive() {
  const c = await loadCache();
  if (!c) return;
  STATE = { ...STATE, ...c, changes: [] };
  for (const [id, p] of Object.entries(c.prices || {})) if (Number.isFinite(p.usd)) setLivePrice(id, p);
}

// The real fal address: image models keep theirs in endpoints.generate (the
// model id can be a short internal name, e.g. Seedream 5 Pro).
const falEndpoint = (m) => (m.endpoints && m.endpoints.generate) || m.endpoint || m.id;

async function fetchFal(fetchImpl) {
  const key = process.env.FAL_KEY;
  if (!key) return { skipped: "fal not connected" };
  const models = [
    ...VIDEO_MODELS.filter((m) => !m.driver || m.driver === "fal").map((m) => ({ m, kind: "video" })),
    ...IMAGE_MODELS.filter((m) => m.driver === "fal").map((m) => ({ m, kind: "image" })),
  ];
  const ids = [...new Set(models.map(({ m }) => falEndpoint(m)))];
  const res = await fetchImpl(`${FAL_PRICING}?endpoint_id=${ids.map(encodeURIComponent).join(",")}`, { headers: { authorization: `Key ${key}` } });
  if (!res.ok) throw new Error(`fal pricing ${res.status}`);
  const body = await res.json();
  const byEndpoint = new Map((body.prices || []).map((p) => [p.endpoint_id, p]));
  const out = [];
  for (const { m, kind } of models) {
    const p = byEndpoint.get(falEndpoint(m));
    if (!p) { out.push({ id: m.id, label: m.label, unknown: true }); continue; }
    out.push({ id: m.id, label: m.label, kind, unit: p.unit, unitPrice: p.unit_price, usd: convertFalPrice(m.id, p.unit, p.unit_price, kind), table: kind === "image" ? m.usdPerImage : m.usdPerVideoSecond, source: "fal" });
  }
  return { rows: out };
}

async function fetchOpenRouter(fetchImpl) {
  // Only when a Claude connection exists: no calls out for services not in use.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) return { skipped: "Claude not connected" };
  const res = await fetchImpl(OPENROUTER_MODELS);
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const list = (await res.json()).data || [];
  const byId = new Map(list.map((m) => [m.id, m]));
  const out = [];
  for (const m of LLM_MODELS) {
    const or = byId.get(openRouterId(m.id));
    if (!or || !or.pricing) { out.push({ id: m.id, label: m.label, unknown: true }); continue; }
    const outPerM = Number(or.pricing.completion) * 1e6;
    const inPerM = Number(or.pricing.prompt) * 1e6;
    // Compared on the output price (the larger share of a draft's cost).
    out.push({ id: m.id, label: m.label, kind: "llm", unit: "per M tokens", unitPrice: outPerM, inPerM, outPerM, usd: outPerM, table: m.outPerM, source: "openrouter" });
  }
  return { rows: out };
}

export async function checkPrices({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const prev = (await loadCache()) || { prices: {} };
  const errors = [], rows = [], skipped = [];
  for (const [name, fn] of [["fal", fetchFal], ["OpenRouter", fetchOpenRouter]]) {
    try {
      const r = await fn(fetchImpl);
      if (r.skipped) skipped.push(r.skipped); else rows.push(...r.rows);
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  const at = now().toISOString();
  const prices = { ...(prev.prices || {}) };
  const changes = [], unconverted = [], unknown = [];
  for (const r of rows) {
    if (r.unknown) { unknown.push({ id: r.id, label: r.label }); continue; }
    if (!Number.isFinite(r.usd)) { unconverted.push({ id: r.id, label: r.label, unit: r.unit, unitPrice: r.unitPrice }); continue; }
    const before = prev.prices && prev.prices[r.id] && Number.isFinite(prev.prices[r.id].usd) ? { usd: prev.prices[r.id].usd, basis: "last check" } : { usd: r.table, basis: "price table" };
    if (Number.isFinite(before.usd) && before.usd > 0 && Math.abs(r.usd - before.usd) / before.usd > TOLERANCE) {
      changes.push({ id: r.id, label: r.label, kind: r.kind, from: before.usd, to: r.usd, basis: before.basis, direction: r.usd < before.usd ? "down" : "up", at });
    }
    const rec = { usd: r.usd, unit: r.unit, unitPrice: r.unitPrice, kind: r.kind, source: r.source, checkedAt: at, ...(r.inPerM != null ? { inPerM: r.inPerM, outPerM: r.outPerM } : {}) };
    prices[r.id] = rec;
    if (r.kind !== "llm") setLivePrice(r.id, rec);
  }
  STATE = { checkedAt: at, prices, changes, errors, skipped, unconverted, unknown };
  await fs.writeFile(CACHE, JSON.stringify({ checkedAt: at, prices }, null, 2)).catch(() => {});
  return STATE;
}

export function startPriceWatch() {
  restoreLive().then(() => checkPrices().catch(() => {}));
  clearInterval(timer);
  timer = setInterval(() => checkPrices().catch(() => {}), EVERY_MS);
  timer.unref?.();
}
