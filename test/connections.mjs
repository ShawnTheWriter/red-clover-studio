// OpenRouter as the route to Claude, and the .env writer behind Connections.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-conn-"));
process.env.RCS_PROJECT_ROOT = ROOT;
process.env.RCS_ENV_FILE = path.join(ROOT, ".env");
delete process.env.ANTHROPIC_API_KEY;
process.env.OPENROUTER_API_KEY = "or-test-key-123";
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`); };

// Fake OpenRouter: records the request, answers with a structured result.
let seen = null;
const srv = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ text: "Keep this exact character: grey coat, scar on the left brow.", notes: [] }) } }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.0061 } }));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.RCS_OPENROUTER_BASE_URL = `http://127.0.0.1:${srv.address().port}`;

const store = await import("../server/store.js");
const llm = await import("../server/llm.js");
const providers = await import("../server/providers.js");
const { newEpisode, newAsset } = await import("../shared/schema.js");

check("Claude is ready through OpenRouter", llm.status().ready && llm.provider() === "openrouter");
await fs.mkdir(path.join(ROOT, "E1"), { recursive: true });
const ep = newEpisode({ name: "E1", dir: "E1" });
ep.assets = [Object.assign(newAsset({ type: "character", name: "Jun" }), { id: "a1" })];
await store.saveEpisode("E1", ep);
const r = await llm.draftAsset("E1", { assetId: "a1", kind: "hold" });
check("the draft comes back", r.text.startsWith("Keep this exact character"), r.text);
check("sent to OpenRouter's chat API with the key", seen.url === "/chat/completions" && seen.auth === "Bearer or-test-key-123");
check("model mapped to OpenRouter's name", seen.body.model === "anthropic/claude-opus-5.5", seen.body.model);
check("structured output requested", seen.body.response_format && seen.body.response_format.type === "json_schema");
const led = (await store.loadEpisode("E1")).ledger.entries.at(-1);
const keptEp = await store.loadEpisode("E1");
check("the hold draft is kept on the episode (shows in any browser)", keptEp.claude.assets && keptEp.claude.assets["hold:a1"] && keptEp.claude.assets["hold:a1"].text === r.text);
await llm.keepResult("E1", "assets", "hold:a1", null);
check("discard removes the kept draft", !(await store.loadEpisode("E1")).claude.assets["hold:a1"]);
check("ledger records OpenRouter's own cost", led.kind === "llm" && led.driver === "openrouter" && Math.abs(led.chargedUSD - 0.0061) < 1e-9, JSON.stringify(led));

await fs.writeFile(process.env.RCS_ENV_FILE, "# keep me\nPORT=8199\nFAL_KEY=old\n");
await providers.writeEnvKey("FAL_KEY", "new-key-1234");
await providers.writeEnvKey("GEMINI_API_KEY", "g-key-5678");
let env = await fs.readFile(process.env.RCS_ENV_FILE, "utf8");
check(".env: key replaced, others kept", env.includes("# keep me") && env.includes("PORT=8199") && env.includes("FAL_KEY=new-key-1234") && !env.includes("FAL_KEY=old"), env);
await providers.writeEnvKey("FAL_KEY", null);
env = await fs.readFile(process.env.RCS_ENV_FILE, "utf8");
check(".env: key removed cleanly", !env.includes("FAL_KEY") && env.includes("GEMINI_API_KEY=g-key-5678"), env);
check("keys are only ever shown masked", providers.mask("sk-abcdef123456") === "…3456");

srv.close();
console.log(`\n${fail === 0 ? "✓" : "✗"} connections: ${pass} passed, ${fail} failed`);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
process.exit(fail ? 1 : 0);
