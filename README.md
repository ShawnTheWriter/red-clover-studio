# Red Clover Studio

**A free production studio for AI films and microdramas that runs on your own computer.**
Script in, finished cut out: cast and locations, storyboards, video takes, a playable rough cut,
sound, and a timeline you can finish in DaVinci Resolve.

<!-- DEMO VIDEO: replace with the promo clip once it exists -->

> **Alpha.** Built for one filmmaker's real production and now shared. It works, it's tested
> (600+ automated checks), and it has rough edges. macOS is the only system tested so far.

## What it does

**Pre-production — the Vault**
- Upload a screenplay (.fdx, .fountain or .txt). Scenes, characters and props are read from it.
- One card per character, location and prop, with every angle and outfit you add. An *identity
  hold* per card keeps a face or a set the same from shot to shot.
- Series vault: cards, style and settings carry across every episode of a series.
- Optional Claude helpers draft shot lists, identity holds and prompts. You always edit and
  approve; nothing is applied on its own.

**Production — the board**
- A contact sheet of every shot, scene by scene. Drag to reorder shots and scenes.
- Storyboards per shot (generate, upload or pull a frame from a clip), reference images, and an
  optional reference video (Blender previs, grey-box, an earlier take) to steer the camera.
- Pick a video model with short rows of choices: model, mode, tier, quality, service. Each
  choice shows its price per second.
- The prompt you see is exactly the prompt that's sent.

**Post-production**
- A playable rough cut of the whole episode, with storyboards holding the place of shots not
  yet made. Trim any take and the cut follows.
- Dialogue (your own voice performances turned into character voices), sound effects, room tone,
  lip sync.
- Export to DaVinci Resolve (FCPXML, with scene bins), OpenTimelineIO or a CapCut-ready folder.
- Bring your Resolve edit back in: organise the files to match it, or start a higher-quality
  *remaster* of the cut.

## What it costs

The app is free. Video, images, voices and the Claude helpers come from services you connect
with your own API keys, and you pay them directly. The app never marks up a price.

- **Every paid action shows its price first**, and anything over your threshold asks you to
  confirm the exact amount.
- **A spending cap per episode** that the app enforces.
- A cost record of every take, and a price watch that tells you when a model you use gets cheaper.

## Install

You need **macOS**, **[Node.js 22 or newer](https://nodejs.org)** and
**[ffmpeg](https://ffmpeg.org)** (`brew install ffmpeg`).

```bash
git clone https://github.com/<you>/red-clover-studio.git
cd red-clover-studio
npm install
npm start
```

`npm start` opens the app in your browser at http://localhost:8099.

**On first run** the app asks where your projects should live: any folder, including one inside
Dropbox, Google Drive or iCloud. Then open **⚙︎ → Connections** and add the keys for the services
you want. Keys are saved on your computer only, in the app's `.env` file, and the app only ever
shows their last four characters.

## Services

| Service | What it powers | Needed? |
|---|---|---|
| [fal](https://fal.ai) | Video (MiniMax H3 / H3 Max, Seedance 2.5 / 2.0, Kling, Wan), GPT Image, lip sync, sound effects | For video, yes |
| [Atlas Cloud](https://www.atlascloud.ai) | Seedance 2.5 at Atlas's prices | Optional |
| [Google Gemini](https://aistudio.google.com/apikey) | Storyboard and vault images (Nano Banana) | Recommended |
| [ElevenLabs](https://elevenlabs.io) | Character voices | Optional |
| [Anthropic](https://console.anthropic.com) or [OpenRouter](https://openrouter.ai) | Claude helpers (shot lists, holds, prompts) | Optional |

Without any keys you can still write, board with your own images, import clips you already have,
cut and export.

## Your files

Everything is plain folders and files you can open, back up or sync:

```
<projects folder>/<Series>/             series.json, series bible
<projects folder>/<Series>/<Episode>/   studio.json + 00_script … 05_delivery
```

Every edit can be undone (⌘Z). Undo never discards a take you paid for.

## DaVinci Resolve

Export the timeline as FCPXML into Resolve. The app also writes a Resolve script, found under
Workspace → Scripts, that sorts the media into scene bins. To bring an edit back, export your
Resolve timeline as FCPXML into the episode folder and use Post-production → From Resolve, or
Library → + Remaster from a Resolve cut.

## Status and known gaps

- Tested on macOS with Chrome. Windows and Linux: untested.
- Some prices are estimates until a real bill comes back; those are marked "~" in the app.
- Modules (reusable shot recipes, previz and looks, shareable with other creators) have their
  places in the app but are not built yet.

## For developers

`npm test` runs every suite. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers the architecture,
data model and history. The only runtime dependency is the Anthropic SDK; there is no build step.

## Licence

MIT — see [LICENSE](LICENSE). The sample project's story, characters and media are © Shawn Whitney
and are included for trying the app, not for reuse.

---

Made by Shawn Whitney for Red Clover Studios, built with [Claude Code](https://claude.com/claude-code).
