# MiniMax H3 Max and H3 (fal) — how to prompt them

Condensed from fal's own guide, "How To Use MiniMax H3 Max" (fal.ai/learn/tools/how-to-use-minimax-h3-max,
read 2026-10-09), plus Red Clover's own test results. H3 Max is fal's post-trained version of
MiniMax H3; fal's guidance wins over MiniMax's base-model guide. The same shape is used for base
H3 on fal (`minimax/h3/image-to-video`), whose prompt expansion is also on by default.

## How the request runs
- Prompt expansion is ON ("balanced"): fal rewrites the brief into the model's internal form before
  generating. Write plain, precise English — not tags or JSON.
- Image-to-video: the start frame is frame one; an end frame pins the last frame. The output keeps
  the frame's aspect ratio.

## What to write
- One or two sentences of picture, then the sound. Specific nouns and verbs beat piles of adjectives.
- Describe the MOTION from the start frame to the end frame — what moves, which way, how far.
- Say what must stay untouched: "Hold the framing, the light and the setting exactly as they are in
  the start frame." Name the camera: "keep the camera locked off throughout", or the one move wanted.
  For a person in close-up, a very slight push-in keeps it from reading as a photo with motion
  painted on.
- Dialogue: the exact line in double quotes, with a delivery direction before it:
  `the woman inside says, resigned and tired: "What do YOU want?"`
- Sound: concrete sources the audio pass can render ("the heavy door groaning on its iron hinges",
  "a pen moving on paper"), not moods. Only sounds that belong to the scene.
- Close with "No music, no on-screen text." unless music is wanted (then "No on-screen text.").
- Timed beats ("0.0 to 2.0s: …") only when a moment must land on a mark; they must add up to the
  clip length.

## What goes wrong (Red Clover tests, 2026-10-08/09)
- Character names mean nothing to the model and invite invented dialogue. Describe people by what is
  visible and where they are in frame.
- Doors: the model assumes doors open inward. Say which way the door swings and who pulls or pushes.
- Weather or atmosphere words in the sound line (wind, rain) can appear as visible mist or smoke.
- With a start frame only, the model may redesign the set; an end frame holds the location.
- The model stretches the action to fill the requested length: a long clip with one line delivers
  it late. Keep clip length close to what the shot needs.
- Raw quoted text with expansion OFF came back as burned-in subtitles (expansion is now on).
