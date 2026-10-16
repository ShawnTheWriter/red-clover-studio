// Cost rates — the single source of truth for what a generation costs, and the
// only thing the budget cap can act on.
//
// THE PROBLEM THIS FILE EXISTS TO SOLVE: fal bills different models in
// different units, and most of them cannot be predicted before the run.
// fal's own pricing API (checked 2026-09-27, `get_pricing`) reports:
//
//   minimax/h3/image-to-video          $0.05  per COMPUTE SECOND
//   alibaba/wan-3.0/image-to-video     $0.05  per (unspecified) SECOND
//   bytedance/seedance-2.5/image-to-video      $0.0214 per 1000 TOKENS
//   bytedance/seedance-2.0/fast/image-to-video $0.0112 per 1000 TOKENS
//   fal-ai/kling-video/v3/standard/…   $0.14  per VIDEO SECOND
//
// Only the last of those can be turned into a pre-flight estimate directly —
// it's the one model billed in the same unit a filmmaker plans in. Compute
// seconds and tokens are known only after the fact, and COMPUTE seconds are
// NOT video seconds: a diffusion video model's compute time scales with its
// own real-time factor, not 1:1 with output duration. The Sept 2026 lesson
// (see MiniMax H3 below) is that treating "$X per compute-second" as if it
// were "$X per video-second" silently understates cost by whatever that
// factor turns out to be — and the only way to find it is a real invoice,
// not fal's pricing API. Wan 3.0 is reported in the same bare "seconds" unit
// with no model-specific breakdown, so it likely hides the same trap; treat
// its ceiling as unverified until a real run's actual comes back, the same
// way MiniMax's needed correcting.
//
// Every model also carries `imageParams`: the fal input field name(s) for the
// reference image(s) it accepts, in order — first = start/opening frame,
// last = end/closing frame. Checked against each model's live fal schema on
// 2026-09-25 (re-checked 2026-09-27 alongside `durations` below): all five
// take exactly two (a start frame and an end frame); none accept a third
// "middle" frame. A shot's approved keyframe beats beyond that count still
// matter for planning/continuity, but the video model never sees them — the
// storyboard and Generate-video UI warn instead of silently dropping them.
// `imageParams.length` is what those warnings read, so a future model with
// more (or fewer) slots just needs its own array here.
//
// Instead every model carries a `usdPerVideoSecond` — the one unit a filmmaker
// actually plans in — with its provenance and how much to trust it:
//
//   exact         — fal bills per video second; this number is authoritative.
//   measured      — derived from a real run of Shawn's, recorded in memory.
//   uncalibrated  — a deliberately HIGH ceiling. Not a guess at the real price,
//                   a number chosen so the cap blocks rather than overspends.
//                   Replace it the first time a real run reports an actual.
//
// When a run reports an actual cost, jobs.js records it and flags drift from
// the estimate. Correct the numbers HERE when that happens — the way
// tool-registry.md is the skill's single place to fix a changed price.

// [a, a+1, ..., b] — every model below only ever sells whole-second takes, so
// the billable-duration menu (billableSeconds() in jobs.js) is just every
// integer the model's own fal schema allows. Never trim this to a couple of
// "common" values by hand again: that's exactly how MiniMax H3 ended up
// locked to 5 or 10 seconds when fal actually accepts 5-15 (Sept 2026 — Shawn
// wanted a longer take and the app had no way to ask for one).
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// `inputMode`: "frames" (default — start + optional end image, see imageParams)
// or "reference" (many images addressed as @Image1…, see shared/prompts.js
// resolveReferenceSet). Reference models have no imageParams.
// End of fal's H3 Max promotional price (model page, read 2026-10-09: "ends
// October 15"). Taken as the end of that day, UTC.
export const H3MAX_PROMO_ENDS = Date.parse("2026-10-16T00:00:00Z");

export const VIDEO_MODELS = [
  {
    id: "minimax/h3/image-to-video",
    promptStyle: "fal-brief", // guides/fal-brief.md; fal's default prompt expansion is on for this endpoint too
    short: "H3", // model code in take file names
    label: "MiniMax H3",
    usdPerVideoSecond: 0.13,
    confidence: "measured",
    falUnit: "compute seconds",
    // Billed at $0.05/compute-second (fal's pricing API), but compute
    // seconds are NOT video seconds for a diffusion model — real invoices
    // (fal usage dashboard, 2026-09-27) show 13 compute-seconds for a 5s
    // take and 26 for a 10s take: a fixed 2.6x compute-to-video ratio, i.e.
    // $0.65 for 5s and $1.30 for 10s exactly. 0.13 = 0.05 x 2.6. The
    // earlier $0.05/video-second figure came from a single remembered
    // total (~$1.50 / 30s from the 2026-09-10 continuity test) that assumed
    // a 1:1 compute-to-video ratio — wrong by exactly this factor.
    note: "The proven path. Generates its own synchronised audio.",
    proven: true,
    durations: range(5, 15), // fal schema: duration is an integer, 5-15
    minDuration: 5,
    imageParams: ["image_url", "end_image_url"],
  },
  {
    id: "minimax/h3-max/image-to-video",
    short: "H3Max768", // model code in take file names
    label: "MiniMax H3 Max (768P)",
    // Calibrated 2026-10-08 from 30 earlier runs (fal request history vs the
    // usage CSV): 1.6 billed seconds per video second at 768P (1.0 at 480P,
    // 3.2 at 1080P). Priced at list ($0.05) at first, but the 2026-10-08 usage
    // CSV bills three remaster takes at a plain $0.03 per billed second (no
    // discount flagged): 2a 6 s = $0.288, 1a 4 s = $0.192 twice. 1.6 x 0.03.
    // fal's model page (2026-10-09): that $0.048 is a promo ending Oct 15;
    // list is $0.08. A getter, so quotes switch on the day without a deploy.
    get usdPerVideoSecond() { return Date.now() < H3MAX_PROMO_ENDS ? 0.048 : 0.08; },
    confidence: "measured",
    falUnit: "seconds (1.6 per video second at 768P)",
    note: "Post-trained H3: better prompt adherence and look. Same start/end frames. 768P; upscale later.",
    // fal's H3 Max guide: leave expansion on "balanced". It rewrites the
    // brief into H3's own form (quoted dialogue → speech). With it disabled,
    // quoted lines came back as burned-in subtitles (remaster 5b, 2026-10-09).
    // fal returns the rewrite as expanded_prompt; jobs.js keeps it on the take.
    fixedParams: { resolution: "768P", prompt_expansion_mode: "balanced" },
    // Prompts for this row follow fal's H3 Max guide (shared/prompts.js
    // buildFalBrief), not the generic shot direction.
    promptStyle: "fal-brief",
    durationAsNumber: true,
    durations: range(2, 15), // schema: number 0.92-15; whole seconds here
    minDuration: 2,
    imageParams: ["image_url", "end_image_url"],
  },
  {
    // H3 Max with references (Shawn's test 2026-10-10, remaster 5b run 6):
    // the start/end storyboards still pin the first and last frame, and the
    // shot's Identity Vault images (every angle of each referenced character:
    // turnaround + face close-ups, plus locations/props) go as "Image 1…9".
    // Held the framing, landed on the end frame and matched the faces far
    // better than plain image-to-video. Reference images are billed in tokens
    // (w x h / 1024 each, first 4,096 free, $0.02 per 1,000) on top of the
    // per-second price; images are sent at <=1280 px so 9 cost under ~$0.10.
    id: "minimax/h3-max/reference-to-video",
    short: "H3MaxRef768", // model code in take file names
    label: "MiniMax H3 Max — references (768P)",
    inputMode: "frames+refs",
    maxRefs: 9,
    maxRefAspect: 2.5,
    promptStyle: "fal-brief", // guides/fal-brief.md
    // $0.05 per billing second x 1.6 per video second at 768P (fal pricing
    // API on Shawn's account, 2026-10-12). The promo that makes plain H3 Max
    // $0.048 does NOT apply to the references endpoint.
    usdPerVideoSecond: 0.08,
    refUSDPer1kTokens: 0.02,
    refFreeTokens: 4096,
    confidence: "exact",
    falUnit: "seconds (1.6 per video second at 768P) + reference tokens",
    note: "Start/end storyboards + the shot's Identity Vault images (turnarounds, face close-ups, location). Best face match so far.",
    // Motion references (fal schema 2026-10-12: reference_video_urls, max 3,
    // 2–15 s each, 15 s combined, 12 files in all with the images). Cost per
    // second of reference video estimated from Shawn's 5b run (2026-10-09:
    // ~$0.94 for 5.17 s of reference video plus ~$0.25 of output).
    refVideo: { param: "reference_video_urls", max: 3, minSec: 2, maxSec: 15, totalSec: 15, usdPerSec: 0.14, confidence: "estimated" },
    fixedParams: { resolution: "768P", prompt_expansion_mode: "balanced" },
    durationAsNumber: true,
    durations: range(2, 15),
    minDuration: 2,
    imageParams: ["image_url", "end_image_url"],
  },
  {
    id: "fal-ai/kling-video/v3/standard/image-to-video",
    promptStyle: "kling", // guides/kling.md (Claude drafts)
    short: "Kling3", // model code in take file names
    label: "Kling v3 Standard",
    usdPerVideoSecond: 0.14,
    confidence: "exact",
    falUnit: "seconds",
    note: "Native audio, strong EN/ZH lip-sync. Billed per video second.",
    durations: range(5, 15), // fal schema: duration enum "3".."15"; floor kept at 5
    minDuration: 5,
    imageParams: ["start_image_url", "end_image_url"],
  },
  {
    id: "bytedance/seedance-2.5/image-to-video",
    promptStyle: "seedance", // guides/seedance.md (Claude drafts)
    short: "SD25", // model code in take file names
    label: "Seedance 2.5",
    usdPerVideoSecond: 0.466,
    confidence: "measured",
    falUnit: "1000 tokens",
    // Corrected 2026-09-29 from 0.20, then confirmed by Shawn's own fal usage:
    // a 5s take cost about $2.33 = $0.466/s (formula below predicts $0.462/s,
    // within 1%). One data point at the 720p default, so 1080p (2.25x) and
    // other resolutions are still unmeasured. fal bills $0.0214 per 1000 video tokens,
    // tokens = height x width x fps x duration / 1024 (fal's own Seedance
    // docs). At 720p/24fps that is 21,600 tokens per second = $0.462/s. The
    // same formula reproduces fal's published Seedance 2.0 Fast price exactly
    // ($0.0112/1k -> $0.2419/s at 720p), which is why it is trusted here. The
    // old 0.20 was a guess and under-reserved the cap by about 2.3x.
    note: "Token-billed: ~$0.47/s at 720p (measured on a real 5s take: $2.33); 1080p is 2.25x. Native 30s takes.",
    durations: range(5, 30), // fal schema: duration enum "auto","4".."30"; floor kept at 5
    minDuration: 5,
    imageParams: ["image_url", "end_image_url"],
  },
  {
    id: "bytedance/seedance-2.0/fast/image-to-video",
    promptStyle: "seedance", // guides/seedance.md (Claude drafts)
    short: "SD20F", // model code in take file names
    label: "Seedance 2.0 Fast",
    usdPerVideoSecond: 0.244,
    confidence: "measured",
    falUnit: "1000 tokens",
    // Corrected 2026-09-29 from 0.12: $0.0112/1k tokens x 21,600 tokens/s
    // (720p, 24fps) = $0.2419/s. Measured 2026-10-08 (usage CSV, remaster 5a,
    // 5 s): 108.9k tokens = $1.21968, i.e. 21,780 tokens/s = $0.244/s.
    note: "Token-billed (~$0.24/s at 720p). Lower-latency, lower-cost tier.",
    durations: range(5, 15), // fal schema: duration enum "auto","4".."15"; floor kept at 5
    minDuration: 5,
    imageParams: ["image_url", "end_image_url"],
  },
  {
    id: "bytedance/seedance-2.5/reference-to-video",
    short: "SD25ref", // model code in take file names
    label: "Seedance 2.5 — references",
    // Motion references (fal schema 2026-10-12: video_urls, max 10, 1.8–30.2 s
    // each, 30.2 s combined, 24–60 fps). Costed like output tokens at 720p
    // (1280 x 720 x 24 / 1024 tokens/s x $0.0214/1k = ~$0.46/s), a ceiling.
    refVideo: { param: "video_urls", max: 10, minSec: 1.8, maxSec: 30.2, totalSec: 30.2, usdPerSec: 0.46, confidence: "estimated" },
    inputMode: "reference",
    // Same token rate as Seedance 2.5 image-to-video (fal pricing API,
    // 2026-09-29: $0.0214 per 1000 tokens), i.e. ~$0.47/s at 720p —
    // priced at 0.50 to leave room for input tokens if fal counts reference
    // media. Reference IMAGES are the only inputs this app sends (no video or
    // audio references yet). Uncalibrated until a real invoice comes back.
    usdPerVideoSecond: 0.50,
    confidence: "uncalibrated",
    falUnit: "1000 tokens",
    note: "Sends ALL approved storyboards + the shot's assets as @Image references (up to 12), not just start/end. fal warns it rejects many human-face image inputs.",
    durations: range(5, 30), // fal schema: duration enum "auto","4".."30"; floor kept at 5
    minDuration: 5,
  },
  {
    // Same endpoint as the reference model above, called with fal's `draft: true`
    // (a 480p preview). It is its own row so it gets its own price, label and
    // ledger line: `endpoint` is the real fal path, `fixedParams` are merged
    // into the request. Cost by fal's token formula at 480p/24fps:
    // 480 x 854 x 24 / 1024 = 9,607 tokens/s x $0.0214/1k = ~$0.206/s (ceiling
    // 0.23). NOT built: completing a draft at 1080p — fal's docs give a
    // `draft_id` output and "complete within seven days" but no input field or
    // price for doing it, so a good draft is re-run normally instead.
    id: "bytedance/seedance-2.5/reference-to-video:draft480",
    short: "SD25ref480", // model code in take file names
    label: "Seedance 2.5 — references (480p draft)",
    // Motion references (fal schema 2026-10-12: video_urls, max 10, 1.8–30.2 s
    // each, 30.2 s combined, 24–60 fps). Costed like output tokens at 720p
    // (1280 x 720 x 24 / 1024 tokens/s x $0.0214/1k = ~$0.46/s), a ceiling.
    refVideo: { param: "video_urls", max: 10, minSec: 1.8, maxSec: 30.2, totalSec: 30.2, usdPerSec: 0.46, confidence: "estimated" },
    endpoint: "bytedance/seedance-2.5/reference-to-video",
    fixedParams: { draft: true, resolution: "480p" },
    inputMode: "reference",
    usdPerVideoSecond: 0.23,
    confidence: "uncalibrated",
    falUnit: "1000 tokens",
    note: "Cheap 480p look (~$0.21/s, under half the 720p price) for checking a shot before paying for the real one. Not for delivery.",
    durations: range(5, 30),
    minDuration: 5,
  },
  // ---- Atlas Cloud (driver "atlas"; Shawn, 2026-10-12) ----
  // Same ByteDance models as the fal rows above, sold through Atlas at a lower
  // price, and Atlas advertises "Portrait Reference Support" (fal's Seedance
  // reference mode rejected Shawn's realistic characters). Request fields from
  // Atlas's model docs (2026-10-12). Prices from Atlas's model pages that day:
  // "from $0.134/s" (480p) and $1.51 quoted for a default 720p run, about
  // $0.30/s if that run is 5 s. Uncalibrated until Atlas's daily cost report
  // (/public/v1/model-costs) or the balance shows a real charge; 0.33 is a
  // ceiling so the cap blocks rather than overspends.
  {
    id: "atlas:bytedance/seedance-2.5/image-to-video",
    driver: "atlas",
    atlas: { model: "bytedance/seedance-2.5/image-to-video", startField: "image", endField: "last_image", fixed: { resolution: "720p", ratio: "adaptive", generate_audio: true } },
    promptStyle: "seedance",
    short: "SD25atl",
    label: "Seedance 2.5 · Atlas (720p)",
    usdPerVideoSecond: 0.33,
    confidence: "uncalibrated",
    falUnit: "Atlas: video tokens",
    note: "Seedance 2.5 through Atlas Cloud: start + end frames, ~30% cheaper than fal (estimate). Native audio.",
    durations: range(4, 30),
    minDuration: 4,
    imageParams: ["image", "last_image"],
  },
  {
    id: "atlas:bytedance/seedance-2.5/reference-to-video",
    driver: "atlas",
    atlas: { model: "bytedance/seedance-2.5/reference-to-video", refImages: "reference_images", refVideos: "reference_videos", fixed: { resolution: "720p", generate_audio: true } },
    inputMode: "reference",
    promptStyle: "seedance",
    short: "SD25refatl",
    label: "Seedance 2.5 — references · Atlas (720p)",
    // Atlas schema: up to 30 images, 10 videos of 2–30 s, 30 s combined.
    refVideo: { param: "reference_videos", max: 10, minSec: 2, maxSec: 30, totalSec: 30, usdPerSec: 0.30, confidence: "estimated" },
    usdPerVideoSecond: 0.33,
    confidence: "uncalibrated",
    falUnit: "Atlas: video tokens",
    note: "Seedance 2.5 reference mode through Atlas Cloud (@Image / @Video). Atlas says it supports portrait references; fal's version rejected realistic faces.",
    durations: range(4, 30),
    minDuration: 4,
  },
  // ---- Comfy Router (driver "comfy"; Shawn, 2026-10-16) ----
  // For the Open Source Higgsfield challenge (needs the Comfy Developer
  // Platform). Prices from Comfy's Router pricing page, read 2026-10-16
  // (211 credits = $1): MiniMax H3 $0.1287/s at 768P and $0.1859/s at 2K;
  // Seedance 2.5 image-to-video $15.301 per 1M tokens (480p/720p), $16.731 at
  // 1080p, i.e. $0.0153 per 1k tokens x 21,600 tokens/s = ~$0.33/s at 720p.
  // `optIn` rows are never picked by cheapest route: they run only when chosen.
  // Only the H3 text-to-video call has been run live (a 5 s 768P take, 2026-10-16,
  // no cost field on the response); image bodies follow Comfy's model pages.
  {
    id: "comfy:minimax/minimax-h3",
    driver: "comfy",
    optIn: true,
    comfy: { model: "minimax/minimax-h3", endFrame: false, fixed: { resolution: "768P" } },
    promptStyle: "fal-brief",
    short: "H3cmf",
    label: "MiniMax H3 · Comfy (768P)",
    // Measured 2026-10-16: a 5 s 768P take used 136 credits = $0.6445 at
    // 211 credits per dollar ($0.1289/s), against the published $0.1287/s.
    usdPerVideoSecond: 0.1287,
    confidence: "measured",
    falUnit: "Comfy: seconds",
    note: "MiniMax H3 through the Comfy Router: first frame, no end frame. Own synchronised audio.",
    durations: range(5, 15),
    minDuration: 5,
    imageParams: ["first_frame"],
  },
  {
    id: "comfy:byteplus/dreamina-seedance-2-5-260628/image-to-video",
    driver: "comfy",
    optIn: true,
    comfy: { model: "byteplus/dreamina-seedance-2-5-260628", endFrame: true, fixed: { resolution: "720p", ratio: "adaptive", generate_audio: true } },
    promptStyle: "seedance",
    short: "SD25cmf",
    label: "Seedance 2.5 · Comfy (720p)",
    usdPerVideoSecond: 0.331,
    confidence: "estimated",
    falUnit: "Comfy: video tokens",
    note: "Seedance 2.5 through the Comfy Router: start + end frames. Native audio.",
    durations: range(4, 30),
    minDuration: 4,
    imageParams: ["first_frame", "last_frame"],
  },
  {
    id: "comfy:byteplus/dreamina-seedance-2-5-260628/reference-to-video",
    driver: "comfy",
    optIn: true,
    comfy: { model: "byteplus/dreamina-seedance-2-5-260628", fixed: { resolution: "720p", generate_audio: true } },
    inputMode: "reference",
    promptStyle: "seedance",
    short: "SD25refcmf",
    label: "Seedance 2.5 — references · Comfy (720p)",
    refVideo: { param: "reference_video", max: 10, minSec: 2, maxSec: 30, totalSec: 30, usdPerSec: 0.331, confidence: "estimated" },
    usdPerVideoSecond: 0.36,
    confidence: "uncalibrated",
    falUnit: "Comfy: video tokens",
    note: "Seedance 2.5 reference mode through the Comfy Router (reference images and videos). Not yet run live.",
    durations: range(4, 30),
    minDuration: 4,
  },
  {
    id: "alibaba/wan-3.0/image-to-video",
    short: "Wan30", // model code in take file names
    label: "Wan 3.0",
    usdPerVideoSecond: 0.15,
    imageParams: ["start_image_url", "end_image_url"],
    confidence: "uncalibrated",
    falUnit: "seconds",
    // fal's pricing API reports the same bare "seconds" unit MiniMax H3 did
    // before its ratio was corrected above — this ceiling is UNVERIFIED
    // against a real invoice. Don't assume it's safe just because it's
    // already above the raw $0.05 quote; replace it the first time an
    // actual comes back, the same way MiniMax's did.
    note: "Ceiling estimate — unverified against a real invoice (see MiniMax H3's note on compute vs. video seconds).",
    durations: range(5, 30), // fal schema: duration integer, 2-30; floor kept at 5
    minDuration: 5,
  },
];

// ---------- the picker: Model → Mode → Tier → Quality → Via (Shawn, 2026-10-12) ----------
//
// The Generate pane no longer shows one long list. Every combination is still
// its own row here — the cap, the ledger, take file names and undo all work
// on a row id — but each row carries coordinates (family, mode, tier, res,
// via) and the screen builds chips from them. The hand-written rows above
// keep their ids (takes, defaults and ledgers point at them); every other
// resolution / tier is generated below with id "<base>@<res>".
//
// Sources, all read 2026-10-12: fal schemas (resolutions, fields), fal's
// pricing API on Shawn's account (unit prices), the measured H3 Max factors
// (1.0 / 1.6 / 3.2 billed seconds per video second at 480P / 768P / 1080P),
// and fal's Seedance token formula (w × h × 24 / 1024 tokens per second).
// Silent takes cost the same: fal says so for Seedance, and H3 has no audio
// switch. So there is no audio chip until a model prices it differently.

export const FAMILIES = [
  { id: "h3max", label: "MiniMax H3 Max" },
  { id: "h3", label: "MiniMax H3" },
  { id: "sd25", label: "Seedance 2.5" },
  { id: "sd20", label: "Seedance 2.0" },
  { id: "kling3", label: "Kling v3" },
  { id: "wan3", label: "Wan 3.0" },
];
export const MODES = { frames: "Frames", refs: "References" };
export const TIERS = { standard: "Standard", fast: "Fast", mini: "Mini" };
export const VIAS = { fal: "fal", atlas: "Atlas", comfy: "Comfy" };

const COORDS = {
  "minimax/h3/image-to-video": { family: "h3", mode: "frames", res: "2K" },
  "minimax/h3-max/image-to-video": { family: "h3max", mode: "frames", res: "768P" },
  "minimax/h3-max/reference-to-video": { family: "h3max", mode: "refs", res: "768P" },
  "fal-ai/kling-video/v3/standard/image-to-video": { family: "kling3", mode: "frames" },
  "bytedance/seedance-2.5/image-to-video": { family: "sd25", mode: "frames", res: "720p" },
  "bytedance/seedance-2.0/fast/image-to-video": { family: "sd20", mode: "frames", tier: "fast", res: "720p" },
  "bytedance/seedance-2.5/reference-to-video": { family: "sd25", mode: "refs", res: "720p" },
  "bytedance/seedance-2.5/reference-to-video:draft480": { family: "sd25", mode: "refs", res: "480p draft" },
  "alibaba/wan-3.0/image-to-video": { family: "wan3", mode: "frames" },
  "atlas:bytedance/seedance-2.5/image-to-video": { family: "sd25", mode: "frames", res: "720p", via: "atlas" },
  "atlas:bytedance/seedance-2.5/reference-to-video": { family: "sd25", mode: "refs", res: "720p", via: "atlas" },
  "comfy:minimax/minimax-h3": { family: "h3", mode: "frames", res: "768P", via: "comfy" },
  "comfy:byteplus/dreamina-seedance-2-5-260628/image-to-video": { family: "sd25", mode: "frames", res: "720p", via: "comfy" },
  "comfy:byteplus/dreamina-seedance-2-5-260628/reference-to-video": { family: "sd25", mode: "refs", res: "720p", via: "comfy" },
};
for (const m of VIDEO_MODELS) Object.assign(m, { tier: null, res: null, via: "fal" }, COORDS[m.id] || {});

const SD_TOKENS = { "480p": 9607, "720p": 21600, "1080p": 48600, "4k": 194400 }; // per video second, 24 fps
const r3 = (n) => Math.round(n * 1000) / 1000;
const sdUSD = (per1k, res) => r3(per1k * SD_TOKENS[res] / 1000);

export function pickerLabel(m) {
  const fam = (FAMILIES.find((f) => f.id === m.family) || {}).label || m.family;
  const tier = m.tier && m.family === "sd20" ? ` ${TIERS[m.tier]}` : "";
  const mode = m.mode === "refs" ? " — references" : "";
  const res = m.res ? ` (${m.res})` : "";
  const via = m.via && m.via !== "fal" ? ` · ${VIAS[m.via] || m.via}` : "";
  return `${fam}${tier}${mode}${res}${via}`;
}

// A copy of a row at another resolution. `usd` is a number or a function
// (a getter, for promo prices that switch on a date).
function variant(base, res, { usd, confidence, conversion, refVideoUsd, note } = {}) {
  const { usdPerVideoSecond: _ignored, ...plain } = Object.fromEntries(Object.entries(base));
  const v = {
    ...plain,
    id: `${base.id.replace(/:draft480$/, "")}@${res}`,
    res, proven: false,
    short: `${base.short.replace(/(480|768|720)$/, "")}-${res.replace(/[^0-9a-zA-Z]/g, "")}`,
    confidence: confidence || base.confidence,
    conversion: conversion || null,
    note: note || base.note,
  };
  if (base.driver === "atlas" || base.driver === "comfy") v[base.driver] = { ...base[base.driver], fixed: { ...(base[base.driver].fixed || {}), resolution: res } };
  else { v.endpoint = base.endpoint || base.id; v.fixedParams = { ...(base.fixedParams || {}), resolution: res }; }
  if (base.refVideo) v.refVideo = { ...base.refVideo, usdPerSec: refVideoUsd ?? base.refVideo.usdPerSec };
  if (typeof usd === "function") Object.defineProperty(v, "usdPerVideoSecond", { get: usd, enumerable: true });
  else v.usdPerVideoSecond = usd;
  v.label = pickerLabel(v);
  return v;
}
const row = (id) => VIDEO_MODELS.find((m) => m.id === id);
const h3maxRate = (factor) => () => (Date.now() < H3MAX_PROMO_ENDS ? 0.03 : 0.05) * factor;

// Seedance 2.0 Standard and Mini, and Fast references: new families of rows
// (fal schemas 2026-10-12). Standard sells 480p–4K, Fast and Mini 480p/720p.
// Reference mode: up to 9 images, 3 videos (no `task` field, unlike 2.5).
const SD20 = { standard: { path: "bytedance/seedance-2.0", per1k: 0.014, res: ["480p", "720p", "1080p", "4k"] },
  fast: { path: "bytedance/seedance-2.0/fast", per1k: 0.0112, res: ["480p", "720p"] },
  mini: { path: "bytedance/seedance-2.0/mini", per1k: 0.007, res: ["480p", "720p"] } };
const sd20Base = (tier, mode) => {
  const t = SD20[tier];
  const id = `${t.path}/${mode === "refs" ? "reference-to-video" : "image-to-video"}`;
  return {
    id, family: "sd20", mode, tier, res: "720p", via: "fal",
    promptStyle: "seedance",
    short: `SD20${tier === "standard" ? "" : tier === "fast" ? "F" : "M"}${mode === "refs" ? "ref" : ""}`,
    usdPerVideoSecond: mode === "refs" ? r3(sdUSD(t.per1k, "720p") * 1.08) : sdUSD(t.per1k, "720p"),
    confidence: mode === "refs" ? "uncalibrated" : "estimated",
    falUnit: "1000 tokens",
    conversion: { tokensPerVideoSecond: SD_TOKENS["720p"] },
    note: mode === "refs" ? `Seedance 2.0 ${TIERS[tier]} reference mode: up to 9 images (@Image) and 3 videos (@Video).` : `Seedance 2.0 ${TIERS[tier]}: start + end frames, native audio.`,
    durations: range(4, 15), minDuration: 4,
    ...(mode === "refs"
      ? { inputMode: "reference", maxRefs: 9, noTask: true, refVideo: { param: "video_urls", max: 3, minSec: 2, maxSec: 15, totalSec: 15, usdPerSec: sdUSD(t.per1k, "720p"), confidence: "estimated" } }
      : { imageParams: ["image_url", "end_image_url"] }),
  };
};
for (const tier of ["standard", "fast", "mini"]) for (const mode of ["frames", "refs"]) {
  if (tier === "fast" && mode === "frames") continue; // the hand-written row above
  const b = sd20Base(tier, mode); b.label = pickerLabel(b); VIDEO_MODELS.push(b);
}

const VARIANTS = [];
// MiniMax H3 Max, frames: the promo ($0.03 per billed second) runs to Oct 15.
VARIANTS.push(variant(row("minimax/h3-max/image-to-video"), "480P", { usd: h3maxRate(1.0), conversion: { unitsPerVideoSecond: 1.0 } }));
VARIANTS.push(variant(row("minimax/h3-max/image-to-video"), "1080P", { usd: h3maxRate(3.2), conversion: { unitsPerVideoSecond: 3.2 }, note: "1080P is fal's latent refinement of a native 768P render." }));
// H3 Max references: no promo ($0.05 per billed second).
VARIANTS.push(variant(row("minimax/h3-max/reference-to-video"), "480P", { usd: 0.05, confidence: "measured", conversion: { unitsPerVideoSecond: 1.0 } }));
VARIANTS.push(variant(row("minimax/h3-max/reference-to-video"), "1080P", { usd: 0.16, confidence: "measured", conversion: { unitsPerVideoSecond: 3.2 } }));
// MiniMax H3: 480P/768P native, 2K/4K upscales of 768P. Only 2K has been
// measured (2.6 compute seconds per video second); the rest are ceilings.
VARIANTS.push(variant(row("minimax/h3/image-to-video"), "480P", { usd: 0.13, confidence: "uncalibrated", note: "Native 480P. Ceiling price until a real take is billed." }));
VARIANTS.push(variant(row("minimax/h3/image-to-video"), "768P", { usd: 0.13, confidence: "uncalibrated", note: "Native 768P (2K and 4K upscale this). Ceiling price until a real take is billed." }));
VARIANTS.push(variant(row("minimax/h3/image-to-video"), "4K", { usd: 0.26, confidence: "uncalibrated", note: "4K upscale of a 768P render. Ceiling price until a real take is billed." }));
// Seedance 2.5 on fal ($0.0214 per 1000 tokens).
for (const res of ["480p", "1080p"]) {
  VARIANTS.push(variant(row("bytedance/seedance-2.5/image-to-video"), res, { usd: sdUSD(0.0214, res), confidence: "estimated", conversion: { tokensPerVideoSecond: SD_TOKENS[res] } }));
  VARIANTS.push(variant(row("bytedance/seedance-2.5/reference-to-video"), res, { usd: r3(sdUSD(0.0214, res) * 1.08), confidence: "uncalibrated", conversion: { tokensPerVideoSecond: SD_TOKENS[res] }, refVideoUsd: sdUSD(0.0214, res) }));
}
// Seedance 2.0 at the other resolutions.
for (const [tier, t] of Object.entries(SD20)) for (const mode of ["frames", "refs"]) {
  const base = tier === "fast" && mode === "frames" ? row("bytedance/seedance-2.0/fast/image-to-video") : row(`${t.path}/${mode === "refs" ? "reference-to-video" : "image-to-video"}`);
  for (const res of t.res.filter((r) => r !== "720p")) {
    const out = sdUSD(t.per1k, res);
    VARIANTS.push(variant(base, res, { usd: mode === "refs" ? r3(out * 1.08) : out, confidence: mode === "refs" ? "uncalibrated" : "estimated", conversion: { tokensPerVideoSecond: SD_TOKENS[res] }, refVideoUsd: out }));
  }
}
// Seedance 2.5 on Atlas: "from $0.134/s" (480p) on Atlas's pages; ceilings.
for (const id of ["atlas:bytedance/seedance-2.5/image-to-video", "atlas:bytedance/seedance-2.5/reference-to-video"]) {
  VARIANTS.push(variant(row(id), "480p", { usd: 0.15, confidence: "uncalibrated", refVideoUsd: 0.14 }));
  VARIANTS.push(variant(row(id), "1080p", { usd: 0.75, confidence: "uncalibrated", refVideoUsd: 0.70 }));
}
// Comfy Router (pricing page 2026-10-16): H3 2K $0.1859/s; Seedance 2.5 at
// $0.015301 per 1k tokens (480p/720p) and $0.016731 (1080p).
VARIANTS.push(variant(row("comfy:minimax/minimax-h3"), "2K", { usd: 0.1859, confidence: "estimated" }));
const SD25_CMF = "comfy:byteplus/dreamina-seedance-2-5-260628";
VARIANTS.push(variant(row(`${SD25_CMF}/image-to-video`), "480p", { usd: sdUSD(0.015301, "480p"), confidence: "estimated", conversion: { tokensPerVideoSecond: SD_TOKENS["480p"] } }));
VARIANTS.push(variant(row(`${SD25_CMF}/image-to-video`), "1080p", { usd: sdUSD(0.016731, "1080p"), confidence: "estimated", conversion: { tokensPerVideoSecond: SD_TOKENS["1080p"] } }));
VIDEO_MODELS.push(...VARIANTS);
// Hand-written rows get the picker's label too (their old labels live in
// git history); conversions for the price watch come from the row itself.
for (const m of VIDEO_MODELS) m.label = pickerLabel(m);

// Lip-sync models: video + audio in, the same video with the mouth re-timed to
// the audio out. Billed on the SOURCE take's length. Priced from fal's pricing
// API (2026-09-29): sync-3 $8/min, Sync 2 Pro $5/min — both a plain per-minute
// unit of video, not a compute-second unit like MiniMax H3, so "exact" — but
// like every rate here, replace with a measured actual the first time one
// comes back (the ledger records drift).
export const LIPSYNC_MODELS = [
  {
    id: "fal-ai/sync-lipsync/v3",
    short: "LipSync3", // model code in take file names
    label: "sync-3",
    usdPerVideoSecond: 8 / 60,
    confidence: "exact",
    falUnit: "minutes",
    note: "Sync's newest. Handles faces without special setup; best first try.",
  },
  {
    id: "fal-ai/sync-lipsync/v2/pro",
    short: "LipSync2Pro", // model code in take file names
    label: "Sync 2 Pro",
    usdPerVideoSecond: 5 / 60,
    confidence: "exact",
    falUnit: "minutes",
    note: "Cheaper older tier. Worth trying on close-ups where sync-3 over-acts.",
  },
];
export const LIPSYNC_SYNC_MODES = ["cut_off", "loop", "bounce", "silence", "remap"];
const LIPSYNC_BY_ID = new Map(LIPSYNC_MODELS.map((m) => [m.id, m]));
export function lipsyncModel(id) { return LIPSYNC_BY_ID.get(id) || null; }

// Reference-image tokens for a "frames+refs" model: each image is billed at
// w x h / 1024 tokens; the first refFreeTokens per request are free. Images are
// sent at <=1280 px on the long side, so a missing size is costed as 1280x720.
// Reference video cost for a model: seconds of reference video x its rate.
export function refVideoUSD(modelId, seconds = 0) {
  const m = videoModel(modelId);
  return m && m.refVideo ? (Number(seconds) || 0) * m.refVideo.usdPerSec : 0;
}

export function referenceUSD(modelId, sizes = []) {
  const m = videoModel(modelId);
  if (!m || !m.refUSDPer1kTokens) return 0;
  const tokens = sizes.reduce((t, { w = 1280, h = 720 } = {}) => {
    const k = Math.min(1, 1280 / Math.max(w, h));
    return t + Math.round(w * k) * Math.round(h * k) / 1024;
  }, 0);
  return Math.max(0, tokens - (m.refFreeTokens || 0)) / 1000 * m.refUSDPer1kTokens;
}

// Short model code for a take's file name ("H3Max768", "SD25"). Unknown ids
// fall back to a cleaned label so a new model still gets a readable name.
export function modelShort(id, label = "") {
  const m = VIDEO_MODELS.find((x) => x.id === id) || LIPSYNC_BY_ID.get(id);
  if (m && m.short) return m.short;
  return String(label || id || "take").replace(/[^A-Za-z0-9]+/g, "").slice(0, 20) || "take";
}
export function estimateLipsyncUSD(modelId, seconds) {
  const m = lipsyncModel(modelId);
  if (!m) throw Object.assign(new Error(`unknown lip-sync model "${modelId}" — check rates.js LIPSYNC_MODELS`), { status: 400 });
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error(`invalid duration ${JSON.stringify(seconds)}`), { status: 400 });
  return { usd: m.usdPerVideoSecond * n, confidence: m.confidence, rate: m.usdPerVideoSecond };
}

// fal-driven still models carry `endpoints: { generate, edit }` — the literal
// fal queue paths for text-to-image vs. image-to-image — because fal doesn't
// use one consistent suffix across model families (gpt-image-1 uses
// ".../edit-image", Seedream uses ".../edit"). jobs.js picks generate vs edit
// by whether the shot has any reference images; the Gemini entry needs
// neither field since GeminiDriver only ever serves its one fixed model.
export const IMAGE_MODELS = [
  {
    // Rehearsal only: copies a reference (or the app icon) instead of calling
    // anything, so the vault's Generate flow can be exercised for free.
    id: "mock-image",
    label: "Mock — rehearsal, no spend",
    driver: "mock",
    usdPerImage: 0,
    confidence: "exact",
    note: "No network, no charge. Writes a placeholder so the flow can be tested.",
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "Nano Banana (Gemini)",
    driver: "gemini",
    usdPerImage: 0.04,
    confidence: "uncalibrated",
    note: "Ceiling estimate. The in-session default for turnarounds and boards.",
  },
  // Comfy Router stills (Shawn, 2026-10-16). Token-billed by Comfy's Vertex
  // route: Nano Banana 2 is $0.60 per 1M input tokens and $72 per 1M image output
  // tokens; Pro is $2.40 and $144. A 1K image is ~1,290 output tokens in Comfy's
  // own sample (~$0.093), plus a few cents of input when references are sent.
  // Rows are ceilings until a real take's credits are read from the dashboard.
  {
    id: "comfy:vertexai/gemini-3.1-flash-image",
    label: "Nano Banana 2 · Comfy",
    driver: "comfy",
    endpoints: { generate: "vertexai/gemini-3.1-flash-image", edit: "vertexai/gemini-3.1-flash-image" },
    usdPerImage: 0.10,
    confidence: "uncalibrated",
    note: "Nano Banana 2 through the Comfy Router (token-billed, about $0.09 per 1K image). Refused prompts are still billed.",
  },
  {
    id: "comfy:vertexai/gemini-3-pro-image",
    label: "Nano Banana Pro · Comfy",
    driver: "comfy",
    endpoints: { generate: "vertexai/gemini-3-pro-image", edit: "vertexai/gemini-3-pro-image" },
    usdPerImage: 0.19,
    confidence: "uncalibrated",
    note: "Nano Banana Pro through the Comfy Router (token-billed, about $0.16 per 1K/2K image, more at 4K). Refused prompts are still billed.",
  },
  {
    id: "fal-ai/gpt-image-1",
    label: "GPT Image (fal)",
    driver: "fal",
    endpoints: { generate: "fal-ai/gpt-image-1/text-to-image", edit: "fal-ai/gpt-image-1/edit-image" },
    usdPerImage: 0.39,
    confidence: "measured",
    note: "One edit billed $0.39 in the fal usage CSV (2026-10-07) vs the old $0.08 guess. gpt-image-1 cost varies with quality, size and reference images, so treat this as a ceiling until more runs come back.",
  },
  {
    id: "bytedance/seedream/v5/pro",
    label: "Seedream 5 Pro (fal)",
    driver: "fal",
    endpoints: { generate: "bytedance/seedream/v5/pro/text-to-image", edit: "bytedance/seedream/v5/pro/edit" },
    usdPerImage: 0.0675,
    confidence: "exact",
    note: "fal's pricing API, checked 2026-09-21. Up to 10 reference images per call — the richest omni-reference support of the three still models.",
  },
];

const VIDEO_BY_ID = new Map(VIDEO_MODELS.map((m) => [m.id, m]));
const IMAGE_BY_ID = new Map(IMAGE_MODELS.map((m) => [m.id, m]));

export function videoModel(id) { return VIDEO_BY_ID.get(id) || null; }
export function imageModel(id) { return IMAGE_BY_ID.get(id) || null; }

// Pre-flight estimate. Always returns a number — an unknown model falls back to
// the most expensive known rate, because an unknown cost must never estimate
// cheap. Returns the confidence alongside so callers can warn.
export function estimateVideoUSD(modelId, seconds) {
  const m = videoModel(modelId);
  if (!m) {
    const worst = Math.max(...VIDEO_MODELS.map((x) => x.usdPerVideoSecond));
    return { usd: worst * seconds, confidence: "unknown-model", rate: worst };
  }
  const rate = effectiveVideoRate(m);
  return { usd: rate * seconds, confidence: liveRate(m.id) != null ? "live" : m.confidence, rate };
}

export function estimateImageUSD(modelId, count = 1) {
  const m = imageModel(modelId);
  const rate = m ? effectiveImageRate(m) : Math.max(...IMAGE_MODELS.map((x) => x.usdPerImage));
  return { usd: rate * count, confidence: m ? (liveRate(m.id) != null ? "live" : m.confidence) : "unknown-model", rate };
}

// ---------- live prices (price watch, server/pricewatch.js) ----------
//
// fal's pricing API returns a price per BILLING unit, which isn't always a
// video second: H3 bills ~1.6 "seconds" per output second at 768P, Seedance
// bills 1000-token units (w x h x fps / 1024 tokens per second at the
// resolution sent). This table turns fal's unit price into $ per video second.
// A model without an entry still shows fal's raw price, unconverted, and its
// estimate stays on the table above. Keyed by model id (the 480p draft shares
// an endpoint with full Seedance references but not a token rate).
export const FAL_CONVERSION = {
  "minimax/h3/image-to-video": { unitsPerVideoSecond: 2.6 },          // 13 compute-s per 5 s (2026-09-27)
  "minimax/h3-max/image-to-video": { unitsPerVideoSecond: 1.6 },      // 1.6 per second at 768P
  "minimax/h3-max/reference-to-video": { unitsPerVideoSecond: 1.6 },
  "fal-ai/kling-video/v3/standard/image-to-video": { unitsPerVideoSecond: 1 },
  "bytedance/seedance-2.5/image-to-video": { tokensPerVideoSecond: 21600 },   // 1280x720x24/1024
  "bytedance/seedance-2.0/fast/image-to-video": { tokensPerVideoSecond: 21780 }, // measured 2026-10-08
  "bytedance/seedance-2.5/reference-to-video": { tokensPerVideoSecond: 21600 },
  "bytedance/seedance-2.5/reference-to-video:draft480": { tokensPerVideoSecond: 9607 }, // 480x854x24/1024
};

// modelId -> { usd (per video second / per image, or null if unconvertible),
//              unit, unitPrice, checkedAt }
const LIVE = new Map();
export function setLivePrice(modelId, rec) { if (rec) LIVE.set(modelId, rec); else LIVE.delete(modelId); }
export function livePrice(modelId) { return LIVE.get(modelId) || null; }
export function liveRate(modelId) { const r = LIVE.get(modelId); return r && Number.isFinite(r.usd) ? r.usd : null; }
export function effectiveVideoRate(m) { const r = liveRate(m.id); return r != null ? r : m.usdPerVideoSecond; }
export function effectiveImageRate(m) { const r = liveRate(m.id); return r != null ? r : m.usdPerImage; }

// fal unit price -> $ per video second (video) or per image, or null.
export function convertFalPrice(modelId, unit, unitPrice, kind = "video") {
  const u = String(unit || "").toLowerCase();
  // fal calls a per-image unit "image" for most models and "units" for some
  // (Seedream 5 Pro: $0.0675 per "units" = per image, 2026-10-12).
  if (kind === "image") return ["image", "images", "units", "unit"].includes(u) ? unitPrice : null;
  const c = FAL_CONVERSION[modelId] || (videoModel(modelId) || {}).conversion;
  if (!c) return null;
  if (c.unitsPerVideoSecond && /^seconds?$/.test(u)) return unitPrice * c.unitsPerVideoSecond;
  if (c.tokensPerVideoSecond && /^1000 tokens$/.test(u)) return unitPrice * c.tokensPerVideoSecond / 1000;
  return null;
}

// ---------- cheapest route (Shawn, 2026-10-13) ----------
//
// The same model can be sold by more than one connected aggregator (today:
// Seedance 2.5 on fal and on Atlas Cloud). With "cheapest route" on, a take is
// sent through whichever CONNECTED service sells that exact combination
// (family, mode, tier, quality) for less right now: live prices from the price
// watch where there are any, the table's figures otherwise. A promo on fal
// shows up through the live price; a service with no key is never chosen. A
// route has to be cheaper by more than half a percent to move the take, so a
// tie keeps what was picked.
const ROUTE_MARGIN = 0.005;
const routeKey = (m) => [m.family, m.mode, m.tier || "", m.res || ""].join("|");

export function routeSiblings(modelId) {
  const m = videoModel(modelId);
  if (!m || !m.family) return m ? [m] : [];
  const k = routeKey(m);
  // optIn rows (Comfy) run only when picked; they never win the cheapest route.
  return VIDEO_MODELS.filter((x) => routeKey(x) === k && (!x.optIn || x.id === modelId));
}

// isReady(via) -> bool: whether that service is connected. Returns the chosen
// row id plus every option considered, so the quote can say why.
export function cheapestRoute(modelId, isReady = () => true) {
  const m = videoModel(modelId);
  if (!m) return { modelId, routed: false, options: [] };
  const options = routeSiblings(modelId).map((x) => ({ id: x.id, via: x.via || "fal", rate: effectiveVideoRate(x), live: liveRate(x.id) != null, ready: !!isReady(x.via || "fal") }));
  const mine = options.find((o) => o.id === modelId);
  const ready = options.filter((o) => o.ready);
  const cheapest = ready.reduce((a, o) => (!a || o.rate < a.rate ? o : a), null);
  // Nothing connected: keep the pick (the submit then says what to connect).
  // The pick is connected: move only for a real saving. It isn't: cheapest
  // connected route.
  const best = !cheapest ? mine : mine.ready && cheapest.rate >= mine.rate * (1 - ROUTE_MARGIN) ? mine : cheapest;
  return { modelId: best.id, routed: best.id !== modelId, from: modelId, options };
}
