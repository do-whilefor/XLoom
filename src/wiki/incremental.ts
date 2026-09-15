import type { BoardSnapshot } from "../types.js";
import { resolve } from "node:path";
import { refKey, retrievalDocuments, terms, type RetrievalIndex } from "./catalog.js";
import { cachedEntries, indexStats, pruneEntries, putEntry, retrievalCacheStamp, withIndexCache } from "./cache.js";
import { wikiDigest } from "./model.js";
import { wikiGenerator } from "./format.js";

/** Hash source content, not revision/object identity: callers can mutate a
 * snapshot in place. Private planning memory/configuration never enter caches. */
export function retrievalInputSignature(board: BoardSnapshot): string {
  return wikiDigest([board.goals, board.steps, board.facts, board.findings, board.evidence, board.attempts ?? [],
    board.capabilities ?? [], board.chains ?? [], (board.wikiPages ?? []).map(({ history: _history, ...page }) => page)]);
}

const snapshots = new Map<string, { signature: string; stamp: string; index: RetrievalIndex; bytes: number }>();
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value); for (const child of Object.values(value)) freeze(child);
}

/** Bounded process cache; durable term entries remain the restart path. */
export function clearRetrievalSnapshots(): void { snapshots.clear(); }

export function incrementalRetrievalIndex(board: BoardSnapshot, dataDir: string, workspace: string, refresh = false) {
  const key = JSON.stringify([resolve(dataDir), resolve(workspace)]), signature = retrievalInputSignature(board);
  const stamp = retrievalCacheStamp(dataDir, workspace), previous = snapshots.get(key);
  if (!refresh && stamp && previous?.stamp === stamp && previous.signature === signature) {
    snapshots.delete(key); snapshots.set(key, previous);
    return { index: { ...previous.index, boardRevision: board.revision },
      stats: { ...indexStats(), reused: previous.index.documents.length, snapshotReused: true } };
  }
  snapshots.delete(key);
  const result = withIndexCache(dataDir, workspace, (db, stats) => {
    const { documents, fields } = retrievalDocuments(board), postings: RetrievalIndex["postings"] = Object.create(null), lengths: number[] = [];
    stats.removed = pruneEntries(db, "metadata", new Set(documents.map(doc => refKey(doc.ref))));
    const previousEntries = cachedEntries<[string, number][]>(db, "metadata");
    fields.forEach((field, i) => {
      const key = refKey(documents[i]!.ref), signature = wikiDigest(field), previous = previousEntries.get(key);
      if (previous && (!Array.isArray(previous.value) || previous.value.some(entry => !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== "string" || !Number.isSafeInteger(entry[1]) || entry[1] < 1))) throw new Error("Invalid metadata cache terms");
      let counts: [string, number][];
      if (!refresh && previous?.signature === signature) { counts = previous.value; stats.reused++; }
      else {
        const map = new Map<string, number>();
        for (const [text, weight] of [[field.title, 3], [field.body, 1]] as const) for (const term of terms(text)) map.set(term, (map.get(term) ?? 0) + weight);
        counts = [...map]; previous ? stats.updated++ : stats.added++;
        stats.indexedBytes += Buffer.byteLength(field.title + field.body);
        putEntry(db, "metadata", key, signature, counts, []);
      }
      lengths.push(counts.reduce((sum, [, n]) => sum + n, 0));
      for (const [term, count] of counts) (postings[term] ??= []).push([i, count]);
    });
    const index: RetrievalIndex = { generator: wikiGenerator, type: "retrieval_index", version: 1, evidence: false,
      boardRevision: board.revision, signature: wikiDigest(documents), documents, lengths, postings };
    // Text and conditions always come from today's board, never from cache payloads.
    return { index, stats };
  });
  const currentStamp = result.stats.storage === "persistent" ? retrievalCacheStamp(dataDir, workspace) : undefined;
  if (currentStamp) {
    const bytes = Buffer.byteLength(JSON.stringify(result.index));
    if (bytes <= 16 * 1024 * 1024) {
      // Detach nested source arrays before freezing; the caller's board stays mutable.
      const index = { ...result.index, documents: structuredClone(result.index.documents) };
      freeze(index);
      snapshots.set(key, { signature, stamp: currentStamp, index, bytes });
      while (snapshots.size > 4 || [...snapshots.values()].reduce((total, item) => total + item.bytes, 0) > 32 * 1024 * 1024)
        snapshots.delete(snapshots.keys().next().value!);
      return { ...result, index };
    }
  }
  return result;
}
