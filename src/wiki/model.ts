import { createHash } from "node:crypto";
import { z } from "zod";
import type { BoardSnapshot, Execution } from "../types.js";
import { knowledgeRecord } from "../knowledge/model.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"), "Must not contain NUL characters");
export const wikiSourceSchema = z.object({ kind: z.enum(["goal", "step", "fact", "finding", "evidence", "attempt", "capability", "chain"]), id: text(256) }).strict();
export const wikiPagesSchema = z.array(z.object({
  id: z.string().regex(/^WK-[a-z0-9][a-z0-9_-]{0,63}$/, "Use WK- followed by lowercase letters, digits, underscores or hyphens"),
  title: text(512),
  blocks: z.array(z.object({ id: z.string().regex(/^B-[a-z0-9][a-z0-9_-]{0,63}$/), title: text(512), text: text(16_000),
    sources: z.array(wikiSourceSchema).min(1).max(64),
  }).strict()).min(1).max(32).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length, "Block IDs must be unique within a page"),
}).strict()).max(16).refine(pages => new Set(pages.map(page => page.id)).size === pages.length, "Page IDs must be unique within a submission");

export type WikiSource = z.infer<typeof wikiSourceSchema>;
export type WikiPageProposal = z.infer<typeof wikiPagesSchema>[number];
export interface WikiStamp extends WikiSource { signature: string }
export type WikiBlock = WikiPageProposal["blocks"][number] & { basis: WikiStamp[] };
export interface WikiRevision { revision: number; boardRevision: number; title: string; blocks: WikiBlock[] }
export interface WikiPage extends WikiRevision { id: string; history: WikiRevision[] }
export interface WikiIssue extends WikiSource { reason: "source_missing" | "source_changed" }
export const wikiDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (ref: WikiSource) => JSON.stringify([ref.kind, ref.id]);
const source = (kind: WikiSource["kind"], ids: string[]): WikiSource[] => ids.map(id => ({ kind, id }));

/** Explicit public records only. Runtime fields and conversation data are never
 * hashed into the author basis or copied into a Wiki page. */
export function wikiRecord(board: BoardSnapshot, ref: WikiSource): { value: object; dependencies: WikiSource[] } | undefined {
  if (ref.kind === "capability" || ref.kind === "chain") return knowledgeRecord(board, ref);
  if (ref.kind === "goal") {
    const r = board.goals.find(item => item.id === ref.id);
    return r && { value: { id: r.id, description: r.description, status: r.status, parentId: r.parentId, factIds: r.factIds }, dependencies: source("fact", r.factIds) };
  }
  if (ref.kind === "step") {
    const r = board.steps.find(item => item.id === ref.id);
    if (!r) return;
    const combination = r.combination && { requires: r.combination.requires, missing: r.combination.missing, scope: r.combination.scope,
      stateVersion: r.combination.stateVersion, expectedCapability: r.combination.expectedCapability, counterEvidence: r.combination.counterEvidence };
    return { value: { id: r.id, goalId: r.goalId, description: r.description, status: r.status, from: r.from,
      successSignal: r.successSignal, evidencePlan: r.evidencePlan, result: r.result, combination },
    dependencies: source("fact", [...r.from, ...(r.combination?.requires ?? []), ...(r.combination?.counterEvidence ?? [])]) };
  }
  if (ref.kind === "fact") {
    const r = board.facts.find(item => item.id === ref.id);
    if (!r) return;
    const replacedBy = board.facts.filter(item => item.supersedes === r.id).map(item => item.id).sort();
    const origin = board.steps.find(step => step.id === r.stepId);
    const combination = origin?.combination;
    const originConditions = origin && { from: origin.from, ...(combination ? { requires: combination.requires, missing: combination.missing,
      scope: combination.scope, stateVersion: combination.stateVersion, expectedCapability: combination.expectedCapability, counterEvidence: combination.counterEvidence } : {}) };
    const counterContexts = board.steps.filter(step => (step.from.includes(r.id) || step.combination?.requires.includes(r.id)) && step.combination?.counterEvidence?.length)
      .map(step => ({ stepId: step.id, scope: step.combination!.scope, stateVersion: step.combination!.stateVersion, counterEvidence: step.combination!.counterEvidence! }));
    const attempts = (board.attempts ?? []).filter(item => item.evidenceIds.some(id => r.evidenceIds.includes(id))).map(item => item.id).sort();
    return { value: { id: r.id, description: r.description, stepId: r.stepId, evidenceIds: r.evidenceIds, supersedes: r.supersedes, replacedBy, originConditions, counterContexts, attempts },
      dependencies: [...source("evidence", r.evidenceIds), ...source("fact", [...replacedBy, ...(r.supersedes ? [r.supersedes] : []),
        ...(origin?.from ?? []), ...(combination?.requires ?? []), ...(combination?.counterEvidence ?? []), ...counterContexts.flatMap(item => item.counterEvidence)]), ...source("attempt", attempts)] };
  }
  if (ref.kind === "finding") {
    const r = board.findings.find(item => item.id === ref.id);
    if (!r) return;
    const attempts = (board.attempts ?? []).filter(item => item.hypothesis.trim().toLowerCase() === r.key.trim().toLowerCase() || item.evidenceIds.some(id => r.evidenceIds.includes(id))).map(item => item.id).sort();
    const impact = r.impact && { capability: r.impact.capability, object: r.impact.object, result: r.impact.result, scope: r.impact.scope, prerequisites: r.impact.prerequisites };
    return { value: { id: r.id, key: r.key, title: r.title, target: r.target, status: r.status, rating: r.rating, factIds: r.factIds,
      evidenceIds: r.evidenceIds, next: r.next, review: r.review, impact, pocEvidenceId: r.pocEvidenceId, attempts },
    dependencies: [...source("fact", r.factIds), ...source("evidence", [...r.evidenceIds, ...(r.pocEvidenceId ? [r.pocEvidenceId] : [])]), ...source("attempt", attempts)] };
  }
  if (ref.kind === "evidence") {
    const r = board.evidence.find(item => item.id === ref.id);
    return r && { value: { id: r.id, stepId: r.stepId, path: r.path, pathBase: r.pathBase, sha256: r.sha256, bytes: r.bytes, description: r.description }, dependencies: [] };
  }
  const r = board.attempts?.find(item => item.id === ref.id);
  return r && { value: { id: r.id, stepId: r.stepId, hypothesis: r.hypothesis, scope: r.scope, identity: r.identity, stateVersion: r.stateVersion,
    baseline: r.baseline, changedVariable: r.changedVariable, outcome: r.outcome, observation: r.observation, evidenceIds: r.evidenceIds }, dependencies: source("evidence", r.evidenceIds) };
}

export function wikiBasis(board: BoardSnapshot, roots: WikiSource[]): WikiStamp[] {
  const queue = [...roots];
  const found = new Map<string, WikiStamp>();
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i]!;
    if (found.has(key(ref))) continue;
    const record = wikiRecord(board, ref);
    if (!record) throw new Error(`Unknown Wiki source: ${ref.kind} ${JSON.stringify(ref.id)}. Use committed IDs or this batch's fact/evidence refs`);
    found.set(key(ref), { kind: ref.kind, id: ref.id, signature: wikiDigest(record.value) });
    queue.push(...record.dependencies);
  }
  return [...found.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Preflight even before new batch IDs exist; Store resolves and seals the same
 * sources after committing their records in its transaction. */
export function validateWikiReferences(board: BoardSnapshot, output: Execution): void {
  const local = { fact: new Set(output.facts?.map(item => item.ref)), evidence: new Set(output.evidence?.map(item => item.ref)),
    capability: new Set(output.capabilities?.map(item => item.id)), chain: new Set(output.chains?.map(item => item.id)) };
  const errors: string[] = [];
  output.wikiPages?.forEach((page, p) => page.blocks.forEach((block, b) => block.sources.forEach((ref, s) => {
    if ((ref.kind === "fact" || ref.kind === "evidence" || ref.kind === "capability" || ref.kind === "chain") && local[ref.kind].has(ref.id)) return;
    if (!wikiRecord(board, ref)) errors.push(`wikiPages[${p}].blocks[${b}].sources[${s}]: Unknown ${ref.kind} ${JSON.stringify(ref.id)}`);
  })));
  if (errors.length) throw new Error(`${errors.join("; ")}. Wiki sources must belong to this task. Use exact committed IDs or this batch's fact/evidence refs; omit unsupported blocks instead of inventing sources.`);
}

export function applyWikiPages(board: BoardSnapshot, proposals: WikiPageProposal[], resolve: (ref: WikiSource) => WikiSource,
  verify: (evidenceId: string) => void): void {
  if (!proposals.length) return;
  const pages = board.wikiPages ??= [];
  for (const proposal of proposals) {
    const previous = pages.find(page => page.id === proposal.id);
    const blocks: WikiBlock[] = proposal.blocks.map(block => {
      const sources = [...new Map(block.sources.map(ref => { const resolved = resolve(ref); return [key(resolved), resolved]; })).values()];
      const basis = wikiBasis(board, sources);
      for (const ref of basis) if (ref.kind === "evidence") verify(ref.id);
      return { id: block.id, title: block.title, text: block.text, sources, basis };
    });
    if (previous && wikiDigest([previous.title, previous.blocks]) === wikiDigest([proposal.title, blocks])) continue;
    const history = previous ? [...previous.history, { revision: previous.revision, boardRevision: previous.boardRevision,
      title: previous.title, blocks: previous.blocks }] : [];
    const page: WikiPage = { id: proposal.id, title: proposal.title, blocks, revision: (previous?.revision ?? 0) + 1, boardRevision: board.revision + 1, history };
    if (previous) pages[pages.indexOf(previous)] = page;
    else pages.push(page);
  }
}

/** Review flags describe recorded-source changes, not file integrity or whether
 * an author's interpretation is true. Re-reading alone never clears them. */
export function wikiIssues(board: BoardSnapshot, page: WikiRevision): (WikiIssue & { blockId: string })[] {
  const issues: (WikiIssue & { blockId: string })[] = [];
  for (const block of page.blocks) for (const ref of block.basis) {
    const current = wikiRecord(board, ref);
    if (!current || wikiDigest(current.value) !== ref.signature) issues.push({ blockId: block.id, kind: ref.kind, id: ref.id, reason: current ? "source_changed" : "source_missing" });
  }
  return issues;
}
