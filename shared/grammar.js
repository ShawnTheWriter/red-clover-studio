// Shot grammar — the controlled vocabulary shared by the server prompt builders
// and the browser UI. Ported verbatim from Red Clover Production Desk.html so the
// prompt wording that was tuned against real generations does not drift.

export const SIZES = {
  WS: "a wide establishing shot",
  MWS: "a medium-wide shot",
  MS: "a medium shot",
  MCU: "a medium close-up",
  CU: "a close-up",
  ECU: "an extreme close-up",
  INS: "a tight insert shot isolating a detail",
};

export const LENSES = {
  "24mm": "a wide 24mm lens",
  "35mm": "a normal 35mm lens",
  "50mm": "a normal 50mm lens",
  "85mm": "a telephoto 85mm lens",
};

export const ANGLES = {
  eye: "at eye level",
  low: "from a low angle looking up",
  high: "from a high angle looking down",
  dutch: "with a Dutch tilt",
  birdseye: "a bird's-eye top-down view",
  wormseye: "a worm's-eye view looking straight up",
  ots: "over-the-shoulder, foreground shoulder soft",
  god: "an extreme overhead god shot",
};

export const ANGLE_FX = {
  low: " (power, authority)",
  high: " (vulnerability, isolation)",
  dutch: " (tension, disorientation)",
  wormseye: " (colossal, imposing)",
};

export const MOVES = {
  static: "static (locked-off)",
  push: "slow push-in",
  pull: "slow pull-back",
  dolly: "lateral dolly / track",
  track: "tracking shot (follow subject)",
  crane_up: "crane up",
  crane_down: "crane down",
  whip_pan: "whip pan",
  whip_zoom: "whip zoom",
  pan: "pan",
  tilt: "tilt",
  handheld: "handheld",
};

export const DELIVERY = [
  "neutral", "angry", "sad", "crying", "laughing", "smiling", "concerned",
  "whispering", "shouting", "fearful", "sarcastic", "tender", "pleading",
];

export const TREATMENTS = [
  { id: "emo_peak", label: "Emotional peak (ECU on eyes)", tip: "Tighten to an extreme close-up holding the key emotion", phrase: "reframe tighter to an extreme close-up, holding the key emotion in the eyes and micro-expressions" },
  { id: "pov_char", label: "POV (first person)", tip: "See it from the character's eyes", phrase: "frame as the character's first-person POV, as if seen through their eyes" },
  { id: "pov_reverse", label: "Reverse / OTS", tip: "Over-the-shoulder reverse on the other character", phrase: "shoot the reverse over-the-shoulder angle, foreground shoulder soft, the other character centered in frame" },
  { id: "dutch_tension", label: "Dutch tilt (tension)", tip: "Tilt the horizon for unease", phrase: "tilt to a Dutch angle to charge the frame with psychological tension" },
  { id: "low_power", label: "Low angle (power)", tip: "Look up to empower the subject", phrase: "drop to a low angle looking up so the subject feels powerful and imposing" },
  { id: "high_vuln", label: "High angle (vulnerable)", tip: "Look down to diminish the subject", phrase: "raise to a high angle looking down so the subject feels small and vulnerable" },
  { id: "handheld", label: "Handheld (immediacy)", tip: "Raw, breathing camera", phrase: "use a handheld, breathing camera for raw immediacy" },
  { id: "slowpush", label: "Slow push-in", tip: "Build intensity", phrase: "add a slow push-in to build intensity toward the beat" },
  { id: "isolate", label: "Isolate in negative space", tip: "Stress loneliness / scale", phrase: "isolate the subject within wide empty negative space to stress loneliness and scale" },
  { id: "silhouette", label: "Silhouette / backlight", tip: "Mystery, mood", phrase: "render the subject as a backlit silhouette for mystery" },
  { id: "insert_detail", label: "Cut to detail insert", tip: "Tight on the key object", phrase: "cut to a tight detail insert of the key object in the action" },
];

export const BEAT_ROLES = ["start", "mid", "end", "beat"];

// --- naming helpers (frame base names must stay byte-identical to v1) ---
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const hslug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const slug = (s) => (s || "shot").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function pad2(s) {
  s = (s == null ? "" : s).toString().trim();
  return /^\d+$/.test(s) ? s.padStart(2, "0") : s;
}

// Carryover/imported take labels sometimes bake in the shot code they were
// created under ("2c - Overlock wakes…") — but shot letters are DERIVED from
// position (renumberScene) and drift the moment anything reorders, moves, or
// deletes a shot, so a baked-in prefix goes stale silently and no longer
// means what it says. Strips one leading "<scene><code>" token (optionally
// followed by a dash/em-dash) and re-capitalizes what's left. Returns the
// label unchanged if it doesn't match — this only strips, never invents.
export function stripStaleLabelPrefix(label) {
  const s = (label || "").trim();
  const m = s.match(/^\d{1,3}[a-z]{1,2}\s*[-—]?\s+(.+)$/i);
  return m && m[1] ? cap(m[1].trim()) : s;
}

export function shotCodeStr(shot) {
  return (pad2(shot.sceneNum) || "") + (shot.shotCode || "");
}

export function slugline(shot) {
  const ie = shot.intext || "INT.";
  const loc = (shot.loc || "").toUpperCase();
  const tm = (shot.time || "DAY").toUpperCase();
  return `${ie} ${loc} - ${tm}`.replace(/\s+/g, " ").trim();
}

export function locSlug(shot) {
  const ie = (shot.intext || "INT.").replace(/[^A-Za-z]/g, "").toLowerCase();
  return `${ie}-${hslug(shot.time || "day")}-${hslug(shot.loc || "loc")}`;
}

export function frameBaseName(shot) {
  return `${shotCodeStr(shot) || "shot"}_${locSlug(shot)}_${hslug(shot.label || shot.size || "frame")}`;
}

// Suffix for a beat's still frame. A lone start beat gets no suffix, matching v1
// where kf:"single" produced an unsuffixed name.
export function beatSuffix(shot, beat, index) {
  const kfs = (shot.beats || []).filter((b) => b.keyframe);
  if (kfs.length <= 1 && beat.role === "start") return "";
  return `_${beat.role === "beat" ? `b${index + 1}` : beat.role}`;
}

export function beatFrameName(shot, beat, index) {
  return frameBaseName(shot) + beatSuffix(shot, beat, index);
}

export function secToTC(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), ss = s % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function estBeatDuration(text) {
  const words = ((text || "").trim().match(/\S+/g) || []).length;
  return Math.min(4, Math.max(1.5, words / 2.2));
}

// v1 split a single-keyframe shot's action sentence into narrative beats for the
// timecoded draft. v2 runs this once at migration to turn that implicit guess into
// explicit, editable beats.
export function splitBeats(text) {
  text = (text || "").trim();
  if (!text) return [];
  return text.split(/(?<=[.;!?])\s+|\s+(?:then|as|while)\s+/i).map((s) => s.trim()).filter(Boolean);
}
