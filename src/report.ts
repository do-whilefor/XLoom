import { evidencePath } from "./paths.js";
import type { BoardSnapshot } from "./types.js";
import { cvssIssues, metricKeys } from "./scoring/cvss.js";

export function renderReport(board: BoardSnapshot, location?: { dataDir: string; workspace: string }): string {
  const lines = [`# ${board.config.title}`, "", `State: ${board.status} | Outcome: ${board.outcome ?? "not concluded"}`, "", board.reason, "", `Goal: ${board.config.goal}`, `Authorized scope: ${board.config.scope}`, "", "## Findings", ""];
  for (const finding of board.findings) {
    lines.push(`### ${finding.id} — ${finding.title}`, "", `Status: ${finding.status} | Rating: ${finding.rating}`, `Target: ${finding.target}`, `Next / reopening conditions: ${finding.next}`, "");
    if (finding.impact) for (const [key, value] of Object.entries(finding.impact)) lines.push(`- ${key}: ${value}`);
    if (finding.review) lines.push("", `Review: ${finding.review}`);
    if (finding.observationReview) lines.push("", `Review required: ${finding.observationReview.kinds.join(", ")}. Status/rating above are historical until reviewed.`);
    if (finding.cvss) {
      const cvss = finding.cvss, issues = cvssIssues(board, finding);
      lines.push("", `CVSS 3.1 Base: **${cvss.baseScore.toFixed(1)} ${cvss.severity}** · ${cvss.status}`, "", `\`${cvss.vector}\``, "",
        `Assessment: ${issues.join(", ") || "reviewed metric choices; arithmetic is not impact evidence"}`, "");
      for (const key of metricKeys) {
        const rationale = cvss.rationale[key];
        lines.push(`- ${key}:${cvss.metrics[key]} — ${rationale.reason} (${rationale.assumption ? "assumption" : "Fact-linked"}; Facts: ${rationale.factIds.join(", ") || "none"})`);
      }
      if (cvss.reviewReason) lines.push("", `CVSS review: ${cvss.reviewReason}`);
    }
    lines.push("", `Facts: ${finding.factIds.join(", ") || "none"}`, `Evidence: ${finding.evidenceIds.join(", ") || "none"}`, `PoC evidence: ${finding.pocEvidenceId ?? "not attached"}`, "");
  }
  if (!board.findings.length) lines.push("No evidence-backed finding has been recorded.", "");
  lines.push("## Evidence index", "");
  for (const evidence of board.evidence) lines.push(`- ${evidence.id}: ${location ? evidencePath(evidence, location.dataDir, location.workspace) : evidence.path} — ${evidence.description}`, `  SHA-256: ${evidence.sha256} (${evidence.bytes} bytes)`);
  lines.push("", "Integrity and schema checks do not independently establish a vulnerability. Review original artifacts and reproduce each reported impact within the authorized scope.", "");
  return lines.join("\n");
}
