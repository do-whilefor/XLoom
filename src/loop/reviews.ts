import type { Decision, Finding } from "../types.js";

type Review = NonNullable<Decision["reviews"]>[number];

/** Shared by preflight and the transactional Store. No promotion, rating repair,
 * file reads or evidence interpretation happens here. */
export function findingReviewErrors(finding: Finding, review: Review, field: string): string[] {
  const errors: string[] = [];
  if (review.status === "closed") {
    if (review.rating !== "unrated") errors.push(`${field}.rating: Closed findings remain unrated. Use unrated for an evidenced closure; info is a verified impact rating, not a closed status`);
    if (!finding.factIds.length || !finding.evidenceIds.length) errors.push(`${field}: Closing a hypothesis requires evidence-backed validation, not just an assertion. Defer closure and plan Execute to obtain the missing evidence`);
  } else {
    if (!["technical_hit", "impact_verified"].includes(finding.status)) errors.push(`${field}.status: A lead cannot skip technical validation. Finding ${JSON.stringify(finding.id)} currently has status ${JSON.stringify(finding.status)}; defer this review and plan Execute to validate/report technical_hit via the existing Finding key. Evidence count alone does not promote a Finding`);
    const missing = [review.rating === "unrated" ? "rating" : "", !review.impact ? "impact" : "", !review.pocEvidenceId ? "pocEvidenceId" : ""].filter(Boolean);
    if (missing.length) errors.push(`${field}: Verified impact requires rating, impact and PoC evidence. Missing: ${missing.join(", ")}. Do not invent these fields; defer unsupported verification`);
    if (!finding.factIds.length || !finding.evidenceIds.length) errors.push(`${field}: PoC and facts must belong to the finding. Evidence-backed facts are required before impact review`);
  }
  return errors;
}
