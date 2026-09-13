import { z } from "zod";
import type { BoardSnapshot, Decision, Execution, Step } from "../types.js";
import { capabilityIssues } from "./model.js";
import { compareConditions, conditionsSchema, portSchema, portsMatch } from "./schema.js";
import { wikiBasis, wikiDigest, wikiRecord, type WikiSource } from "../wiki/model.js";

const text = (max = 2048) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"), "Must not contain NUL");
const sourceSchema = z.object({ kind: z.enum(["fact", "evidence", "capability", "chain"]), id: text(256) }).strict();
const gapRef = z.object({ stepId: text(256), gapId: text(64) }).strict();
export const gapSchema = z.object({ id: z.string().regex(/^gap-[a-z0-9][a-z0-9_-]{0,59}$/),
  missing: text(), why: text(), reopenWhen: text(), needs: z.array(portSchema).max(8), conditions: conditionsSchema,
  capabilityId: z.string().regex(/^C-[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
}).strict();
export const gapsSchema = z.array(gapSchema).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length, "Duplicate gap ID");
export const gapLinksSchema = z.array(gapRef.extend({ sources: z.array(sourceSchema).min(1).max(32), reason: text() }).strict()).max(32);
export const revisitsSchema = z.array(gapRef).min(1).max(16);
export const gapReviewsSchema = z.array(gapRef.extend({ action: z.enum(["defer", "resolve"]), reason: text(), factIds: z.array(text(256)).max(64) }).strict()).max(32);
export type GapProposal = z.infer<typeof gapSchema>;
export type GapRef = z.infer<typeof gapRef>;
export function gapReadPath(ref: GapRef): string { return `xloom://question?${new URLSearchParams({ stepId: ref.stepId, gapId: ref.gapId })}`; }
export function gapSearchQuery(gap: Pick<GapProposal, "missing" | "needs">): string {
  const expanded = [gap.missing, ...gap.needs.map(need => [need.type, need.description, ...need.aliases].join(" "))].join(" ");
  // Keep the whole missing-input question if all aliases would overfill a query.
  // Full needs/conditions remain in the question package for focused follow-ups.
  return expanded.length <= 4000 ? expanded : gap.missing;
}
export interface Gap extends GapProposal {
  sources: { source: z.infer<typeof sourceSchema>; reason: string }[];
  review?: { signature: string; action: "defer" | "resolve" | "plan"; reason: string; factIds: string[]; stepIds: string[]; revision: number };
}
const refKey = (ref: GapRef) => `${ref.stepId}/${ref.gapId}`;
function findGap(board: BoardSnapshot, ref: GapRef): Gap {
  const gap = board.steps.find(step => step.id === ref.stepId)?.gaps?.find(item => item.id === ref.gapId);
  if (!gap) throw new Error(`Unknown gap: ${refKey(ref)}. Copy the committed Step ID and gap ID.`);
  return gap;
}

/** Gaps annotate the original Step. Source associations are leads, not evidence. */
export function applyGapRecords(board: BoardSnapshot, step: Step, output: Execution, resolve: (ref: WikiSource) => WikiSource): void {
  for (const proposal of output.gaps ?? []) {
    if (proposal.capabilityId && !board.capabilities?.some(item => item.id === proposal.capabilityId)) throw new Error("Unknown gap capabilityId");
    const gaps = step.gaps ??= [], old = gaps.find(gap => gap.id === proposal.id);
    if (old) {
      // A stable ID retains its meaning. Changed requirements need another ID;
      // additional sources belong in gapLinks, not an overwritten old question.
      const { sources: _sources, review: _review, ...fields } = old;
      if (wikiDigest(fields) !== wikiDigest(proposal)) throw new Error("A gap ID cannot be reused for different requirements.");
    } else gaps.push({ ...proposal, sources: [] });
  }
  for (const link of output.gapLinks ?? []) {
    const gap = findGap(board, link);
    for (const ref of link.sources) {
      const source = resolve(ref) as typeof ref;
      if (!wikiRecord(board, source)) throw new Error(`Unknown gap source: ${source.kind} ${source.id}`);
      if (!gap.sources.some(item => item.source.kind === source.kind && item.source.id === source.id)) gap.sources.push({ source, reason: link.reason });
    }
  }
  for (const ref of step.revisits ?? []) {
    const gap = findGap(board, ref);
    for (const fact of output.facts ?? []) {
      const source = resolve({ kind: "fact", id: fact.ref }) as { kind: "fact"; id: string };
      if (!gap.sources.some(item => item.source.kind === source.kind && item.source.id === source.id)) gap.sources.push({ source, reason: `Observation from revisit Step ${step.id}; applicability still requires review.` });
    }
  }
}

export function gapQueue(board: BoardSnapshot) {
  return board.steps.flatMap(step => (step.gaps ?? []).map(gap => {
    const candidates = (board.capabilities ?? []).flatMap(capability => {
      if (capability.id === gap.capabilityId) return [];
      const needs = gap.needs.flatMap((need, index) => capability.provides.some(port => portsMatch(port, need)) ? [index] : []);
      if (!needs.length) return [];
      const conditions = compareConditions([gap.conditions, capability.conditions]);
      return [{ capabilityId: capability.id, needIndices: needs, status: capability.status, conditions,
        reviewIssues: capabilityIssues(board, capability), factIds: capability.factIds }];
    });
    const roots: WikiSource[] = [...gap.sources.map(item => item.source), ...candidates.map(item => ({ kind: "capability" as const, id: item.capabilityId })),
      ...(gap.capabilityId ? [{ kind: "capability" as const, id: gap.capabilityId }] : []),
      ...(gap.review?.factIds ?? []).map(id => ({ kind: "fact" as const, id }))];
    // Include missing refs explicitly so loss of a source also reopens review.
    const sourceState = roots.map(ref => {
      try { return { ref, basis: wikiBasis(board, [ref]) }; }
      catch { return { ref, missing: true }; }
    }).sort((a, b) => JSON.stringify(a.ref).localeCompare(JSON.stringify(b.ref)));
    const { sources: _sources, review: _review, ...requirements } = gap;
    const revisitState = (gap.review?.stepIds ?? []).map(id => {
      const step = board.steps.find(item => item.id === id);
      return { id, status: step && ["ready", "claimed"].includes(step.status) ? "pending" : step?.status ?? "missing" };
    });
    const signature = wikiDigest([requirements, sourceState, revisitState]);
    const changed = gap.review?.signature !== signature;
    const active = board.goals.some(goal => goal.id === step.goalId && goal.status === "active");
    const viable = candidates.filter(item => item.status !== "unavailable" && !item.reviewIssues.length && item.conditions.status !== "conflict");
    const reviewed = !changed && gap.review;
    return { stepId: step.id, gapId: gap.id, goalId: step.goalId, originalStatus: step.status, missing: gap.missing, why: gap.why,
      reopenWhen: gap.reopenWhen, needs: gap.needs, conditions: gap.conditions, capabilityId: gap.capabilityId,
      sources: gap.sources, candidates, signature, active,
      state: reviewed ? reviewed.action === "resolve" ? "resolved" : reviewed.action === "plan" ? "planned" : "waiting" : "review_required",
      reason: changed && gap.review ? "sources_changed" : gap.review ? "reviewed" : "unreviewed_gap",
      candidateNeedIndices: [...new Set(viable.flatMap(item => item.needIndices))],
      review: gap.review, evidence: false as const };
  })).sort((a, b) => Number(b.active && b.state === "review_required") - Number(a.active && a.state === "review_required") || a.stepId.localeCompare(b.stepId) || a.gapId.localeCompare(b.gapId));
}

/** Only Decide records a disposition or creates a new bounded Step. */
export function applyGapDecision(board: BoardSnapshot, decision: Decision, newSteps: Step[], verify: (id: string) => void): void {
  const seen = new Set<string>();
  const review = (ref: GapRef, action: "plan" | "defer" | "resolve", reason: string, factIds: string[], stepIds: string[]) => {
    if (seen.has(refKey(ref))) throw new Error("Review each gap only once per decision.");
    seen.add(refKey(ref));
    const gap = findGap(board, ref);
    for (const id of factIds) {
      const fact = board.facts.find(item => item.id === id);
      if (!fact?.evidenceIds.length || board.facts.some(item => item.supersedes === id)) throw new Error("Gap resolution requires current evidence-backed Facts.");
      fact.evidenceIds.forEach(verify);
    }
    if (action === "resolve" && !factIds.length) throw new Error("Gap resolution requires evidence-backed Facts and a reason, not a matching capability.");
    gap.review = { action, reason, factIds, stepIds, revision: board.revision + 1, signature: "" };
    // Seal after adding supporting Facts so later corrections re-open the gap.
    gap.review.signature = gapQueue(board).find(item => refKey(item) === refKey(ref))!.signature;
  };
  for (const item of decision.gapReviews ?? []) review(item, item.action, item.reason, item.factIds, []);
  const plans = new Map<string, { ref: GapRef; steps: Step[] }>();
  for (const step of newSteps) for (const ref of step.revisits ?? []) {
    const origin = board.steps.find(item => item.id === ref.stepId);
    if (origin?.goalId !== step.goalId) throw new Error(`A revisit must retain the original gap's Goal. For ${refKey(ref)}, expected goalId=${JSON.stringify(origin?.goalId)}, received ${JSON.stringify(step.goalId)}. Do not move this revisit to a new child Goal; plan different Goals in separate Steps.`);
    const plan = plans.get(refKey(ref)) ?? { ref, steps: [] };
    plan.steps.push(step); plans.set(refKey(ref), plan);
  }
  for (const { ref, steps } of plans.values()) review(ref, "plan", steps.map(item => item.description).join("\n"), [], steps.map(item => item.id));
}

export function gapContext(board: BoardSnapshot, assigned?: Step) {
  const queue = gapQueue(board), selected = assigned ? new Set((assigned.revisits ?? []).map(refKey)) : undefined;
  const ordered = selected ? queue.sort((a, b) => Number(selected.has(refKey(b))) - Number(selected.has(refKey(a)))) : queue;
  let used = 0;
  const deferred: GapRef[] = [];
  const items = ordered.filter(item => {
    const size = JSON.stringify({ ...item, readPath: gapReadPath(item) }).length;
    if (used + size > 12000) { deferred.push({ stepId: item.stepId, gapId: item.gapId }); return false; }
    used += size; return true;
  }).map(item => ({ ...item, readPath: gapReadPath(item) }));
  return { items, deferred,
    recording: "Execute may submit gaps:[{id:gap-name,missing,why,reopenWhen,needs:[{type,aliases,description}],conditions:{scope,identity,environment,stateVersion},capabilityId?}] on assignedStep. Unknown condition values are null. Empty needs means explicit source links only. gapLinks:[{stepId,gapId,sources:[{kind:fact|evidence|capability|chain,id}],reason}] associates new material using exact IDs or same-batch refs. Revisit Facts are linked automatically. Reuse a gap ID only with identical requirements. See knowledge.authoringGuide.",
    notice: "Step-local gaps. Review changed sources and originals, then create bounded steps with revisits:[{stepId,gapId}], or gapReviews:[{stepId,gapId,action:defer|resolve,reason,factIds}]. Each revisit Step must copy the original gap's goalId unchanged, not a new child Goal. Use separate Steps for gaps under different Goals. Resolve requires demonstrated Facts. Candidates/unknown conditions are not proof; old Step status is unchanged. Deferred entries remain in the blackboard and local gaps command." };
}
