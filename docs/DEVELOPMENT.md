# Red Clover Studio

Local production desk for Red Clover Studios, covering development through
post-production. Successor to the single-file `Red Clover Production Desk.html`.

```bash
npm start          # http://localhost:8099
npm test           # v1/v2 prompt parity
```

No dependencies, no build step, no bundler. Node 22+.

## How it is wired

Code lives here, outside Google Drive. **Data lives in the Drive project folder**,
alongside the assets, and the `red-clover-studios` Claude skill reads and writes the
same files. That shared tree is the integration between Claude and the app.

```
<project root>/<Series>/                series.json + a bible markdown (canon)
<project root>/<Series>/<Episode>/      studio.json + the 00_..05_ scaffold
<project root>/<Production>/            studio.json, standalone
```

Project root defaults to the Drive folder; override with `RCS_PROJECT_ROOT`.

## Configuration

Copy `.env.example` to `.env`. Keys are read server-side only and are never sent to
the browser — this replaces the v1 desk's browser-held Anthropic key.

## Schema v2

`Series -> Episode -> Scene -> Shot -> Beat`.

The v1 desk stored one camera move, one dialogue line and one audio block **per
shot**, which forced the timecoded script to hang dialogue and SFX on the last beat.
v2 pushes those onto the beat and keeps the shot value as an inherited default.

A beat carries a `keyframe` flag. v1 kept two granularities that mattered: keyframe
stills (start / mid / end) and narrative beats inside a single generation. One list
plus one flag preserves both — a shot can have one still and three timing beats.

`shared/schema.js` migrates v1 exports of either shape (the full `{cur, prods}`
database, or a bare production object) without loss.

## Prompt parity

`shared/prompts.js` is a port, not a rewrite. The wording was tuned against real
generations: the ABSOLUTE-anchor reference line, the negative block kept separate
from the shot lines, subject-agnostic size labels.

`npm test` runs the v1 builders (copied verbatim from the old HTML) against the v2
builders on migrated fixtures and fails on any difference. Treat a diff as a craft
regression, not a refactor detail.

## Layout

```
shared/     grammar.js   controlled vocabulary, naming, duration estimates
            schema.js    v2 model, constructors, v1 migration
            prompts.js   Nano Banana / GPT / video JSON / Seedance timecode
server/     index.js     routes
            http.js      zero-dependency router, Range support for video
            store.js     file-backed store, atomic writes, path confinement
            thumbs.js    sips thumbnail cache, kept out of Drive
web/        app.js       the desk
test/       parity.mjs   v1 vs v2 prompt output
```

## Screenplay ingestion (Phase 1)

`shared/screenplay.js` parses Final Draft (.fdx) and Fountain (.fountain/.txt/.md)
into scenes. Tuned against the real scripts, not synthetic fixtures — Final Draft
output is messy (mixed-case sluglines, spelled-out act numbers, blank spacer
paragraphs) and both extractors handle it.

Props extraction is deliberately narrow: quoted phrases only. Checked what
ALL-CAPS actually marks in Shawn's two real scripts before writing anything —
it marks character introductions and background roles, never a prop, in either
script. A capitalization-based prop guesser would have been near-100% noise. A
scene's `extras` field (named, non-speaking roles like "CAR DRIVER") exists
because the data surfaced a real category the schema didn't have room for.

`shared/audit.js` is the new-asset audit from `series-pm.md`: diff an episode's
scenes against the series registry, report standing vs new. `shared/gates.js`
enforces the G0–G5 stage gates in code — G4 cannot be entered while G3 is
unmet, encoding series-pm.md's "never generate video before boards are
approved" as a real check, not just a doc.

## Pre-production (Phase 2)

The Identity Vault has a write path now. New assets get an auto-filled
identity-hold prompt using the exact wording that survived the Arm B
continuity test. The promote flow matches how Shawn actually generates
images: Nano Banana writes to `generated_imgs/`, a sibling of the project
root, and a keeper gets copied into `02_assets/` and linked to an asset
record — one narrow, explicit exception to the normal path confinement
(read/copy only, filenames only, never a path).

`shared/blocking.js` is a 2D top-down stage per shot — click a character or
camera chip, click the canvas to place it — and the 180-degree line check:
for consecutive shots in a scene sharing two blocked characters, the axis is
the line through those characters' positions in the earlier shot, and the
later shot's camera is tested against it. `shared/` is now served read-only
to the browser (`server/http.js` static mounts) so the UI imports the exact
modules the server runs, not a copy that can drift — same discipline the
parity test enforces for prompts.

The board panel is what actually feeds gate G3: every keyframe beat, its
current frame, an Approve toggle, and two ways to set the image (promote from
the inbox, or link an existing `03_storyboard/` file).

## Production and cost control (Phase 3)

**fal bills different models in different units, and most cannot be predicted
before a run.** Per fal's own pricing API: MiniMax H3 is billed per *compute
second*, Seedance 2.5 per *1000 tokens*, Kling v3 per *video second*. Only the
last converts to a pre-flight estimate, so a cap built on fal's pricing API
could not stop a spend before it happened.

`server/rates.js` therefore holds a `$/video-second` per model with its
provenance: `exact` (fal bills that way), `measured` (from a real run), or
`uncalibrated` — a deliberately high ceiling so the cap blocks rather than
overspends. Fix rates there when a real run reports drift; it is the single
place cost lives.

Three guards run on the submit path, not in the UI:

1. **Hard cap** — the estimate must fit the episode's remaining budget.
2. **Confirmation** — a batch over the threshold must echo back the exact
   total the client displayed. The server recomputes and rejects a mismatch,
   so a UI that under-displays cost cannot get a larger spend approved.
3. **In-flight accounting** — queued and running work counts as committed, so
   several fan-outs fired in quick succession cannot collectively exceed the
   cap.

`npm run test:budget` verifies all of it against a mock driver that has fal's
async shape. Those tests caught a real lost-update race in the store; every
read-modify-write now goes through `store.withEpisode()`, a per-episode write
lock.

Video generation requires an approved board frame, enforced server-side.
Text-to-video is deliberately not exposed — the run that proved the keyframe
method also proved fixed-seed text-to-video does not hold identity.

## Post-production (Phase 4)

`server/timeline.js` rebuilds the picture track from each shot's selected
take, measuring every clip with a real ffprobe wrapper — never a requested
duration. That distinction mattered immediately: a "5 second" H3 request
measured 5.184s on the actual file. Ramp-up trim (house-style.md's edit
handoff notes) is per-clip head/tail trim in seconds, clamped server-side to
the real measured duration and always confirmed by eye, never applied
blindly.

Three exports, one shared frame-quantization module (`server/export/
timeutil.js`) so they can never disagree about where a cut falls:

- **FCPXML 1.10** for DaVinci Resolve, checked for well-formedness with
  `xmllint` (real libxml2 parser).
- **OpenTimelineIO**, round-tripped through the actual `opentimelineio`
  Python package (`.otio-venv/`, gitignored — set up with
  `python3 -m venv .otio-venv && .otio-venv/bin/pip install opentimelineio`).
  Worth having: my first schema guess for `Clip.2` was wrong, and the real
  library caught it immediately.
- **CapCut fallback** — clips copied in cut order plus a markdown edit sheet
  with dialogue/SFX/music cues pulled from the real beat data, since
  CapCut's own import formats are restrictive.

Gate G5 now requires an actual export on record, not just a selected take —
enforced, not just documented, matching G3/G4.

**A real bug worth knowing about:** episode loading used to skip re-applying
schema defaults once `schemaVersion` already matched, so a field added to
`newEpisode()` after episodes existed on disk was silently `undefined` on
every one of them. Fixed, and locked in as a permanent regression test in
`test/parity.mjs` — the next field that gets added should fail loudly there,
not get discovered by chance.

## Independent review (post-Phase-4)

An `/code-review ultra` pass across the whole repo found real defects the
83-check suite had missed — an unlocked-write race, a schema-version
shredder, a confirmation echo-back bypassed by a non-numeric value, a mock
driver charging real money, and a process crash on ordinary video playback.
15 fixed and re-verified by that session; a follow-up pass in this repo's own
session found and closed 4 more (a lock-key normalization gap, a gate-log
origin bug, fal's unknown-status fallthrough, and the most consequential — a
timing window where a finished job's ledger charge lagged its terminal state
by two separate lock acquisitions, closed by folding both into one atomic
write in `server/jobs.js`'s `settle()`).

Also corrected along the way: the test-count arithmetic in earlier reports
(including this file's own) double-counted `parity.mjs`'s interim subtotal.
Real counts: 65 before that review, 74 now — see `git log` for the two
commits with full detail on each fix and how it was verified.

## Hands-on round with Shawn (Sept 2026)

Built from real use of Fashion Heist S1E1 v2 — details and rationale in `git log` and in
the skill's `reference/production-desk-app.md`:

- **Launcher**: Dock app hands startup to Terminal (Drive EPERM fix); root read errors
  shown in the Library instead of an empty list.
- **Storyboard board**: grouped by scene; inline-editable names/descriptions; add/move/
  delete individual storyboards; shot reorder (↑/↓), add before/after, delete (first row
  only); "Earlier versions" picker over the whole series folder; frame-from-video.
- **Audit**: thumbnails of matching asset images.
- **Undo**: snapshots in `<episode>/.history/`, Cmd+Z; never touches money or paid takes.
- **Takes**: import existing clips (project or upload, up to 1 GB), move a take to another
  shot or split it into a new shot.
- **Prompts**: one video prompt per shot (Shot direction | Timecoded), and it is exactly
  what Generate sends; image prompts live only in the storyboard picker.
- **Stability**: no more page stutter while a take generates; open shots stay open.

## Status

All four phases complete: foundation, development, pre-production,
production, and post-production. One independent review pass applied. Foundation, schema v2, migration, prompt parity,
screenplay ingestion, gate tracker, new-asset audit, Identity Vault (read and
write), 2D blocking with the 180° check, board approval feeding G3, the driver
system, job queue, multi-model fan-out with a version tray, the cost ledger,
the timeline, and FCPXML/OTIO/CapCut export.



**One thing left unverified:** a live DaVinci Resolve import. The exported
FCPXML is machine-checked valid (xmllint) and internally consistent (frame
math verified against the OTIO export of the same timeline), but an actual
File > Import Timeline in Resolve has not been visually confirmed — Resolve's
first-run setup (GPU processing mode, license prompts) needs a one-time human
pass before that's safe to automate.
