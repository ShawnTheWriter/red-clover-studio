# Model prompting guides

One file per prompt style. A video model's row in `server/rates.js` names its style with
`promptStyle`; "Draft this prompt with Claude" sends that guide (or `generic.md` when a model has
none) and the H3-family auto-built prompt follows `fal-brief.md`.

| File | Models | Sources (read) |
|---|---|---|
| fal-brief.md | MiniMax H3 Max, MiniMax H3 (fal) | fal.ai/learn/tools/how-to-use-minimax-h3-max (2026-10-09) |
| seedance.md | Seedance 2.5 (frames, references), Seedance 2.0 Fast | fal.ai/learn/tools/seedance-2-5-workflows (2026-10-09) |
| kling.md | Kling v3 Standard | blog.fal.ai/kling-3-0-prompting-guide; kling.ai VIDEO 3.0 model guide; fal endpoint page (2026-10-09) |
| generic.md | anything without a guide (Wan 3.0 until its driver exists) | Red Clover's own tests |

Rules for writing these: the provider's own guide wins over third-party blogs; write in our own
words (no long quotes); add what Red Clover's real takes taught us under "What goes wrong"; date
every source so a later session knows when to re-check. Re-read a model's guide when its endpoint
or version changes.
