// 2D top-down blocking — the cheap 80% of the researched 3D storyboard viewport.
// A shot's blocking is character and camera positions on a normalized 0..1
// square stage (no room dimensions, no real-world units — it's a relative
// diagram, not a set plan). This is enough to catch the one thing that
// actually breaks a cut: crossing the line of action.
//
// The 180-degree rule, precisely: once two characters establish a line
// between them (the axis, or "line of interest"), the camera should stay on
// one side of it for the scene, or a cut across it reads as a spatial jump —
// characters who were facing each other suddenly appear to swap sides.
//
// What this checks (a real simplification, documented as one): for each pair
// of CONSECUTIVE shots in the same scene that share at least two blocked
// characters, the axis is the line through those two characters' positions
// AS RECORDED IN THE EARLIER SHOT — the blocking that established the line.
// The later shot's camera is tested against that same line. A flip in side
// is flagged. This catches the common case (a static two-hander) and does
// not model deliberate, motivated line crosses (a character walking across
// it) — those need a human's eye, not a diagram.

export function newBlocking(partial = {}) {
  return {
    chars: partial.chars || [],   // [{ key, name, x, y }] — x,y in 0..1
    camera: partial.camera || null, // { x, y } in 0..1, or null (not placed)
  };
}

// Signed area / cross-product sign: which side of the line A->B does P fall
// on? Positive/negative = the two sides; 0 = on the line.
function side(a, b, p) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return Math.sign(Math.round(cross * 1e6) / 1e6); // tolerance for float noise
}

// Characters shared between two blockings, by key, in the order they appear
// in `a`. Only the first two matter for an axis (a third or more speaking
// character doesn't change which line was established).
function sharedChars(a, b) {
  const bKeys = new Set((b.chars || []).map((c) => c.key));
  return (a.chars || []).filter((c) => bKeys.has(c.key));
}

// Check one consecutive pair. Returns null if there isn't enough blocking
// data to say anything (fewer than 2 shared characters, or no camera placed
// in either shot) — silence, not a false "ok".
export function checkPair(blockA, blockB) {
  if (!blockA || !blockB || !blockA.camera || !blockB.camera) return null;
  const shared = sharedChars(blockA, blockB);
  if (shared.length < 2) return null;
  const [a, b] = shared;
  const sideA = side(a, b, blockA.camera);
  const sideB = side(a, b, blockB.camera);
  if (sideA === 0 || sideB === 0) return null; // camera on the axis — ambiguous, not a violation
  return { axis: [a.name, b.name], crossed: sideA !== sideB, sideA, sideB };
}

// Walk a scene's shots in order (already filtered/sorted by the caller — this
// module doesn't know about scene grouping) and report every crossing.
export function sceneAxisWarnings(shots) {
  const warnings = [];
  for (let i = 0; i < shots.length - 1; i++) {
    const a = shots[i], b = shots[i + 1];
    const result = checkPair(a.blocking, b.blocking);
    if (result && result.crossed) {
      warnings.push({
        shotAId: a.id, shotBId: b.id,
        shotACode: `${a.sceneNum}${a.shotCode}`, shotBCode: `${b.sceneNum}${b.shotCode}`,
        axis: result.axis,
      });
    }
  }
  return warnings;
}

// Group an episode's shots by scene number (preserving shot-list order within
// each scene) and run the check within each group — a cut BETWEEN scenes
// isn't a line-of-action violation, it's just a new scene.
export function episodeAxisWarnings(shots) {
  const byScene = new Map();
  for (const s of shots) {
    if (!byScene.has(s.sceneNum)) byScene.set(s.sceneNum, []);
    byScene.get(s.sceneNum).push(s);
  }
  const out = [];
  for (const sceneShots of byScene.values()) out.push(...sceneAxisWarnings(sceneShots));
  return out;
}

// One plain sentence describing the blocking as the camera sees it — who is
// screen-left / screen-right and who is nearer the camera — for a shot that
// has opted in (shot.blockingInPrompt). The camera is taken to look at the
// centre of the placed characters. Diagram y grows downward, like the widget.
// Returns "" when there's nothing to say (no camera or no characters).
export function blockingSentence(blocking) {
  const b = blocking || {};
  const cam = b.camera;
  const chars = (b.chars || []).filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
  if (!cam || !chars.length) return "";
  const cx = chars.reduce((t, c) => t + c.x, 0) / chars.length;
  const cy = chars.reduce((t, c) => t + c.y, 0) / chars.length;
  let fx = cx - cam.x, fy = cy - cam.y;
  const len = Math.hypot(fx, fy);
  if (len < 1e-6) return "";
  fx /= len; fy /= len;
  const placed = chars.map((c) => {
    const vx = c.x - cam.x, vy = c.y - cam.y;
    // Camera's right in this y-down plane is (-fy, fx).
    const lateral = vx * -fy + vy * fx;
    const depth = vx * fx + vy * fy;
    return { name: c.name || c.key || "a figure", lateral, depth };
  });
  const parts = placed
    .sort((a, b) => a.lateral - b.lateral)
    .map((p) => {
      const side = Math.abs(p.lateral) < 0.06 ? "centre frame" : p.lateral < 0 ? "screen-left" : "screen-right";
      return `${p.name} ${side}`;
    });
  let depthNote = "";
  if (placed.length > 1) {
    const near = [...placed].sort((a, b) => a.depth - b.depth);
    if (near[near.length - 1].depth - near[0].depth > 0.12) depthNote = `; ${near[0].name} nearest the camera`;
  }
  return `Blocking: ${parts.join(", ")}${depthNote}. Keep these positions; the camera stays on this side of them.`;
}
