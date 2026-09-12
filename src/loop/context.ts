import { dirname, join } from "node:path";
import type { BoardSnapshot, Evidence, Fact, Finding, Goal, Hint, Mode, RunRequest, Step } from "../types.js";

export type ContextStep = Omit<Step, "runId" | "leaseUntil"> & {
  /** A failed run may have left files here; this is not committed or verified Evidence. */
  recovery?: { artifacts: string; evidenceStatus: "unverified" };
};
export type ContextEvidence = Omit<Evidence, "runId">;
export type StepOrigin = Pick<Step, "id" | "description" | "status">;
type Collection = "goals" | "facts" | "steps" | "findings" | "evidence" | "hints";
type ReferenceKind = "goals" | "facts" | "steps" | "evidence";

export interface BlackboardContext {
  revision: number;
  project: Pick<BoardSnapshot["config"], "title" | "goal" | "scope" | "context">;
  status: BoardSnapshot["status"];
  reason: string;
  outcome: BoardSnapshot["outcome"];
  completedSteps: number;
  noProgressCount: number;
  goals: Goal[];
  facts: Fact[];
  steps: ContextStep[];
  findings: Finding[];
  evidence: ContextEvidence[];
  hints: Hint[];
  /** Identity-only provenance: these are not executable plans or a second history. */
  stepOrigins: StepOrigin[];
  projection: {
    mode: Mode;
    omitted: Record<Collection, number>;
    originStepCount: number;
    truncatedExcerpts: number;
    unavailableReferences: Record<ReferenceKind, string[]>;
    notice: string;
  };
}

/** Replacement seam for future context strategies; it does not change Pi's loop. */
export type ContextProjector = (request: RunRequest) => BlackboardContext;

const tailLimits = { steps: 8, facts: 12, findings: 8, evidence: 8 } as const;
const excerptLimit = 2_000;
const pending = (step: Step): boolean => step.status === "ready" || step.status === "claimed";
const notice = "This is a role-specific, partial blackboard view, not the complete history. Omission is not negative evidence, an untested boundary, or permission to repeat an old action. Counts describe omitted records, not their contents. Essential dependencies are retained and may exceed a fixed context budget. stepOrigins identify provenance only; their omitted plans are not available here. Superseded Facts are historical and must be read with their replacements. Evidence excerpts may be partial: schedule Execute to inspect the referenced artifact and record adequate evidence when a critical comparison is missing. Failed Steps may expose recovery.artifacts: within that old run, inspect only its artifacts directory for partial side effects, not sibling logs. Its files are unverified, may be absent, and are not committed Evidence or Facts; inspect before deciding whether any action should be retried. If inspected recovery material must be submitted as evidence, retain verifiable evidence in the current run's artifacts directory. Unavailable references indicate missing source records, never verified facts. Never inspect private run transcripts or chats.";

// Select fields explicitly, including nested records, so future runtime fields and
// accidentally attached messages/credentials cannot leak through object spreads.
export function projectStep(step: Step, runsDir?: string): ContextStep {
  // Match the store's identifier constraint; never turn malformed state into a
  // path outside the artifact directory or expose a private transcript entry.
  const recovery = step.status === "failed" && runsDir && step.runId && /^[a-zA-Z0-9_-]{1,100}$/.test(step.runId)
    ? { artifacts: join(runsDir, step.runId, "artifacts"), evidenceStatus: "unverified" as const }
    : undefined;
  return {
    id: step.id, goalId: step.goalId, from: [...step.from], description: step.description,
    successSignal: step.successSignal, evidencePlan: step.evidencePlan, priority: step.priority,
    status: step.status, attempts: step.attempts,
    ...(step.result === undefined ? {} : { result: step.result }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

function projectGoal(goal: Goal): Goal {
  return { id: goal.id, description: goal.description, parentId: goal.parentId, status: goal.status, factIds: [...goal.factIds] };
}

function projectFact(fact: Fact): Fact {
  return {
    id: fact.id, description: fact.description, stepId: fact.stepId, evidenceIds: [...fact.evidenceIds],
    ...(fact.supersedes === undefined ? {} : { supersedes: fact.supersedes }),
  };
}

function projectFinding(finding: Finding): Finding {
  return {
    id: finding.id, key: finding.key, target: finding.target, title: finding.title,
    status: finding.status, rating: finding.rating, evidenceIds: [...finding.evidenceIds],
    factIds: [...finding.factIds], next: finding.next,
    ...(finding.review === undefined ? {} : { review: finding.review }),
    ...(finding.pocEvidenceId === undefined ? {} : { pocEvidenceId: finding.pocEvidenceId }),
    ...(finding.impact === undefined ? {} : { impact: {
      capability: finding.impact.capability, object: finding.impact.object, result: finding.impact.result,
      scope: finding.impact.scope, prerequisites: finding.impact.prerequisites,
    } }),
  };
}

/**
 * Preserve dependency-complete working state and bounded irrelevant history.
 * This is not a hard token limit: a large active frontier must remain visible.
 * The full append-only state and evidence archive are never changed here.
 */
export function projectContext(request: RunRequest): BlackboardContext {
  const board = request.snapshot;
  const goals = new Map(board.goals.map(goal => [goal.id, goal]));
  const facts = new Map(board.facts.map(fact => [fact.id, fact]));
  const steps = new Map(board.steps.map(step => [step.id, step]));
  const evidence = new Map(board.evidence.map(item => [item.id, item]));
  if (request.mode === "execute" && request.step) steps.set(request.step.id, request.step);
  const selected = {
    goals: new Set<string>(), facts: new Set<string>(), steps: new Set<string>(),
    findings: new Set<string>(), evidence: new Set<string>(),
  };
  const unavailable = { goals: new Set<string>(), facts: new Set<string>(), steps: new Set<string>(), evidence: new Set<string>() };
  const replacements = new Map<string, string[]>();
  for (const fact of board.facts) {
    if (fact.supersedes) {
      const ids = replacements.get(fact.supersedes) ?? [];
      ids.push(fact.id);
      replacements.set(fact.supersedes, ids);
    }
  }

  function addGoal(id: string): void {
    // Iterative traversal handles deep trees and defensively terminates cycles.
    let current: string | null = id;
    while (current !== null && !selected.goals.has(current)) {
      const goal = goals.get(current);
      if (!goal) { unavailable.goals.add(current); break; }
      selected.goals.add(current);
      for (const factId of goal.factIds) selected.facts.add(factId);
      current = goal.parentId;
    }
  }

  function addStep(step: Step): void {
    selected.steps.add(step.id);
    addGoal(step.goalId);
    for (const factId of step.from) selected.facts.add(factId);
  }

  function addFinding(finding: Finding): void {
    selected.findings.add(finding.id);
    for (const factId of finding.factIds) selected.facts.add(factId);
    for (const evidenceId of finding.evidenceIds) selected.evidence.add(evidenceId);
    if (finding.pocEvidenceId) selected.evidence.add(finding.pocEvidenceId);
  }

  function closeFacts(): void {
    const queue = [...selected.facts];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const replacement of replacements.get(id) ?? []) queue.push(replacement);
      const fact = facts.get(id);
      if (!fact) { unavailable.facts.add(id); continue; }
      selected.facts.add(id);
      for (const evidenceId of fact.evidenceIds) selected.evidence.add(evidenceId);
      // Both directions matter: an assigned Step may still refer to a stale Fact.
      if (fact.supersedes) queue.push(fact.supersedes);
    }
  }

  if (request.mode === "execute") {
    if (request.step) {
      addStep(request.step);
      for (const fact of board.facts) if (fact.stepId === request.step.id) selected.facts.add(fact.id);
      for (const item of board.evidence) if (item.stepId === request.step.id) selected.evidence.add(item.id);
    } else {
      // Runtime validates the assignment; retain the user's roots if called alone.
      for (const goal of board.goals) if (goal.parentId === null) addGoal(goal.id);
    }
    closeFacts();
    const relatedFacts = new Set(selected.facts);
    const relatedEvidence = new Set(selected.evidence);
    for (const finding of board.findings) {
      if (finding.factIds.some(id => relatedFacts.has(id)) || finding.evidenceIds.some(id => relatedEvidence.has(id)) ||
        (finding.pocEvidenceId && relatedEvidence.has(finding.pocEvidenceId))) addFinding(finding);
    }
  } else {
    // A completion reviewer must never lose active goals or unresolved branches.
    for (const goal of board.goals) addGoal(goal.id);
    for (const step of board.steps.filter(pending)) addStep(step);
    for (const step of board.steps.filter(step => !pending(step)).slice(-tailLimits.steps)) addStep(step);
    for (const finding of board.findings.filter(finding => finding.status !== "closed")) addFinding(finding);
    for (const finding of board.findings.filter(finding => finding.status === "closed").slice(-tailLimits.findings)) addFinding(finding);
    for (const fact of board.facts.slice(-tailLimits.facts)) selected.facts.add(fact.id);
    for (const item of board.evidence.slice(-tailLimits.evidence)) selected.evidence.add(item.id);
  }
  closeFacts();

  const originIds = new Set<string>();
  for (const id of selected.facts) {
    const fact = facts.get(id);
    if (fact?.stepId) originIds.add(fact.stepId);
  }
  for (const id of selected.evidence) {
    const item = evidence.get(id);
    if (item) originIds.add(item.stepId);
    else unavailable.evidence.add(id);
  }
  const stepOrigins: StepOrigin[] = [];
  for (const origin of steps.values()) {
    if (originIds.has(origin.id) && !selected.steps.has(origin.id)) {
      stepOrigins.push({ id: origin.id, description: origin.description, status: origin.status });
    }
  }
  for (const id of originIds) {
    if (selected.steps.has(id)) continue;
    if (!steps.has(id)) unavailable.steps.add(id);
  }

  let truncatedExcerpts = 0;
  const projectedEvidence = board.evidence.filter(item => selected.evidence.has(item.id)).map(item => {
    const excerpt = item.excerpt?.slice(0, excerptLimit);
    if (item.excerpt && item.excerpt.length > excerptLimit) truncatedExcerpts++;
    return {
      id: item.id, path: item.path, sha256: item.sha256, bytes: item.bytes,
      description: item.description, stepId: item.stepId,
      ...(excerpt === undefined ? {} : { excerpt: `${excerpt}${item.excerpt!.length > excerptLimit ? "\n[excerpt truncated; inspect referenced artifact]" : ""}` }),
    };
  });

  return {
    revision: board.revision,
    project: { title: board.config.title, goal: board.config.goal, scope: board.config.scope, context: board.config.context },
    status: board.status, reason: board.reason, outcome: board.outcome,
    completedSteps: board.completedSteps, noProgressCount: board.noProgressCount,
    goals: board.goals.filter(goal => selected.goals.has(goal.id)).map(projectGoal),
    facts: board.facts.filter(fact => selected.facts.has(fact.id)).map(projectFact),
    steps: [...steps.values()].filter(step => selected.steps.has(step.id)).map(step => projectStep(step, dirname(request.runDir))),
    findings: board.findings.filter(finding => selected.findings.has(finding.id)).map(projectFinding),
    evidence: projectedEvidence,
    hints: board.hints.map(hint => ({ id: hint.id, content: hint.content, createdAt: hint.createdAt })),
    stepOrigins,
    projection: {
      mode: request.mode,
      omitted: {
        goals: board.goals.filter(item => !selected.goals.has(item.id)).length,
        facts: board.facts.filter(item => !selected.facts.has(item.id)).length,
        steps: board.steps.filter(item => !selected.steps.has(item.id)).length,
        findings: board.findings.filter(item => !selected.findings.has(item.id)).length,
        evidence: board.evidence.filter(item => !selected.evidence.has(item.id)).length,
        hints: 0,
      },
      originStepCount: stepOrigins.length, truncatedExcerpts,
      unavailableReferences: { goals: [...unavailable.goals], facts: [...unavailable.facts], steps: [...unavailable.steps], evidence: [...unavailable.evidence] },
      notice,
    },
  };
}
