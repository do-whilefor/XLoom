import type { BoardSnapshot } from "../types.js";
import { gapQueue, gapReadPath, gapSearchQuery, gapSearchGroups, type GapRef } from "../knowledge/gaps.js";
import { refKey, retrievalDocuments, retrievalSearchText, terms, type RetrievalDocument, type RetrievalRef } from "./catalog.js";
import { incrementalRetrievalIndex } from "./incremental.js";
import { wikiBasis, wikiDigest } from "./model.js";
import { wikiGenerator } from "./format.js";
import { searchOriginals } from "./originals.js";

export interface MaterialCard {
  key: string; signature: string; change: "new" | "changed" | "removed"; kind: string; id: string; title: string; readPath: string;
  status?: "removed" | "inactive";
  relatedGaps: (GapRef & { relation: "source" | "candidate" | "lexical"; readPath: string })[];
  relatedGapCount?: number;
}
export interface MaterialDelivery {
  generator: typeof wikiGenerator; type: "planning_materials"; evidence: false; boardRevision: number;
  baseline: "initial" | "previous_planning"; items: MaterialCard[]; added: number; changed: number; unchanged: number; removed?: number;
  deferredCount: number; deferred: string[]; readPath: string; notice: string;
  originalLinking?: { checkedGaps: number; deferredGaps: number; unavailableSources: number };
}
export function recordReadPath(ref: RetrievalRef): string {
  return `xloom://record?${new URLSearchParams({ kind: ref.kind, id: ref.id, ...(ref.pageId ? { page: ref.pageId } : {}) })}`;
}

/** Navigation deltas only. Receipts mean announced in a committed planning run,
 * never "read", "understood" or "reviewed". Full source packages remain on demand. */
export function materialDelivery(board: BoardSnapshot, baseline: Record<string, string>, budgetChars = 6000,
  originalMatches: Map<string, Set<string>> = new Map(), originalLinking?: MaterialDelivery["originalLinking"],
  documents: RetrievalDocument[] = retrievalDocuments(board).documents): MaterialDelivery {
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 1024 || budgetChars > 64000) throw new Error("Material budgetChars must be 1024–64000");
  const gaps = gapQueue(board).filter(item => item.active), candidates: MaterialCard[] = [];
  const roots = gaps.map(gap => {
    const sourceRefs = [...gap.sources.map(item => item.source), ...gap.candidates.map(item => ({ kind: "capability" as const, id: item.capabilityId }))];
    const sources = new Set<string>();
    for (const source of sourceRefs) {
      try { wikiBasis(board, [source]).forEach(ref => sources.add(refKey(ref))); }
      catch { sources.add(refKey(source)); }
    }
    return { gap, sources, words: new Set(terms(gapSearchQuery(gap)).filter(term => /[\u3400-\u9fff]/.test(term) || term.length >= 4)) };
  });
  let unchanged = 0;
  const current = new Set<string>();
  for (const doc of documents) {
    if (!["fact", "evidence", "capability", "chain", "block"].includes(doc.ref.kind)) continue;
    const key = refKey(doc.ref), signature = wikiDigest(doc);
    current.add(key);
    if (baseline[key] === signature) { unchanged++; continue; }
    const words = new Set(terms(retrievalSearchText(doc)));
    const relatedGaps = roots.flatMap(({ gap, sources, words: query }) => {
      const explicit = sources.has(key), candidate = doc.ref.kind === "capability" && gap.candidates.some(item => item.capabilityId === doc.ref.id);
      const lexical = [...query].some(word => words.has(word)) || doc.ref.kind === "evidence" && originalMatches.get(`${gap.stepId}/${gap.gapId}`)?.has(doc.ref.id);
      return explicit || lexical ? [{ stepId: gap.stepId, gapId: gap.gapId, relation: candidate ? "candidate" as const : explicit ? "source" as const : "lexical" as const, readPath: gapReadPath(gap) }] : [];
    });
    candidates.push({ key, signature, change: baseline[key] ? "changed" : "new", kind: doc.ref.kind, id: doc.ref.id,
      title: doc.title.length > 200 ? `${doc.title.slice(0, 199)}…` : doc.title, readPath: recordReadPath(doc.ref),
      relatedGaps: relatedGaps.slice(0, 3), ...(relatedGaps.length > 3 ? { relatedGapCount: relatedGaps.length } : {}) });
  }
  for (const gap of gaps) {
    const key = `gap:${gap.stepId}/${gap.gapId}`, signature = gap.signature;
    current.add(key);
    if (baseline[key] === signature) { unchanged++; continue; }
    candidates.push({ key, signature, change: baseline[key] ? "changed" : "new", kind: "gap", id: `${gap.stepId}/${gap.gapId}`,
      title: gap.missing.length > 200 ? `${gap.missing.slice(0, 199)}…` : gap.missing, readPath: gapReadPath(gap),
      relatedGaps: [{ stepId: gap.stepId, gapId: gap.gapId, relation: "source", readPath: gapReadPath(gap) }] });
  }
  const allGaps = gapQueue(board);
  for (const [key, old] of Object.entries(baseline)) {
    if (current.has(key)) continue;
    let card: MaterialCard | undefined;
    if (key.startsWith("gap:")) {
      const gap = allGaps.find(gap => `gap:${gap.stepId}/${gap.gapId}` === key);
      const status = gap ? "inactive" : "removed", signature = wikiDigest([key, status, gap?.signature]);
      card = { key, signature, change: gap ? "changed" : "removed", status, kind: "gap", id: key.slice(4),
        title: gap ? gap.missing.slice(0, 200) : "Previously announced gap is no longer present", readPath: "xloom://materials?refresh=true&budgetChars=64000", relatedGaps: [] };
    } else {
      try {
        const value = JSON.parse(key);
        if (!Array.isArray(value) || value.length !== 3 || !value.every(item => typeof item === "string")) continue;
        const [kind, pageId, id] = value as [RetrievalRef["kind"], string, string];
        if (!["fact", "evidence", "capability", "chain", "block"].includes(kind) || !id || (kind === "block") !== !!pageId) continue;
        card = { key, signature: wikiDigest([key, "removed"]), change: "removed", status: "removed", kind, id,
          title: "Previously announced record is no longer present; do not reuse its old contents", readPath: recordReadPath({ kind, id, ...(pageId ? { pageId } : {}) }), relatedGaps: [] };
      } catch { continue; }
    }
    if (card.signature !== old) candidates.push(card); else unchanged++;
  }
  candidates.sort((a, b) => Number(b.change === "removed") - Number(a.change === "removed") || Number(b.kind === "gap") - Number(a.kind === "gap") || Number(!!b.relatedGaps.length) - Number(!!a.relatedGaps.length)
    || Number(b.change === "changed") - Number(a.change === "changed") || a.key.localeCompare(b.key));
  const result: MaterialDelivery = { generator: wikiGenerator, type: "planning_materials", evidence: false, boardRevision: board.revision,
    baseline: Object.keys(baseline).length ? "previous_planning" : "initial", items: [], added: 0, changed: 0, removed: 0, unchanged, deferredCount: 0, deferred: [],
    readPath: "xloom://materials?budgetChars=64000", ...(originalLinking ? { originalLinking } : {}),
    notice: "Announcements, not review receipts. Fresh role: read full sources/conditions and originals, including unchanged material. Lexical links are candidates, not proof. Automatic original links check at most 3 active gaps / 20 hits each; missing links mean nothing. Use question paths for focused retrieval. Deferred/failed deliveries remain pending; refresh=true shows all navigation. Only revisits/gapReviews decide next action." };
  result.deferredCount = candidates.length;
  for (const card of candidates) {
    result.items.push(card); result.deferredCount--;
    if (card.change === "new") result.added++; else if (card.change === "removed") result.removed!++; else result.changed++;
    if (JSON.stringify(result).length > budgetChars) {
      result.items.pop(); result.deferredCount++;
      if (card.change === "new") result.added--; else if (card.change === "removed") result.removed!--; else result.changed--;
    }
  }
  const delivered = new Set(result.items.map(item => item.key));
  for (const card of candidates) {
    if (delivered.has(card.key) || result.deferred.length >= 8) continue;
    result.deferred.push(card.key);
    if (JSON.stringify(result).length > budgetChars) result.deferred.pop();
  }
  return result;
}

/** Bounded original-body candidate association; only delivered verified search
 * hits become navigation links, never authoritative gapLinks. */
export function planningMaterials(board: BoardSnapshot, baseline: Record<string, string>, dataDir: string, workspace: string, budgetChars = 6000) {
  const documents = incrementalRetrievalIndex(board, dataDir, workspace).index.documents;
  const changedEvidence = documents.some(doc => doc.ref.kind === "evidence" && baseline[refKey(doc.ref)] !== wikiDigest(doc));
  const matches = new Map<string, Set<string>>(), unavailable = new Set<string>();
  const gaps = changedEvidence ? gapQueue(board).filter(item => item.active && item.state !== "resolved") : [];
  for (const gap of gaps.slice(0, 3)) {
    const query = gapSearchQuery(gap);
    if (!terms(query).length) continue;
    const result = searchOriginals(board, dataDir, workspace, query, 20, false, gapSearchGroups(gap));
    matches.set(`${gap.stepId}/${gap.gapId}`, new Set(result.hits.map(hit => hit.locator.evidenceId)));
    result.issues.forEach(issue => unavailable.add(issue.evidenceId));
  }
  const delivery = materialDelivery(board, baseline, budgetChars, matches, gaps.length ? {
    checkedGaps: matches.size, deferredGaps: gaps.length - matches.size, unavailableSources: unavailable.size,
  } : undefined, documents);
  // Candidate matching is deliberately bounded; absence of a link means nothing.
  // This fixed notice is already included in materialDelivery's budget accounting.
  return delivery;
}
