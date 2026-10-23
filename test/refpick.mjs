// Picking WHICH image of a vault card a shot sends (a costume instead of the main image),
// and what the prompt says about it. No network.
import { resolveReferenceSet, resolveReferencePrompt, resolveFramesRefSet, cardKey, cardMain } from "../shared/prompts.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); };

const A = (id, type, name, angle, path) => ({ id, type, name, angle, path, identityHold: "" });
const assets = [
  A("sMain", "character", "Serge Stitch", "", "a/serge_day.jpg"),
  A("sFace", "character", "Serge Stitch", "Face Closeups", "a/serge_face.png"),
  A("sNight", "character", "Serge Stitch", "Serge in night clothes", "a/serge_night.jpg"),
  A("oMain", "character", "Overlock", "", "a/overlock.jpg"),
  A("house", "location", "Overlock House", "", "a/house.jpg"),
];
const shot = (refs) => ({ id: "s1", sceneNum: 1, shotCode: "a", move: "static", action: "He wakes.", beats: [], refs, versions: [] });
const ep = { assets, fmt: "9:16" };

console.log("cards");
check("a card is every image with the same type and name", cardKey(assets[0]) === cardKey(assets[2]) && cardKey(assets[0]) !== cardKey(assets[3]));
check("the card's main image is the first one with a file", cardMain(assets.slice(0, 3)).id === "sMain" && cardMain([A("x", "prop", "Cup", "", ""), A("y", "prop", "Cup", "side", "p.jpg")]).id === "y");

console.log("\nreferences mode (Seedance): exactly the images the shot points at");
let r = resolveReferenceSet(shot(["sNight"]), ep);
check("pointing at the night clothes sends only that image, labelled with its costume", r.images.length === 1 && r.images[0].path === "a/serge_night.jpg" && /Serge Stitch — Serge in night clothes \(character\)/.test(r.images[0].label), JSON.stringify(r.images));
r = resolveReferenceSet(shot(["sMain", "sNight", "house"]), ep);
check("main + night + a location: three images, in vault order", r.images.map((x) => x.path).join() === "a/serge_day.jpg,a/serge_night.jpg,a/house.jpg");
const p = resolveReferencePrompt(shot(["sNight"]), ep);
check("the prompt's image list names the costume", /@Image1 = Serge Stitch — Serge in night clothes \(character\)/.test(p.text), p.text.slice(0, 200));
check("the main image keeps its plain label", /@Image1 = Serge Stitch \(character\)/.test(resolveReferencePrompt(shot(["sMain"]), ep).text));

console.log("\nframes + references mode (H3 Max)");
let f = resolveFramesRefSet(shot(["sMain"]), ep);
check("main image alone: every angle goes (day clothes, face close-ups, night clothes), as before", f.images.map((x) => x.path).join() === "a/serge_day.jpg,a/serge_face.png,a/serge_night.jpg", f.images.map((x) => x.path).join());
f = resolveFramesRefSet(shot(["sNight"]), ep);
check("pointing at the night clothes: only the night clothes, no day clothes", f.images.map((x) => x.path).join() === "a/serge_night.jpg", f.images.map((x) => x.path).join());
f = resolveFramesRefSet(shot(["sNight", "sFace", "oMain", "house"]), ep);
check("night clothes + face close-ups + Overlock (main alone, one image card) + the house", f.images.map((x) => x.path).join() === "a/serge_face.png,a/serge_night.jpg,a/overlock.jpg,a/house.jpg", f.images.map((x) => x.path).join());
f = resolveFramesRefSet(shot(["sMain", "sNight"]), ep);
check("main + night clothes picked: just those two", f.images.map((x) => x.path).join() === "a/serge_day.jpg,a/serge_night.jpg");

console.log(`\n${fail === 0 ? "✓" : "✗"} refpick: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
