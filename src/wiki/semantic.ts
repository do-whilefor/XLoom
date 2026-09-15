import { z } from "zod";
import { gapQueue, gapSearchGroups, gapSearchQuery } from "../knowledge/gaps.js";
import { cachedEntries, cachedEntry, pruneEntries, putEntry, removeEntry, withIndexCache } from "./cache.js";
import { refKey, terms, type RetrievalDocument, type RetrievalIndex, type RetrievalRef } from "./catalog.js";
import { incrementalRetrievalIndex, retrievalInputSignature } from "./incremental.js";
import { wikiDigest } from "./model.js";
import { searchOriginals } from "./originals.js";
import { retrieveWiki } from "./retrieval.js";
import { compileQueryGroups, type QueryGroup } from "./search-groups.js";
import type { TaskReadContext, createTaskReader } from "./read.js";
import type { SearchEnhancement } from "./query.js";

export interface SemanticModel {
  /** Provider/model/endpoint/protocol identity, without credentials. */
  identity: string;
  generate(stage: "index" | "expand" | "rerank", input: unknown, signal?: AbortSignal): Promise<unknown>;
}
const hintSchema = z.array(z.string().trim().min(1).max(512)).min(1).max(6);
const indexingSchema = z.object({ documents: z.array(z.object({ id: z.string(), queries: hintSchema }).strict()).min(1).max(8) }).strict();
const expansionSchema = z.object({ groups: z.array(z.object({ id: z.string(), queries: z.array(z.string().trim().min(1).max(512)).max(4) }).strict()).min(1).max(9) }).strict();
const rankingSchema = z.object({ scores: z.array(z.object({ id: z.string(), score: z.number().finite().min(0).max(100) }).strict()).max(12) }).strict();
const protocol = "semantic-retrieval-v2";
type Counters = { requests: number; cacheHits: number; indexedDocuments: number; reusedDocuments: number };

function closure(ref: RetrievalRef, documents: Map<string, RetrievalDocument>): RetrievalDocument[] {
  const pending = [ref], sources = new Map<string, RetrievalDocument>();
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const key = refKey(pending[cursor]!), doc = documents.get(key);
    if (!doc || sources.has(key)) continue;
    sources.set(key, doc); pending.push(...doc.sources, ...doc.requiredBlocks ?? []);
  }
  return [...sources.values()];
}

/** One durable hint entry per Wiki judgment and full source basis. Metadata-only
 * author edits remain author edits: generated questions live solely in cache. */
async function enrichIndex(index: RetrievalIndex, context: TaskReadContext, workspace: string, model: SemanticModel,
  refresh: boolean, signal: AbortSignal | undefined, counters: Counters): Promise<RetrievalIndex> {
  const docs = new Map(index.documents.map(doc => [refKey(doc.ref), doc]));
  const entries = index.documents.filter(doc => doc.ref.kind === "block").map((doc, i) => {
    const records = closure(doc.ref, docs);
    return { id: `H${i}`, key: refKey(doc.ref), records, signature: wikiDigest([protocol, model.identity, records]) };
  });
  if (!entries.length) return index;
  const previous = withIndexCache(context.dataDir, workspace, db => cachedEntries<string[]>(db, "semantic-doc"));
  const hints: Record<string, string[]> = Object.create(null), pending: typeof entries = [];
  for (const entry of entries) {
    const cached = previous.get(entry.key), value = hintSchema.safeParse(cached?.value);
    if (!refresh && cached?.signature === entry.signature && value.success) { hints[entry.key] = value.data; counters.reusedDocuments++; }
    else pending.push(entry);
  }
  const batches: typeof entries[] = []; let batch: typeof entries = [], chars = 0;
  for (const entry of pending) {
    const size = JSON.stringify(entry.records).length;
    if (batch.length && (batch.length >= 8 || chars + size > 48000)) { batches.push(batch); batch = []; chars = 0; }
    batch.push(entry); chars += size;
  }
  if (batch.length) batches.push(batch);
  const generate = async (batch: typeof entries) => {
    signal?.throwIfAborted(); counters.requests++;
    const result = indexingSchema.parse(await model.generate("index", { documents: batch.map(({ id, records }) => ({ id, records })) }, signal));
    const ids = new Set(batch.map(entry => entry.id));
    if (result.documents.length !== ids.size || new Set(result.documents.map(entry => entry.id)).size !== ids.size || result.documents.some(entry => !ids.has(entry.id))) throw new Error("Invalid indexed document IDs");
    signal?.throwIfAborted();
    withIndexCache(context.dataDir, workspace, db => {
      for (const entry of batch) {
        const queries = result.documents.find(value => value.id === entry.id)!.queries;
        hints[entry.key] = queries; putEntry(db, "semantic-doc", entry.key, entry.signature, queries, []);
      }
    });
    counters.indexedDocuments += batch.length;
  };
  for (let i = 0; i < batches.length; i += 2) {
    const results = await Promise.allSettled(batches.slice(i, i + 2).map(generate));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  withIndexCache(context.dataDir, workspace, db => pruneEntries(db, "semantic-doc", new Set(entries.map(entry => entry.key))));
  const postings = { ...index.postings }, lengths = [...index.lengths];
  index.documents.forEach((doc, i) => {
    const counts = new Map<string, number>();
    for (const word of terms((hints[refKey(doc.ref)] ?? []).join(" "))) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const [word, count] of counts) {
      const values: [number, number][] = (postings[word] ?? []).map(([id, n]) => [id, n]);
      const existing = values.find(value => value[0] === i);
      if (existing) existing[1] += count; else values.push([i, count]);
      postings[word] = values; lengths[i]! += count;
    }
  });
  return { ...index, postings, lengths, semanticHints: hints, signature: wikiDigest([index.signature, hints]) };
}

/** Derived query/ranking hints only. No source text, evidence verdict, author
 * review or generated answer is persisted here. Disk failures recompute. */
async function memo<T>(context: TaskReadContext, workspace: string, model: SemanticModel, stage: "expand" | "rerank", input: unknown,
  parse: (value: unknown) => T, refresh: boolean, signal: AbortSignal | undefined, counters: { requests: number; cacheHits: number }) {
  const key = wikiDigest([protocol, model.identity, stage, input]);
  if (!refresh) {
    const cached = withIndexCache(context.dataDir, workspace, db => {
      const entry = cachedEntry<unknown>(db, "semantic", key);
      return entry?.signature === key ? parse(entry.value) : undefined;
    });
    if (cached !== undefined) { counters.cacheHits++; return cached; }
  }
  signal?.throwIfAborted(); counters.requests++;
  const value = parse(await model.generate(stage, input, signal));
  signal?.throwIfAborted();
  withIndexCache(context.dataDir, workspace, db => {
    putEntry(db, "semantic", key, key, value, []);
    // Bound abandoned query/corpus/model generations. No authoritative rows.
    for (const row of db.prepare("SELECT key FROM entries WHERE namespace='semantic' ORDER BY rowid DESC LIMIT -1 OFFSET 512").all()) removeEntry(db, "semantic", String(row.key));
  });
  return value;
}

/** Uses the same native reader for delivery and its receipt/reading accounting.
 * Candidate collection is internal and never acknowledges unseen material. */
export function createSemanticTaskReader(workspace: string, context: TaskReadContext, read: ReturnType<typeof createTaskReader>) {
  return async (path: string, signal?: AbortSignal): Promise<object> => {
    const url = new URL(path), p = url.searchParams;
    const strategy = p.get("strategy");
    if (strategy === null) return read(path);
    if (p.getAll("strategy").length !== 1 || !["lexical", "semantic"].includes(strategy)) throw new Error("Search strategy must be lexical or semantic");
    if (!["search", "question"].includes(url.hostname)) throw new Error("strategy is supported only for search/question");
    p.delete("strategy");
    if (strategy === "lexical") return read(url.href);
    const allowed = url.hostname === "search" ? ["query", "mode", "limit", "budgetChars", "refresh"] : ["stepId", "gapId", "query", "limit", "budgetChars", "refresh"];
    if (url.protocol !== "xloom:" || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== "/"
      || [...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)) throw new Error("Invalid semantic search parameters");
    const numeric = (key: string, fallback: number, min: number, max: number) => {
      const raw = p.get(key), value = raw === null ? fallback : Number(raw);
      if (raw !== null && !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid semantic ${key}`);
      return value;
    };
    const budget = numeric("budgetChars", 16000, url.hostname === "search" ? 1024 : 128, 64000);
    numeric("limit", 3, 1, 20);
    if (p.has("refresh") && !["true", "false"].includes(p.get("refresh")!)) throw new Error("refresh must be true or false");
    const refresh = p.get("refresh") === "true", mode = p.get("mode") ?? "originals";
    if (!["wiki", "originals", "combined"].includes(mode)) throw new Error("Search mode must be wiki, originals or combined");
    const board = context.snapshot(), signature = retrievalInputSignature(board);
    const gap = url.hostname === "question" ? gapQueue(board).find(gap => gap.stepId === p.get("stepId") && gap.gapId === p.get("gapId")) : undefined;
    if (url.hostname === "question" && !gap) throw new Error("Unknown Step/gap in this task");
    const query = p.get("query") ?? (gap ? gapSearchQuery(gap) : "");
    if (!query.trim() || query.length > 4000 || url.hostname === "search" && query.length > 2048) throw new Error("Invalid semantic query length");
    const next = new URL(path); next.searchParams.set("budgetChars", "64000");
    if (budget < 2048) return { type: url.hostname === "question" ? "question_context" : "task_search", evidence: false, complete: false, status: "budget_exhausted", nextReadPath: next.href };
    if (url.hostname === "search" && !p.has("mode")) p.set("mode", mode);
    p.set("budgetChars", String(budget));
    const model = context.semantic, counters: Counters = { requests: 0, cacheHits: 0, indexedDocuments: 0, reusedDocuments: 0 };
    const deliver = (enhancement: SearchEnhancement, status: string) => {
      const output = read(url.href, { ...enhancement, semantic: { status, ...counters, notice: "Model retrieval hints and relevance ordering only; read current sources and original conditions. No semantic equivalence, evidence validity or gap resolution is asserted." } });
      // Continuations must retain the requested strategy, not silently revert.
      if ("nextReadPath" in output && typeof output.nextReadPath === "string") {
        const next = new URL(output.nextReadPath); next.searchParams.set("strategy", "semantic"); output.nextReadPath = next.href;
      }
      return output;
    };
    if (!model) return deliver({}, "unavailable_lexical_fallback");
    try {
      const groups: QueryGroup[] = (gap && !p.has("query") ? gapSearchGroups(gap) : undefined) ?? [{ id: "query", alternatives: [query] }];
      const expanded = await memo(context, workspace, model, "expand", { query, groups }, value => {
        const result = expansionSchema.parse(value);
        if (result.groups.length !== groups.length || new Set(result.groups.map(group => group.id)).size !== groups.length
          || result.groups.some(group => !groups.some(expected => expected.id === group.id))) throw new Error("Invalid expanded group IDs");
        return result;
      }, refresh, signal, counters);
      const queryGroups = groups.map(group => ({ id: group.id, alternatives: [...new Set([...group.alternatives,
        ...expanded.groups.find(item => item.id === group.id)!.queries])].slice(0, 10) }));
      compileQueryGroups(query, queryGroups);
      const index = await enrichIndex(incrementalRetrievalIndex(board, context.dataDir, workspace).index, context, workspace, model, refresh, signal, counters);
      const lexical = retrieveWiki(board, context.dataDir, workspace, query, { queryGroups, limit: 40 }, index);
      const originals = url.hostname === "search" && mode === "wiki" ? undefined : searchOriginals(board, context.dataDir, workspace, query, 20, refresh, queryGroups);
      const refs = new Map<string, RetrievalRef>();
      for (const hit of lexical.hits) refs.set(refKey(hit.ref), hit.ref);
      for (const hit of originals?.hits ?? []) { const ref = { kind: "evidence" as const, id: hit.locator.evidenceId }; refs.set(refKey(ref), ref); }
      const documents = new Map(index.documents.map(doc => [refKey(doc.ref), doc]));
      const candidates = [...refs.values()].map((ref, i) => {
        return { id: `C${i}`, ref, records: closure(ref, documents), originals: (originals?.hits ?? []).filter(hit => hit.locator.evidenceId === ref.id)
          .map(hit => ({ locator: hit.locator, snippet: hit.snippet })) };
      });
      const scores = new Map<string, number>();
      // Complete judgments/source closures are never truncated to fit a batch.
      const batches: typeof candidates[] = []; let batch: typeof candidates = [], chars = 0;
      for (const candidate of candidates) {
        const size = JSON.stringify(candidate).length;
        if (batch.length && (batch.length >= 8 || chars + size > 48000)) { batches.push(batch); batch = []; chars = 0; }
        batch.push(candidate); chars += size;
      }
      if (batch.length) batches.push(batch);
      const rankBatch = async (candidates: typeof batch) => {
        const ranked = await memo(context, workspace, model, "rerank", { query, groups, corpusSignature: index.signature, candidates }, value => {
          const result = rankingSchema.parse(value), ids = new Set(candidates.map(item => item.id));
          if (result.scores.length !== ids.size || new Set(result.scores.map(item => item.id)).size !== ids.size || result.scores.some(item => !ids.has(item.id))) throw new Error("Invalid ranking references");
          return result;
        }, refresh, signal, counters);
        ranked.scores.forEach(item => scores.set(item.id, item.score));
      };
      for (let i = 0; i < batches.length; i += 2) {
        // Complete all started requests before fallback/cancellation is returned;
        // usage must not continue changing after the owning read has finished.
        const results = await Promise.allSettled(batches.slice(i, i + 2).map(rankBatch));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      signal?.throwIfAborted();
      if (retrievalInputSignature(context.snapshot()) !== signature) return deliver({}, "sources_changed_lexical_fallback");
      candidates.sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
      const preferredRefs = candidates.map(item => item.ref), preferredOriginals = preferredRefs.filter(ref => ref.kind === "evidence").map(ref => ref.id);
      return deliver({ queryGroups, preferredRefs, preferredOriginals, index }, "applied");
    } catch {
      signal?.throwIfAborted();
      return deliver({}, "failed_lexical_fallback");
    }
  };
}
