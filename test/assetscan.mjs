// Identity Vault "Find new images": lists asset-folder images across the series
// that the vault doesn't use yet. Built 2026-10-10 after "Rescan 02_assets"
// turned out to call a function deleted in September.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-assetscan-"));
process.env.RCS_PROJECT_ROOT = ROOT;
const store = await import("../server/store.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const put = async (rel, bytes = 10) => {
  const p = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.alloc(bytes, 1));
};

await put("Series/_RedClover/02_assets/turnarounds/Hero_turnaround.jpg", 100);
await put("Series/_RedClover/02_assets/turnarounds/Hero face closeup.png", 200);
await put("Series/_RedClover/02_assets/locations/Street_NIGHT.png", 300);
await put("Series/_RedClover/02_assets/notes.txt", 5);
await put("Series/EP1/02_assets/props/bread.png", 400);
await put("Series/EP1 - Remaster/02_assets/characters/Hero face closeup.png", 200); // copy of the shared one
await put("Series/EP1 - Remaster/03_storyboard/01a_start.png", 500);
await put("Series/EP1 - Remaster/05_delivery/takes/frame.png", 600);
await put("Series/Keyframes/old.png", 700);
await put("Series/_RedClover/02_assets/.hidden.png", 800);

const ep = "Series/EP1 - Remaster";
const registered = ["Series/_RedClover/02_assets/turnarounds/Hero_turnaround.jpg", "Series/EP1 - Remaster/02_assets/characters/Hero face closeup.png"];
const files = await store.listNewAssetImages("Series", ep, registered);
const names = files.map((f) => f.name);

check("finds an unregistered image in the shared _RedClover/02_assets", names.includes("Street_NIGHT.png"), names.join(", "));
check("finds an unregistered image in another episode's 02_assets", names.includes("bread.png"));
check("a registered path is left out", !names.includes("Hero_turnaround.jpg"));
check("a byte-identical copy of a registered image is left out", !names.includes("Hero face closeup.png"));
check("storyboards, deliveries and loose folders are not asset folders", !names.includes("01a_start.png") && !names.includes("frame.png") && !names.includes("old.png"));
check("non-images and hidden files are skipped", !names.includes("notes.txt") && !names.includes(".hidden.png"));
check("each result says which folder it is in", files.find((f) => f.name === "bread.png")?.folder === "EP1/02_assets/props");
check("paths are relative to the project root", files.every((f) => f.path.startsWith("Series/")));

const solo = await store.listNewAssetImages(null, "Series/EP1", []);
check("no series: scans only the episode's own 02_assets", solo.length === 1 && solo[0].name === "bread.png", solo.map((f) => f.name).join(", "));

// Deleting one angle keeps shots pointing at the card.
const { removeAssetKeepRefs } = await import("../shared/schema.js");
const mk = () => ({
  assets: [
    { id: "empty", type: "prop", name: "rusty scissors", path: "" },
    { id: "img", type: "prop", name: "Rusty Scissors ", path: "x/shears.png" },
    { id: "solo", type: "prop", name: "rat", path: "x/rat.png" },
  ],
  shots: [{ id: "s1", refs: ["empty", "solo"] }, { id: "s2", refs: ["empty", "img"] }, { id: "s3", refs: ["solo"] }],
});
let e1 = mk();
const heir = removeAssetKeepRefs(e1, "empty");
check("deleting an empty slot: shots move to the card's image angle", heir?.id === "img" && e1.shots[0].refs.join() === "img,solo", JSON.stringify(e1.shots[0].refs));
check("a shot that already had the other angle doesn't get it twice", e1.shots[1].refs.join() === "img");
check("the slot is gone from the vault", !e1.assets.some((a) => a.id === "empty") && e1.assets.length === 2);
let e2 = mk();
check("deleting a card's last angle has no heir; other shots untouched", removeAssetKeepRefs(e2, "solo") === null && e2.shots[2].refs.join() === "solo");
check("an unknown id changes nothing", removeAssetKeepRefs(mk(), "nope") === null);

await fs.rm(ROOT, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} asset scan: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
