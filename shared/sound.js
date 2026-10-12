// Shared by server and browser so the prompt Shawn sees in the Room tone lane
// is exactly the one Generate sends (the app's shown == sent rule).
export function defaultRoomTonePrompt(scene) {
  const where = [scene.intext, scene.loc].filter(Boolean).join(" ").trim();
  const when = (scene.time || "").trim();
  const slug = scene.heading && scene.heading !== "(no slugline)" ? scene.heading : `${where}${when ? ` - ${when}` : ""}`;
  return `Room tone and ambience for ${slug}. Continuous, even background, no voices, no music, no sudden sounds.`;
}

// SFX from picture: the prompt only guides the model (it also watches the
// take). Kling takes at most 200 characters, so this stays short.
export function defaultSfxPrompt(shot, scene) {
  const what = (shot.action || shot.label || "").trim().replace(/\s+/g, " ");
  const where = scene && scene.heading && scene.heading !== "(no slugline)" ? scene.heading : [shot.intext, shot.loc, shot.time].filter(Boolean).join(" ");
  return `${what}${where ? `. ${where}` : ""}. Realistic sound effects in sync with the action, no music, no voices.`.slice(0, 200);
}
