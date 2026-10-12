// The Resolve scene-bins script. The generated Lua runs against a fake Media
// Pool (test/fixtures/fake-resolve.lua) inside Resolve's OWN LuaJIT library,
// loaded through Python ctypes. Skipped (not failed) on a machine without
// Resolve installed.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSceneBinsLua, sceneBinScripts, binNameFor } from "../server/resolve-script.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUAJIT = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib";
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

console.log("bins from the episode");
const ep = {
  scenes: [{ number: "1", heading: "INT. HUT" }, { number: "2", heading: "(no slugline)" }],
  shots: [
    { sceneNum: "2", versions: [{ state: "done", path: "S/takes/2a_x_v3.mp4" }] },
    { sceneNum: "1", versions: [{ state: "done", path: "S/takes/1a_x_v1.mp4" }, { state: "error", path: "S/takes/bad.mp4" }, { state: "done", path: "S/takes/gone.mp4" }] },
    { sceneNum: "X", versions: [{ state: "done", path: "S/_archive/cut/takes/2b_x_v4.mp4" }] },
  ],
};
check("bin names carry the full slugline", binNameFor(ep, "1") === "Scene 1 — INT. HUT" && binNameFor(ep, "X") === "Cut from edit");
check("no heading: built from the scene's own INT/EXT, location, time", binNameFor({ scenes: [{ number: "4", intext: "EXT.", loc: "Village Alleyway", time: "NIGHT" }] }, "4") === "Scene 4 — EXT. Village Alleyway - NIGHT");
check("no heading or fields: from its first shot's slugline fields", binNameFor({ scenes: [], shots: [{ sceneNum: "5", intext: "INT.", loc: "Workshop", time: "DAY" }] }, "5") === "Scene 5 — INT. Workshop - DAY");
check("nothing to build from: just the number", binNameFor(ep, "2") === "Scene 2");
const s = await sceneBinScripts(ep, "/r", { exists: async (p) => !p.endsWith("gone.mp4") });
check("bins in scene order, Cut from edit last", s.bins.map((b) => b.name).join("|") === "Scene 1 — INT. HUT|Scene 2|Cut from edit", JSON.stringify(s.bins));
check("only finished takes whose file exists are listed", s.bins[0].takes === 1);
check("the two versions differ only in the import switch", s.plain.includes("IMPORT_ALL_TAKES = false") && s.withTakes.includes("IMPORT_ALL_TAKES = true"));

console.log("\nrunning the Lua");
let canRun = true;
try { await fs.access(LUAJIT); execFileSync("python3", ["-c", "import ctypes"]); } catch { canRun = false; }
if (!canRun) {
  console.log("  - skipped: DaVinci Resolve's LuaJIT not found");
} else {
  const takes = [
    { abs: "/r/S/takes/1a_x_v1.mp4", bin: "Scene 1 — INT. HUT" },
    { abs: "/r/S/takes/1a_x_v2.mp4", bin: "Scene 1 — INT. HUT" },
    { abs: "/r/S/takes/2a_x_v3.mp4", bin: "Scene 2" },
    { abs: "/r/S/_archive/cut/takes/2b_x_v4.mp4", bin: "Cut from edit" },
    { abs: "/r/odd]]name.mp4", bin: "Scene 2" },
  ];
  const bins = ["Scene 1 — INT. HUT", "Scene 2", "Cut from edit"];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-lua-"));
  const runLua = async (importAll) => {
    const file = path.join(dir, `s${importAll ? 2 : 1}.lua`);
    const code = `${await fs.readFile(path.join(HERE, "fixtures/fake-resolve.lua"), "utf8")}\n${buildSceneBinsLua({ episodeName: "T", generatedAt: "now", takes, bins, importAll })}\nfor _,l in ipairs(LOG) do print("LOG "..l) end\n`;
    await fs.writeFile(file, code);
    return runFile(file);
  };
  const runFile = (file) => {
    const py = `import ctypes,sys
L=ctypes.CDLL(sys.argv[1]);L.luaL_newstate.restype=ctypes.c_void_p
L.luaL_openlibs.argtypes=[ctypes.c_void_p];L.luaL_loadstring.argtypes=[ctypes.c_void_p,ctypes.c_char_p]
L.lua_pcall.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int]
L.lua_tolstring.restype=ctypes.c_char_p;L.lua_tolstring.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p]
st=L.luaL_newstate();L.luaL_openlibs(st)
if L.luaL_loadstring(st,open(sys.argv[2],'rb').read()) or L.lua_pcall(st,0,0,0): print("LUAERROR "+L.lua_tolstring(st,-1,None).decode())`;
    return execFileSync("python3", ["-c", py, LUAJIT, file], { encoding: "utf8" });
  };
  const a = await runLua(false);
  check("the script loads and runs in Resolve's LuaJIT", !a.includes("LUAERROR"), a);
  check("it announces itself first", a.trimStart().startsWith("Red Clover: starting"), a.slice(0, 80));
  check("a clip in the root moves to its scene bin", a.includes("LOG move:/r/S/takes/1a_x_v1.mp4 -> Scene 1 — INT. HUT"));
  check("a clip in another folder moves too", a.includes("LOG move:/r/S/takes/2a_x_v3.mp4 -> Scene 2"));
  check("a path with ]] in it still matches", a.includes("LOG move:/r/odd]]name.mp4 -> Scene 2"));
  check("an unknown clip stays put and is counted", a.includes("left 1 clip(s)") && !a.includes("unknown.mp4 ->"));
  check("the plain version imports nothing and makes no empty bin", !a.includes("LOG import:") && !a.includes("LOG bin:Cut from edit"));
  const broken = await (async () => {
    const file = path.join(dir, "broken.lua");
    const fake = await fs.readFile(path.join(HERE, "fixtures/fake-resolve.lua"), "utf8");
    // A Media Pool whose MoveClips throws: the error must be printed, not swallowed.
    await fs.writeFile(file, `${fake}\nfunction MP:MoveClips() error("boom") end\n${buildSceneBinsLua({ episodeName: "T", generatedAt: "now", takes, bins, importAll: false })}`);
    return runFile(file);
  })();
  check("an error inside Resolve is printed, not silent", broken.includes("Red Clover: ERROR") && broken.includes("boom"), broken);
  const noGlobal = await (async () => {
    const file = path.join(dir, "noglobal.lua");
    const fake = await fs.readFile(path.join(HERE, "fixtures/fake-resolve.lua"), "utf8");
    await fs.writeFile(file, `${fake}\nresolve = nil\n${buildSceneBinsLua({ episodeName: "T", generatedAt: "now", takes, bins, importAll: false })}`);
    return runFile(file);
  })();
  check("works without the resolve global (falls back to Resolve())", noGlobal.includes("Red Clover: done. Moved 3"), noGlobal);
  const b = await runLua(true);
  check("+ all takes imports only the takes not already in the pool", b.includes("LOG import:/r/S/takes/1a_x_v2.mp4 -> Scene 1 — INT. HUT") && b.includes("LOG import:/r/S/_archive/cut/takes/2b_x_v4.mp4 -> Cut from edit") && !b.includes("import:/r/S/takes/1a_x_v1.mp4"));
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✓" : "✗"} resolve script: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
