import type { BoardSnapshot } from "../types.js";
import { refKey, retrievalDocuments, terms, type RetrievalIndex } from "./catalog.js";
import { cachedEntry, pruneEntries, putEntry, withIndexCache } from "./cache.js";
import { wikiDigest } from "./model.js";
import { wikiGenerator } from "./format.js";

export function incrementalRetrievalIndex(board: BoardSnapshot, dataDir: string, workspace: string, refresh = false) {
  return withIndexCache(dataDir, workspace, (db, stats) => {
    const { documents, fields } = retrievalDocuments(board), postings: RetrievalIndex["postings"] = Object.create(null), lengths: number[] = [];
    stats.removed = pruneEntries(db, "metadata", new Set(documents.map(doc => refKey(doc.ref))));
    fields.forEach((field, i) => {
      const key = refKey(documents[i]!.ref), signature = wikiDigest(field), previous = cachedEntry<[string, number][]>(db, "metadata", key);
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
}
