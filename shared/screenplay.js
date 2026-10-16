// Screenplay ingestion — Final Draft (.fdx) and Fountain (.fountain/.txt/.md).
//
// Output shape is deliberately narrow: scenes with reliable structured fields
// (heading, intext, loc, time, characters), plus a props DRAFT that needs human
// confirmation. Prop extraction from prose is a genuinely different problem —
// the platforms that do it well (Dramagic) run a multi-agent LLM pipeline, not a
// regex. A deterministic parser that claimed to nail props would be lying about
// its own certainty, so the draft is flagged as a draft and nothing else.
//
// Real fixtures this was built and tested against: Man in the Glass's combined
// 10-episode .fdx (mixed-case scene headings, spelled-out act numbers, blank
// spacer "Scene Heading" paragraphs Final Draft inserts, multi-run Parenthetical
// text) and Fashion Heist's single-episode .fdx.

import { newScene, uid } from "./schema.js";

// ---------- shared normalization ----------

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// "Begin episode 2" / "Begin episode three" / "EPISODE 4" -> 2 / 3 / 4
export function extractNumber(text) {
  if (!text) return null;
  const digit = /(\d+)/.exec(text);
  if (digit) return parseInt(digit[1], 10);
  const word = /\b([a-z]+)\b/gi;
  let m;
  while ((m = word.exec(text))) {
    const n = WORD_NUM[m[1].toLowerCase()];
    if (n) return n;
  }
  return null;
}

// Scene headings and character cues arrive in every possible case: "InT.",
// "lATER", "FaN" vs "Fan" vs "fan". Normalize for matching, keep a clean
// display form separate from the identity key.
export function titleCase(s) {
  return (s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// A character's identity key strips scene-direction extensions so "Ming",
// "MING", and "Ming (V.O.)" all resolve to the same person, while the display
// name keeps a readable form.
const EXT_RX = /\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|FILTERED|PRE-?LAP)\)\s*$/i;

export function characterKey(rawCue) {
  return (rawCue || "").replace(EXT_RX, "").trim().toUpperCase().replace(/\s+/g, " ");
}

export function characterDisplay(rawCue) {
  return titleCase((rawCue || "").replace(EXT_RX, "").trim()).replace(/\s+/g, " ");
}

// "INT. Li's Bathroom - morning" -> { intext, loc, time }
const HEADING_RX = /^\s*(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|I\/E\.?)\s*[.\-–]?\s*(.*)$/i;

export function parseHeading(raw) {
  const text = (raw || "").trim();
  const m = HEADING_RX.exec(text);
  if (!m) return { intext: "INT.", loc: text, time: "DAY", heading: text };
  let intext = m[1].toUpperCase().replace(/\.?\/.*$/, m[1].includes("/") ? "" : ".");
  intext = /INT/.test(m[1].toUpperCase()) && /EXT/.test(m[1].toUpperCase()) ? "INT./EXT."
    : /EXT/i.test(m[1]) ? "EXT." : "INT.";
  const rest = m[2].trim();
  // Location and time are usually the last " - " segment, but locations
  // themselves can contain a hyphen ("Li's apartment - front entryway - day"),
  // so split on the LAST separator only.
  const parts = rest.split(/\s+[-–]\s+/);
  const time = parts.length > 1 ? parts.pop().trim().toUpperCase() : "DAY";
  const loc = parts.join(" - ").trim();
  return { intext, loc: titleCase(loc), time, heading: `${intext} ${titleCase(loc)} - ${time}` };
}

// Two independent extractors, tuned against real scripts rather than guessed.
// Checked on both Man in the Glass (10 eps) and Fashion Heist S1E1: in neither
// does ALL-CAPS mark a prop — it marks a character introduction ("MING (38)")
// or a background/walk-on role ("CAR DRIVER", "POLITE POLICE OFFICER",
// "SLEEPING MAN"). Bare single-word ALL-CAPS ("SLAMS", "LEFT", "CLICK") is
// action-line emphasis, not a noun at all. So:
//   - a NAME (age) run is a character introduction, not an extra.
//   - a 2+ word ALL-CAPS run that ISN'T a known character is a background role.
//   - a genuine prop draft comes ONLY from quoted phrases, which is rare and
//     high-precision — neither real script contained a single false positive
//     from quotes, nor a single true prop caught by capitalization.
// If a script's convention differs, this under-triggers rather than spams a
// junk list; props are novel character introductions here anyway and worth a
// human pass regardless.
const STOP = new Set([
  "INT", "EXT", "DAY", "NIGHT", "LATER", "MORNING", "EVENING", "CONTINUOUS",
  "MOMENTS", "SAME", "TIME", "CUT", "TO", "SMASH", "INTERCUT", "WITH", "FADE", "IN", "OUT",
]);

const NAME_AGE_RX = /\b([A-Z][A-Z']{1,}(?:\s+[A-Z][A-Z']{1,}){0,2})\s*\(\d{1,3}\)/g;
const CAPS_RUN_RX = /\b([A-Z][A-Z']{2,}(?:\s+[A-Z][A-Z']{2,}){1,3})\b/g;

function draftProps(actionText) {
  const found = new Map();
  const quoted = actionText.match(/"([^"]{2,40})"/g) || [];
  quoted.forEach((q) => {
    const name = q.replace(/"/g, "").trim();
    found.set(name.toUpperCase(), name);
  });
  return [...found.values()];
}

// Named-but-introduced-in-action characters ("MING (38)") — a strong signal,
// distinct from a Character cue but just as much a real person.
function draftIntroductions(actionText) {
  const found = new Map();
  let m;
  NAME_AGE_RX.lastIndex = 0;
  while ((m = NAME_AGE_RX.exec(actionText))) {
    const key = m[1].trim();
    if (!STOP.has(key)) found.set(key, titleCase(key));
  }
  return found;
}

// Walk-on / background roles named but never given a Character cue ("CAR
// DRIVER"). Multi-word only — single ALL-CAPS words are almost always
// emphasis on a verb, not a noun, in both scripts this was tuned against.
function draftExtras(actionText, knownKeys) {
  const found = new Map();
  let m;
  CAPS_RUN_RX.lastIndex = 0;
  while ((m = CAPS_RUN_RX.exec(actionText))) {
    const key = m[1].trim();
    if (knownKeys.has(key)) continue;
    if (key.split(/\s+/).every((w) => STOP.has(w))) continue;
    found.set(key, titleCase(key));
  }
  return found;
}

// ---------- FDX ----------

// Deliberately does NOT trim: a run's leading/trailing space is the only thing
// separating it from its neighbours once the runs are concatenated.
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}

// Concatenate a paragraph's Text runs. FDX splits one line across several
// <Text> elements when a mid-line style change occurs — e.g. a Parenthetical
// of "(sotto voce)" arrives as three runs: "(", "sotto" (italic), " voce)".
function paragraphText(inner) {
  const runs = inner.match(/<Text[^>]*>([\s\S]*?)<\/Text>/g) || [];
  // Trim ONCE, after joining. Trimming each run first glued the words together
  // ("A " + "CAR DRIVER" + " waits" became "ACAR DRIVERwaits"), which destroyed
  // the extras/props extraction and then flowed verbatim into the prompts.
  return runs.map((r) => stripTags(r)).join("").replace(/\s+/g, " ").trim();
}

const STRUCTURAL_TYPES = new Set(["New Act", "End of Act"]);

// Final Draft's Character Arc tool nests a plain <Paragraph>...</Paragraph>
// (its own note-text formatting) INSIDE
// <SceneProperties><SceneArcBeats><CharacterArcBeat> for any scene with an arc
// beat tagged on it. The paragraph regex below is non-greedy, so on an
// arc-tagged scene it stops at the FIRST </Paragraph> it finds — that nested
// one — rather than the Scene Heading's own closing tag. The real heading
// <Text> (always AFTER </SceneProperties>) is left outside the match, the
// captured text comes out empty, and the heading gets silently dropped as a
// spacer paragraph. Caught on Fashion Heist S1E1 v2's real script: two Scene
// Headings ("A Secret Workshop - Day" and "Overlock's Hut - Night", both
// carrying a CharacterArcBeat) vanished from the scene list; every heading
// without an arc beat parsed fine. Fix: strip SceneProperties before the
// paragraph regex runs — its data (Length/Page/arc beats) isn't read by this
// parser anyway (pageEstimate comes from text length, not the Page attribute)
// — so there's no nested <Paragraph> left to confuse the match.
const SCENE_PROPERTIES_RX = /<SceneProperties[^>]*>[\s\S]*?<\/SceneProperties>/g;

export function parseFDX(xml) {
  const cleaned = xml.replace(SCENE_PROPERTIES_RX, "");
  const paraRx = /<Paragraph Type="([^"]+)"[^>]*>([\s\S]*?)<\/Paragraph>/g;
  const paras = [];
  let m;
  while ((m = paraRx.exec(cleaned))) {
    const text = paragraphText(m[2]);
    // A blank paragraph is the spacer Final Draft inserts and is noise — except
    // for a structural marker, which delimits an episode even with no text.
    // Dropping an empty "New Act" merged two episodes into one, and
    // sliceEpisode() then returned null for every episode after it.
    if (text || STRUCTURAL_TYPES.has(m[1])) paras.push({ type: m[1], text });
  }
  return buildFromParagraphs(paras);
}

// ---------- Fountain ----------

const FOUNTAIN_HEADING = /^\s*((?:INT|EXT|I\/E|INT\.?\/EXT)[.\s/].*)$/i;
const FOUNTAIN_TRANSITION = /^\s*(?:>\s*)?([A-Z][A-Z ]{2,}TO:|FADE (?:IN|OUT)[.:]?)\s*$/;
const FOUNTAIN_CHARACTER = /^\s{0,3}([A-Z][A-Z0-9'.\- ]{1,40}?)(\s*\([^)]*\))?\s*$/;
const FOUNTAIN_PAREN = /^\s*\(([^)]*)\)\s*$/;
const FOUNTAIN_ACT = /^\s*(?:#\s*)?(begin|start of)\s+(episode|act)\b/i;
const FOUNTAIN_END_ACT = /^\s*(?:#\s*)?(end(?:\s+of)?)\s+(episode|act)\b/i;

export function parseFountain(text) {
  const lines = (text || "").replace(/\r\n?/g, "\n").split("\n");
  const paras = [];
  let mode = null; // "character" primes the next non-blank line as Dialogue/Parenthetical
  for (let raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (!trimmed) { mode = null; continue; }

    if (FOUNTAIN_ACT.test(trimmed)) { paras.push({ type: "New Act", text: trimmed }); mode = null; continue; }
    if (FOUNTAIN_END_ACT.test(trimmed)) { paras.push({ type: "End of Act", text: trimmed }); mode = null; continue; }
    if (FOUNTAIN_HEADING.test(trimmed)) { paras.push({ type: "Scene Heading", text: trimmed }); mode = null; continue; }
    if (FOUNTAIN_TRANSITION.test(trimmed)) { paras.push({ type: "Transition", text: trimmed }); mode = null; continue; }

    if (mode === "character" && FOUNTAIN_PAREN.test(trimmed)) {
      paras.push({ type: "Parenthetical", text: trimmed });
      continue; // stay in character mode: dialogue still follows
    }
    if (mode === "character" || mode === "dialogue") {
      paras.push({ type: "Dialogue", text: trimmed });
      mode = "dialogue";
      continue;
    }
    // A line in ALL CAPS with no lowercase letters and no terminal punctuation
    // reads as a character cue — Fountain's own heuristic (optionally forced
    // with a leading "@").
    const forced = /^@/.test(trimmed);
    const bare = forced ? trimmed.slice(1) : trimmed;
    if (FOUNTAIN_CHARACTER.test(bare) && (forced || (bare === bare.toUpperCase() && !/[a-z]/.test(bare)))) {
      paras.push({ type: "Character", text: bare });
      mode = "character";
      continue;
    }
    paras.push({ type: "Action", text: trimmed });
    mode = null;
  }
  return buildFromParagraphs(paras);
}

// ---------- shared assembly ----------

function buildFromParagraphs(paras) {
  const scenes = [];
  const episodes = []; // [{ number, startIndex, endIndex }] over `scenes`
  const characterSet = new Map(); // key -> display
  let cur = null;
  let curEpisode = { number: 1, sceneStart: 0 };
  let pendingChar = null;
  let sceneNumber = 0;
  let pageEstimate = 0;

  const closeScene = () => { if (cur) { scenes.push(cur); cur = null; } };

  for (const p of paras) {
    pageEstimate += Math.max(1, p.text.length) / 500; // rough, for episode sizing only

    if (p.type === "New Act") {
      const n = extractNumber(p.text) || episodes.length + 2;
      closeScene();
      episodes.push({ ...curEpisode, sceneEnd: scenes.length });
      curEpisode = { number: n, sceneStart: scenes.length };
      continue;
    }
    if (p.type === "End of Act") {
      continue; // the following New Act (or EOF) closes the range
    }
    if (p.type === "Scene Heading") {
      closeScene();
      const { intext, loc, time, heading } = parseHeading(p.text);
      sceneNumber += 1;
      cur = newScene({ number: String(sceneNumber), heading, intext, loc, time, characters: [], props: [], pageStart: Math.round(pageEstimate) });
      cur._actionText = "";
      cur._lines = [p.text.toUpperCase()];
      continue;
    }
    if (!cur) {
      // Content before any scene heading (a cold open slug-less action, or a
      // pre-title sequence) still deserves a scene bucket.
      sceneNumber += 1;
      cur = newScene({ number: String(sceneNumber), heading: "(no slugline)", intext: "INT.", loc: "", time: "DAY" });
      cur._actionText = "";
      cur._lines = [];
    }
    // The scene's script as text, in screenplay order — what a shot
    // breakdown reads. Returned by the parser only; newScene() never stores it.
    if (p.type === "Character") cur._lines.push("", p.text.toUpperCase());
    else if (p.type === "Parenthetical" || p.type === "Dialogue") cur._lines.push(p.text);
    else if (p.type === "Action" || p.type === "Transition" || p.type === "Shot" || p.type === "General") cur._lines.push("", p.text);
    if (p.type === "Action") {
      if (!cur.synopsis) cur.synopsis = p.text.length > 220 ? `${p.text.slice(0, 217)}...` : p.text;
      cur._actionText += ` ${p.text}`;
    } else if (p.type === "Character") {
      const key = characterKey(p.text);
      if (key) {
        pendingChar = key;
        characterSet.set(key, characterSet.get(key) || characterDisplay(p.text));
        if (!cur.characters.includes(key)) cur.characters.push(key);
      }
    } else if (p.type === "Dialogue") {
      // dialogue content already attributed via pendingChar / cur.characters
    }
  }
  closeScene();
  episodes.push({ ...curEpisode, sceneEnd: scenes.length });

  // Pass 1: pull NAME (age) introductions into the character registry BEFORE
  // computing extras, so a character who is introduced in action but never
  // gets a Character cue in this scene (common for the scene they die in, or
  // a scene told from their POV) still counts as a character, not an extra.
  for (const s of scenes) {
    const intros = draftIntroductions(s._actionText || "");
    for (const [key, display] of intros) {
      if (!characterSet.has(key)) characterSet.set(key, display);
      if (!s.characters.includes(key)) s.characters.push(key);
    }
  }
  const charKeys = new Set(characterSet.keys());

  // Pass 2: extras (background roles) and the props draft, now that the full
  // character registry is known so extras never duplicate a character.
  for (const s of scenes) {
    const extras = draftExtras(s._actionText || "", charKeys);
    s.extras = [...extras.values()];
    s.props = draftProps(s._actionText || "");
    s.text = (s._lines || []).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    delete s._actionText;
    delete s._lines;
    s.characters = s.characters.map((k) => characterSet.get(k) || titleCase(k));
  }

  return {
    scenes,
    characters: [...characterSet.values()].sort(),
    locations: [...new Set(scenes.map((s) => s.loc).filter(Boolean))].sort(),
    episodes: episodes.filter((e) => e.sceneEnd > e.sceneStart),
    pageEstimate: Math.round(pageEstimate),
  };
}

// Slice one episode's scenes out of a combined multi-episode parse (Man in the
// Glass ships all ten episodes in one .fdx, bounded by New Act/End of Act
// markers with inconsistent numbering — "Begin episode three" as well as "4").
export function sliceEpisode(parsed, episodeNumber) {
  const ep = parsed.episodes.find((e) => e.number === episodeNumber);
  if (!ep) return null;
  const scenes = parsed.scenes.slice(ep.sceneStart, ep.sceneEnd);
  const charKeys = new Set();
  scenes.forEach((s) => s.characters.forEach((c) => charKeys.add(c)));
  return {
    number: episodeNumber,
    scenes,
    characters: [...charKeys].sort(),
    locations: [...new Set(scenes.map((s) => s.loc).filter(Boolean))].sort(),
  };
}

export function detectFormat(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "fdx") return "fdx";
  if (ext === "fountain") return "fountain";
  return "fountain"; // .txt / .md default to Fountain's plain-text conventions
}

export function parseScreenplay(text, filename) {
  const fmt = detectFormat(filename || "");
  return fmt === "fdx" ? parseFDX(text) : parseFountain(text);
}
