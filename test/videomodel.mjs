// Which model a shot's Generate pane starts on, and that the choice survives
// a save/load (it used to live only in browser memory and reset to H3).
import { videoModelFor, ensureV2, newEpisode, newShot } from "../shared/schema.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

const H3 = "minimax/h3/image-to-video", MAX = "minimax/h3-max/image-to-video", SD = "bytedance/seedance-2.5/image-to-video";
const ids = [H3, MAX, SD];

check("no choices anywhere: the first model", videoModelFor({}, {}, ids) === H3);
check("episode default applies to a shot with no pick", videoModelFor({ videoModelId: "" }, { defaultVideoModelId: MAX }, ids) === MAX);
check("a shot's own pick beats the episode default", videoModelFor({ videoModelId: SD }, { defaultVideoModelId: MAX }, ids) === SD);
check("a removed model falls through to the default", videoModelFor({ videoModelId: "gone/model" }, { defaultVideoModelId: MAX }, ids) === MAX);
check("a removed default falls through to the first model", videoModelFor({}, { defaultVideoModelId: "gone/model" }, ids) === H3);
check("no models at all: null, not a throw", videoModelFor({}, {}, []) === null);

const shot = newShot({ videoModelId: SD });
const ep = newEpisode({ defaultVideoModelId: MAX, shots: [shot] });
const back = ensureV2(JSON.parse(JSON.stringify(ep)), { dir: "x" });
check("the episode default survives save + load (ensureV2 keeps it)", back.defaultVideoModelId === MAX);
check("the shot's pick survives save + load", back.shots[0].videoModelId === SD);
check("a new shot has no pick of its own", newShot({}).videoModelId === "");
check("a new episode has no default", newEpisode({}).defaultVideoModelId === null);

console.log(`\n${fail ? "✗" : "✓"} video model choice: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
