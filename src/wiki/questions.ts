import type { BoardSnapshot } from "../types.js";
import { gapQueue, gapReadPath, gapSearchQuery, type GapRef } from "../knowledge/gaps.js";
import { retrieveWiki } from "./retrieval.js";
import { searchOriginals } from "./originals.js";
import { wikiGenerator } from "./format.js";
import type { RetrievalRef } from "./catalog.js";

/** Search one recorded missing prerequisite, carrying its original context and
 * the explicit provenance/corrections of candidate material back to Decide. */
export function retrieveQuestion(board: BoardSnapshot, dataDir: string, workspace: string, ref: GapRef,
  options: { query?: string; limit?: number; budgetChars?: number } = {}) {
  const question = gapQueue(board).find(item => item.stepId === ref.stepId && item.gapId === ref.gapId);
  if (!question) throw new Error("Unknown Step/gap in this task; use an exact gaps.readPath");
  const budget = options.budgetChars ?? 16000;
  if (!Number.isSafeInteger(budget) || budget < 128 || budget > 64000) throw new Error("Question budgetChars must be 128–64000");
  const query = options.query ?? gapSearchQuery(question);
  const base = { generator: wikiGenerator, type: "question_context", evidence: false, boardRevision: board.revision, questionRef: ref,
    answerSupport: "not_assessed", queryOrigin: options.query === undefined ? "step_gap" : "explicit_query", query };
  const incomplete = { ...base, complete: false, status: "budget_exhausted", readPath: gapReadPath(ref),
    notice: "Full question/source material exceeds delivery budget; increase budgetChars or narrow the query. Omitted material is not absent; no gap was resolved." };
  const questionSize = JSON.stringify({ ...base, question }).length;
  if (questionSize > budget / 2) return incomplete;
  const originals = searchOriginals(board, dataDir, workspace, query, options.limit ?? 3);
  const anchors: RetrievalRef[] = [{ kind: "step", id: ref.stepId }, ...question.sources.map(item => item.source),
    ...question.candidates.map(item => ({ kind: "capability" as const, id: item.capabilityId })),
    ...originals.hits.flatMap(hit => [{ kind: "evidence" as const, id: hit.locator.evidenceId },
      ...board.facts.filter(fact => fact.evidenceIds.includes(hit.locator.evidenceId)).map(fact => ({ kind: "fact" as const, id: fact.id }))])];
  const unique = [...new Map(anchors.map(item => [JSON.stringify(item), item])).values()];
  const sourceContext = retrieveWiki(board, dataDir, workspace, "", { anchors: unique, limit: Math.max(1, unique.length), budgetChars: Math.max(1, Math.floor((budget - questionSize) / 2)) });
  const result = { ...base, question, originals, sourceContext,
    complete: originals.complete && !sourceContext.deferredCount && !sourceContext.missingAnchors.length,
    status: "inspect_material", next: "Read matched original locators and the full sourceContext (including conditions, corrections and counterevidence). Narrow query to each remaining input. Decide may create a bounded Step with revisits or defer; resolution still requires evidence-backed Facts." };
  return JSON.stringify(result).length <= budget ? result : incomplete;
}
