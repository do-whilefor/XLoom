import type { BoardSnapshot } from "../types.js";
import { wikiDigest } from "./model.js";
import { readOriginal, searchOriginals } from "./originals.js";
import { retrieveQuestion } from "./questions.js";
import { planningMaterials } from "./materials.js";
import { retrieveWiki } from "./retrieval.js";
import { refKey, retrievalDocuments, type RetrievalRef } from "./catalog.js";
import { readDiscovery, searchTask } from "./query.js";

export interface TaskReadContext {
  dataDir: string; snapshot: () => BoardSnapshot; materialBaseline?: Record<string, string>;
  onAnnounced?: (items: { key: string; signature: string }[]) => void;
}
/** Native read destinations, scoped to the supplied task snapshot. No shell,
 * network, alternate session, or implicit research-state mutation. */
export function createTaskReader(workspace: string, context: TaskReadContext) {
  const seen = new Map<string, string>();
  const baseline = { ...context.materialBaseline };
  const announce = (items: { key: string; signature: string }[]) => {
    for (const item of items) baseline[item.key] = item.signature;
    context.onAnnounced?.(items);
  };
  return (path: string) => {
    const url = new URL(path), p = url.searchParams;
    if (url.protocol !== "xloom:" || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== "/") throw new Error("Invalid xloom read path");
    const allowed = url.hostname === "question" ? ["stepId", "gapId", "query", "limit", "budgetChars", "refresh"]
      : url.hostname === "materials" ? ["budgetChars", "refresh"] : url.hostname === "record" ? ["kind", "id", "page", "budgetChars"]
      : url.hostname === "original" ? ["evidenceId", "sha256", "byteOffset", "byteLength"]
      : url.hostname === "discover" ? ["consumerId", "limit", "maxAlternatives", "budgetChars"]
      : url.hostname === "search" ? ["query", "limit", "refresh", "mode", "budgetChars"] : [];
    if (!allowed.length || [...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)) throw new Error("Unknown or duplicate xloom read parameters");
    const required = (key: string) => { const value = p.get(key); if (!value) throw new Error(`Missing xloom read parameter: ${key}`); return value; };
    const number = (key: string) => { if (!p.has(key)) return undefined; const value = required(key); if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${key}`); return Number(value); };
    const board = context.snapshot();
    if (p.has("refresh") && !["true", "false"].includes(required("refresh"))) throw new Error("refresh must be true or false");
    const refresh = p.get("refresh") === "true";
    if (url.hostname === "materials") {
      const result = planningMaterials(board, refresh ? {} : baseline, context.dataDir, workspace, number("budgetChars") ?? 6000);
      announce(result.items);
      return result;
    }
    if (url.hostname === "record") {
      const kind = required("kind"), id = required("id"), pageId = p.get("page") ?? undefined;
      if (!["goal", "step", "fact", "finding", "evidence", "attempt", "capability", "chain", "block"].includes(kind) || (kind === "block") !== Boolean(pageId)) throw new Error("Invalid exact record reference");
      const ref = { kind: kind as RetrievalRef["kind"], id, ...(pageId ? { pageId } : {}) };
      const anchors: RetrievalRef[] = [ref, ...(kind === "evidence" ? board.facts.filter(fact => fact.evidenceIds.includes(id)).map(fact => ({ kind: "fact" as const, id: fact.id })) : [])];
      const budgetChars = number("budgetChars") ?? 16000;
      if (budgetChars < 1024 || budgetChars > 64000) throw new Error("Record budgetChars must be 1024–64000");
      const result = retrieveWiki(board, context.dataDir, workspace, "", { anchors, limit: anchors.length, budgetChars: Math.max(1, budgetChars - 1024) });
      const complete = !result.deferredCount && !result.missingAnchors.length;
      const packet = { ...result, complete, readPath: path, next: "Read original ranges and preserve source conditions/corrections. A delivered record is not a reviewed or resolved gap." };
      if (JSON.stringify(packet).length > budgetChars) return { type: "retrieval", evidence: false, complete: false, status: "budget_exhausted",
        hits: [], records: [], deferredCount: anchors.length, next: "Increase record budgetChars (up to 64000); no source package was delivered." };
      if (complete) {
        const keys = new Set(anchors.map(refKey));
        announce(retrievalDocuments(board).documents.filter(doc => keys.has(refKey(doc.ref)))
          .map(doc => ({ key: refKey(doc.ref), signature: wikiDigest(doc) })));
      }
      return packet;
    }
    if (url.hostname === "original") return readOriginal(board, context.dataDir, workspace, { evidenceId: required("evidenceId"), sha256: required("sha256"), byteOffset: number("byteOffset") ?? 0, byteLength: number("byteLength") ?? 4096 });
    const result = url.hostname === "question" ? retrieveQuestion(board, context.dataDir, workspace, { stepId: required("stepId"), gapId: required("gapId") },
      { query: p.get("query") ?? undefined, limit: number("limit"), budgetChars: number("budgetChars"), refresh })
      : url.hostname === "discover" ? readDiscovery(board, context.dataDir, workspace,
        { consumerId: p.has("consumerId") ? required("consumerId") : undefined, limit: number("limit"), maxAlternatives: number("maxAlternatives"), budgetChars: number("budgetChars") })
      : p.has("mode") || p.has("budgetChars") ? searchTask(board, context.dataDir, workspace, required("query"),
        { mode: p.has("mode") ? required("mode") : "originals", limit: number("limit"), budgetChars: number("budgetChars"), refresh })
      : searchOriginals(board, context.dataDir, workspace, required("query"), number("limit"), refresh);
    // Cache work counters change between cold/warm reads, not source material.
    const signature = wikiDigest(JSON.parse(JSON.stringify(result, (key, value) => key === "index" && value?.storage ? undefined : value)));
    const key = `${url.hostname}?${[...p].filter(([key]) => key !== "refresh").sort(([a], [b]) => a.localeCompare(b)).map(pair => JSON.stringify(pair)).join("&")}`;
    const progress = !result.complete ? "resolve_incomplete_retrieval" : seen.get(key) === signature ? "stop_repeating_query" : "inspect_material";
    if (result.complete) seen.set(key, signature);
    return { ...result, retrievalProgress: progress,
      progressNotice: progress === "stop_repeating_query" ? "Same query and current material already delivered in this run. Read its originals, narrow the missing input or obtain a new observation; repeating the query is not progress." : undefined };
  };
}
