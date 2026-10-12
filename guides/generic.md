# Image-to-video models — general prompting (no model-specific guide yet)

Used for every video model that has no guide of its own. Red Clover findings that hold across the
models tried so far (MiniMax H3, Seedance 2.0 Fast / 2.5, Kling v3):

- The start frame carries identity, wardrobe, set and light. The prompt carries MOTION: what moves,
  which way, how far, and what the camera does. Do not re-describe the still.
- One clear action per clip. A second action or a change of place belongs in another shot.
- Name the camera explicitly: "locked-off camera" when it should not move, otherwise the one move.
- Refer to people by what is visible and where they are in frame, not by character name.
- Say which way things move when it matters (doors, turns, entrances); models default to the common
  case (doors open inward).
- Dialogue: the exact line in double quotes with a short delivery note. Keep lines short enough to
  say in the clip's length.
- Sound: concrete, scene-appropriate sources. Avoid weather words unless the weather should show.
- Say "no music" and "no on-screen text" when those are not wanted; keep these to one closing line.
- When the shot has an end frame, describe the motion that connects the two frames rather than
  either frame on its own.
