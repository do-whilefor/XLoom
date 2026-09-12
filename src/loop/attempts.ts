import { createHash } from "node:crypto";
import type { AttemptProposal, BoardSnapshot } from "../types.js";

const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Observation wording and volatile artifact bytes deliberately do not define a new experiment. */
export function attemptKeys(attempt: Omit<AttemptProposal, "evidenceRefs">): { conditionKey: string; outcomeKey: string } {
  const conditionKey = digest([
    normalize(attempt.hypothesis), attempt.scope.trim(), attempt.identity.trim(), attempt.stateVersion.trim(), attempt.baseline.trim(), attempt.changedVariable.trim(),
  ]);
  return { conditionKey, outcomeKey: digest([conditionKey, attempt.outcome]) };
}

/** Legacy results remain accepted; arbitrary paraphrases cannot be safely matched without structured attempts. */
export function legacyProgressMarkers(board: BoardSnapshot): Set<string> {
  const markers = board.facts.map(item => JSON.stringify(["fact", normalize(item.description), item.supersedes ?? null]));
  for (const finding of board.findings) {
    if (!finding.evidenceIds.length || !finding.factIds.length) continue;
    // Reopening/downgrading a review alone supplies no newly tested condition or observation.
    const rank = { lead: 0, technical_hit: 1, impact_verified: 2, closed: 2 }[finding.status];
    for (let level = 0; level <= rank; level++) markers.push(JSON.stringify(["finding", finding.key, normalize(finding.target), level]));
  }
  return new Set(markers);
}
