// Drag-and-drop reorders: shots within a scene re-letter; scenes renumber and
// carry their shots; screenplay numbers survive in scriptNumber.
const { reorderShot, reorderScenes, newShot } = await import("../shared/schema.js");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`); };
const shot = (id, sceneNum, shotCode) => Object.assign(newShot({ sceneNum, shotCode }), { id });
const mk = () => ({
  scenes: [{ number: "1", heading: "A" }, { number: "2", heading: "B" }, { number: "3", heading: "C" }],
  shots: [shot("g", "1", "a"), shot("h", "1", "b"), shot("i", "1", "c"), shot("j", "2", "a"), shot("k", "3", "a"), shot("x", "X", "a")],
});
const codes = (ep) => ep.shots.map((s) => `${s.id}:${s.sceneNum}${s.shotCode}`).join(" ");

let ep = mk();
reorderShot(ep, "i", "g");
check("drag 1c before 1a re-letters the scene", codes(ep).startsWith("i:1a g:1b h:1c"), codes(ep));
ep = mk(); reorderShot(ep, "g", null);
check("drop at the end of the scene", codes(ep).startsWith("h:1a i:1b g:1c j:2a"), codes(ep));
ep = mk();
let threw = false; try { reorderShot(ep, "g", "j"); } catch { threw = true; }
check("cross-scene drag is refused", threw);

ep = mk(); reorderScenes(ep, ["3", "1", "2"]);
check("scenes renumber in the new order", ep.scenes.map((s) => `${s.number}${s.heading}`).join(",") === "1C,2A,3B", ep.scenes.map((s) => `${s.number}${s.heading}`).join(","));
check("shots move with their scene, order kept", codes(ep) === "k:1a g:2a h:2b i:2c j:3a x:Xa", codes(ep));
check("screenplay number kept in scriptNumber", ep.scenes.find((s) => s.heading === "C").scriptNumber === "3");
threw = false; try { reorderScenes(mk(), ["1", "2"]); } catch { threw = true; }
check("an incomplete order is refused", threw);

console.log(`\n${fail === 0 ? "✓" : "✗"} reorder: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
