// Loads .env into process.env SYNCHRONOUSLY, at module-evaluation time.
//
// This file must be the FIRST import in server/index.js, before jobs.js.
// jobs.js constructs driver singletons (`new FalDriver()`, etc.) at ITS OWN
// module-evaluation time, and those constructors read process.env.FAL_KEY
// once and store it on the instance. ES modules evaluate imports in the
// order they're listed before running the importing file's own code, so if
// this ran async (the original bug), jobs.js's import — and therefore the
// driver construction — could execute BEFORE the .env values existed. The
// key from .env was then silently ignored for the life of the process; only
// a value already in the shell environment would ever be picked up.
// A plain "await loadEnv()" statement further down the file does not fix
// this — it still runs after every import has already been evaluated.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  // RCS_ENV_FILE points a test or scratch server at its own (often empty) key
  // file — the same variable the Connections writer (providers.js) honours.
  const txt = fs.readFileSync(process.env.RCS_ENV_FILE || path.join(REPO, ".env"), "utf8");
  for (const line of txt.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env yet — fine, drivers report not-ready with a clear reason
}
