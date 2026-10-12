// Gate tracker — reference/series-pm.md's six stage gates, checked against
// data actually on the episode. Every check here is schema-only: it reports
// what IS true, and is honest about which checks can't run yet because the
// upstream feature (image generation, video generation) isn't built —
// forward-compatible with Phase 2/3 rather than faking a pass.

import { GATES } from "./schema.js";
import { newAssetAudit } from "./audit.js";

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

function auditKey(row) { return `${row.type}:${norm(row.name)}`; }

// Audit rows not resolved by a standing registry match AND not explicitly
// overridden on the episode.
export function unresolvedAudit(episode, registry) {
  const audit = newAssetAudit(episode.scenes || [], registry || []);
  const overrides = episode.assetAuditOverrides || {};
  return audit.new.filter((row) => !overrides[auditKey(row)]);
}

// Shots in the "Cut from edit" bin are out of the edit, so they never hold a
// gate open.
const live = (shots) => (shots || []).filter((s) => !s.cutFromEdit);

function beatStillStats(shots) {
  let total = 0, approved = 0;
  for (const s of live(shots)) {
    for (const b of s.beats || []) {
      if (!b.keyframe) continue;
      total += 1;
      if (b.frame && b.frame.approved) approved += 1;
    }
  }
  return { total, approved };
}

function shotVideoStats(shots) {
  let total = 0, selected = 0;
  for (const s of live(shots)) {
    total += 1;
    if ((s.selectedVersions || []).length) selected += 1;
  }
  return { total, selected };
}

// Requirements to ENTER `gateId` (i.e. the gate before it must be satisfied).
// Returns { ok, reasons[] }. `reasons` is empty iff ok.
export function checkGate(gateId, episode, registry) {
  const reasons = [];
  switch (gateId) {
    case "G0": {
      if (!(episode.scenes || []).length) reasons.push("no scenes yet — parse or write the outline first");
      break;
    }
    case "G1": {
      if (!(episode.scenes || []).length) reasons.push("G0 not satisfied: no scenes");
      if (!episode.scriptPath && !(episode.shots || []).length) {
        reasons.push("no script attached and no shots drafted — lock a script before G1");
      }
      break;
    }
    case "G2": {
      const unresolved = unresolvedAudit(episode, registry);
      if (unresolved.length) {
        reasons.push(`new-asset audit: ${unresolved.length} item(s) unresolved — build and approve them, or waive`);
      }
      break;
    }
    case "G3": {
      const { total, approved } = beatStillStats(episode.shots);
      if (total === 0) reasons.push("no keyframe stills defined yet");
      else if (approved < total) reasons.push(`${approved}/${total} keyframe stills approved`);
      break;
    }
    case "G4": {
      // The hard rule from series-pm.md: never generate video before boards
      // are approved. This is enforced here, not just documented.
      const boards = checkGate("G3", episode, registry);
      if (!boards.ok) reasons.push("G3 (board lock) not satisfied — video may not be generated before boards are approved");
      break;
    }
    case "G5": {
      const { total, selected } = shotVideoStats(episode.shots);
      if (total === 0) reasons.push("no shots to deliver");
      else if (selected < total) reasons.push(`${selected}/${total} shots have a selected take`);
      // "Delivery: Assembled, exported, QC passed" (series-pm.md) — a
      // selected take on every shot is necessary but not sufficient; G5
      // means something actually got exported for the edit.
      if (!(episode.exports || []).length) reasons.push("no export has been generated yet (FCPXML / OTIO / CapCut)");
      break;
    }
    default:
      reasons.push(`unknown gate "${gateId}"`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Full status for every gate, for the UI strip.
export function gateStatus(episode, registry) {
  return GATES.map((g) => ({ ...g, ...checkGate(g.id, episode, registry) }));
}

// Attempt to move the episode to `gateId`. Moving BACKWARD (rework) is always
// allowed — the risk register expects drift or rewrites to reopen a gate.
// Moving FORWARD requires the gate's own requirements to be met, in order:
// entering G3 also implies G2's requirements still hold, etc., so this walks
// every gate up to and including the target.
export function attemptGate(episode, registry, targetGateId, note) {
  const order = GATES.map((g) => g.id);
  const from = order.indexOf(episode.gate);
  const to = order.indexOf(targetGateId);
  if (to < 0) return { ok: false, reasons: [`unknown gate "${targetGateId}"`] };

  if (to <= from) {
    // Capture BEFORE mutating — the forward branch below already does this
    // correctly with its own `prev` local. This branch used to read
    // `episode.gate` for the log entry AFTER already overwriting it, so every
    // reopen logged "from X to X" no matter where it actually came from.
    const prev = episode.gate;
    episode.gate = targetGateId;
    episode.gateLog.push({ at: new Date().toISOString(), from: prev, to: targetGateId, note: note || "reopened for rework" });
    return { ok: true, reasons: [] };
  }

  for (let i = from + 1; i <= to; i++) {
    const check = checkGate(order[i], episode, registry);
    if (!check.ok) return { ok: false, blockedAt: order[i], reasons: check.reasons };
  }
  const prev = episode.gate;
  episode.gate = targetGateId;
  episode.gateLog.push({ at: new Date().toISOString(), from: prev, to: targetGateId, note: note || "" });
  return { ok: true, reasons: [] };
}
