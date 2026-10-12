// The projects folder as a per-user setting (GitHub prep): no folder until one
// is chosen, choosing/creating one, bad input refused. Temp files only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-settings-"));
process.env.RCS_SETTINGS_FILE = path.join(TMP, "cfg", "settings.json");
delete process.env.RCS_PROJECT_ROOT;
const store = await import("../server/store.js");
delete process.env.RCS_PROJECT_ROOT; // env.js may load one from .env; this test needs none

check("no folder until one is chosen", store.ROOT === null || process.env.RCS_PROJECT_ROOT, String(store.ROOT));
const t = await store.scan();
check("the Library is told to ask for one", t.needsRoot === true && t.series.length === 0);
let e = null; try { store.safeResolve("x"); } catch (err) { e = err; }
check("nothing reads or writes without a folder", e && e.status === 409);
e = null; try { await store.setRoot("relative/path"); } catch (err) { e = err; }
check("a relative path is refused", e && e.status === 400);
const want = path.join(TMP, "My Projects");
e = null; try { await store.setRoot(want); } catch (err) { e = err; }
check("a missing folder is refused unless 'create' is ticked", e && e.status === 404);
const got = await store.setRoot(want, { create: true });
check("created and chosen", got === want && (await fs.stat(want)).isDirectory() && store.ROOT === want);
check("the inbox sits beside it", store.GENERATED_ROOT === path.join(TMP, "generated_imgs"));
const saved = JSON.parse(await fs.readFile(process.env.RCS_SETTINGS_FILE, "utf8"));
check("saved to the settings file", saved.projectRoot === want);
check("paths now resolve inside it", store.safeResolve("Show/E1").startsWith(want));
await fs.writeFile(path.join(TMP, "afile"), "x");
e = null; try { await store.setRoot(path.join(TMP, "afile")); } catch (err) { e = err; }
check("a file isn't a folder", e && e.status === 400);
check("the library scans the new folder", (await store.scan()).needsRoot === false);

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✓" : "✗"} settings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
