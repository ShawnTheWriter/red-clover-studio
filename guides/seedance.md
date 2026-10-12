# Seedance 2.5 / 2.0 Fast (ByteDance, on fal) — how to prompt it

Condensed from fal's "Seedance 2.5 Workflows" guide (fal.ai/learn/tools/seedance-2-5-workflows,
read 2026-10-09) and fal's Seedance 2.5 prompt examples. Seedance 2.0 Fast follows the same
conventions at lower cost and quality. No prompt expansion step: what you write is what the model
reads.

## How the request runs
- Image-to-video: `image_url` is frame one; `end_image_url` (optional) is where the clip lands.
- Picture and sound are generated together. Output is 480p or 720p, 24 fps; 2.5 runs 4-30 s.
- The model reasons over the whole clip at once, so the prompt has to carry the whole clip.

## What to write (image-to-video)
- Split the prompt in two: the MOTION (what happens, in order) and the PROTECTION (what the still
  already got right and must stay: "Hold her exact face, coat and the lamp light from the still,
  and keep the camera over her shoulder throughout").
- With an end frame, do not describe the end state — the frame already shows it. Describe the
  ORDER of change between the two frames (what moves first, what last).
- Build an end frame by editing the start frame (same room, same lens), never as a fresh image:
  two separately generated rooms disagree and the model has to reconcile them mid-clip.
- Order for a single continuous shot: camera, subject, action, environment, look, sound.
- Longer clips (8 s+): write consecutive stages ("Stage 1: … Ends with …. Stage 2: …"), one
  primary change per stage, and name what is on screen when each stage ends. Timestamp ranges
  ("0 to 5s", "5 to 12s") set proportion and pacing, not frame-exact hits.
- Dialogue: the exact line in double quotes — that is what triggers lip-synced speech. Put the
  delivery before it: `says through his teeth: "Not tonight."`
- Sound: concrete sources (gravel, rain on glass, a hatch slamming). "No music" when none.
- Close with "No on-screen text, no subtitles." when text must not appear.
- Bracketed fields (【Style】, 【Action】, 【Camera】, 【Audio】) are useful when the look matters:
  the style line can be rewritten without touching the action.

## Reference mode (bytedance/seedance-2.5/reference-to-video)
- Inputs are addressed by position in the prompt: @Image1, @Image2 …, @Video1, @Audio1.
- Give each reference a role ("the pilot from @Image1", "the barge from @Image2") and say what
  holds from it ("Hold his exact build from @Image1").
- fal warns it rejects many realistic human faces (Red Clover saw 422 "likenesses of real
  people" on some runs, not billed).

## What goes wrong (Red Clover tests)
- The early Seedance 2.5 take in S1E1 cost $2.33 for 5 s at 720p — use 480p drafts to check a
  shot before paying for 720p.
- Same people-and-doors cautions as every model: describe people by appearance and position, say
  which way a door swings.
