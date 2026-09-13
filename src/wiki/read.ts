import type { BoardSnapshot } from "../types.js";
import { wikiDigest } from "./model.js";
import { readOriginal, searchOriginals } from "./originals.js";
import { retrieveQuestion } from "./questions.js";

export interface TaskReadContext { dataDir: string; snapshot: () => BoardSnapshot }
/** Native read destinations, scoped to the supplied task snapshot. No shell,
 * network, alternate session, or implicit research-state mutation. */
export function createTaskReader(workspace: string, context: TaskReadContext) {
  const seen = new Map<string, string>();
  return (path: string) => {
    const url = new URL(path), p = url.searchParams;
    if (url.protocol !== "xloom:" || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== "/") throw new Error("Invalid xloom read path");
    const allowed = url.hostname === "question" ? ["stepId", "gapId", "query", "limit", "budgetChars"]
      : url.hostname === "original" ? ["evidenceId", "sha256", "byteOffset", "byteLength"] : url.hostname === "search" ? ["query", "limit"] : [];
    if (!allowed.length || [...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)) throw new Error("Unknown or duplicate xloom read parameters");
    const required = (key: string) => { const value = p.get(key); if (!value) throw new Error(`Missing xloom read parameter: ${key}`); return value; };
    const number = (key: string) => { if (!p.has(key)) return undefined; const value = required(key); if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${key}`); return Number(value); };
    const board = context.snapshot();
    if (url.hostname === "original") return readOriginal(board, context.dataDir, workspace, { evidenceId: required("evidenceId"), sha256: required("sha256"), byteOffset: number("byteOffset") ?? 0, byteLength: number("byteLength") ?? 4096 });
    const result = url.hostname === "question" ? retrieveQuestion(board, context.dataDir, workspace, { stepId: required("stepId"), gapId: required("gapId") },
      { query: p.get("query") ?? undefined, limit: number("limit"), budgetChars: number("budgetChars") })
      : searchOriginals(board, context.dataDir, workspace, required("query"), number("limit"));
    const signature = wikiDigest(result), key = `${url.hostname}?${[...p].sort(([a], [b]) => a.localeCompare(b)).map(pair => JSON.stringify(pair)).join("&")}`;
    const progress = !result.complete ? "resolve_incomplete_retrieval" : seen.get(key) === signature ? "stop_repeating_query" : "inspect_material";
    if (result.complete) seen.set(key, signature);
    return { ...result, retrievalProgress: progress,
      progressNotice: progress === "stop_repeating_query" ? "Same query and current material already delivered in this run. Read its originals, narrow the missing input or obtain a new observation; repeating the query is not progress." : undefined };
  };
}
