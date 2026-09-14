import { wikiDigest } from "./model.js";
import { refKey, type RetrievalRef } from "./catalog.js";
import type { retrieveWiki } from "./retrieval.js";

/** Delivery receipts are local to one reader. Pages never truncate a judgment,
 * remove its conditions or imply that delivered sources have been reviewed. */
export function createSourcePager() {
  const delivered = new Map<string, Set<string>>();
  return (full: ReturnType<typeof retrieveWiki>, ref: RetrievalRef, url: URL, budget: number) => {
    const records = [...full.records].sort((a, b) => refKey((a as { ref: RetrievalRef }).ref).localeCompare(refKey((b as { ref: RetrievalRef }).ref)));
    const signature = wikiDigest({ records, missing: full.missingAnchors });
    const path = (offset: number, size = budget) => {
      const next = new URL(url); next.searchParams.set("sourceOffset", String(offset));
      next.searchParams.set("packageSignature", signature); next.searchParams.set("budgetChars", String(size));
      return next.href;
    };
    const offset = Number(url.searchParams.get("sourceOffset") ?? 0);
    const expected = url.searchParams.get("packageSignature");
    if (expected && expected !== signature) throw new Error(`Source package changed; restart with ${path(0)}. Old pages cannot establish current conditions.`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= records.length || offset > 0 && !expected)
      throw new Error("Source page offset requires a valid packageSignature and an index within the package; follow nextReadPath.");
    const previous = delivered.get(signature) ?? new Set<string>();
    const selected: object[] = [];
    const key = (record: object) => refKey((record as { ref: RetrievalRef }).ref);
    const missing = full.missingAnchors.length > 0 || records.some(record => "status" in record && record.status === "source_missing");
    const build = () => {
      const seen = new Set([...previous, ...selected.map(key)]);
      const nextIndex = records.findIndex(record => !seen.has(key(record)));
      return { generator: full.generator, type: "source_page", evidence: false, answerSupport: "not_assessed",
        requestedRef: ref, packageSignature: signature, sourceOffset: offset, records: selected, missingAnchors: full.missingAnchors,
        complete: nextIndex === -1 && !missing, status: missing ? "source_missing" : nextIndex === -1 ? "inspect_material" : "source_page_pending",
        sourceDelivery: { totalRecords: records.length, deliveredRecords: seen.size, remainingRecords: records.length - seen.size, pageRecords: selected.length },
        ...(nextIndex !== -1 ? { nextReadPath: path(nextIndex) } : {}),
        next: "Full records are delivered in source pages. Follow nextReadPath until the package is delivered; retain conditions, corrections and counterevidence from every page. Original bodies are not included; then follow evidence.originalReadPath. Delivery is not review. Re-read earlier pages if context was compacted.",
      };
    };
    for (let i = offset; i < records.length; i++) {
      selected.push(records[i]!);
      // Leave space for same-reader progress diagnostics.
      if (JSON.stringify(build()).length > budget - 128) { selected.pop(); break; }
    }
    if (!selected.length) {
      const record = records[offset] as { ref: RetrievalRef; path?: string };
      const fallback = { type: "source_page", evidence: false, complete: false, status: "record_exceeds_budget", requestedRef: ref,
        records: [], oversizedRef: record.ref, ...(budget < 64000 ? { nextReadPath: path(offset, 64000) } : { fileReadPath: record.path }),
        next: "One complete record exceeds this budget. Use nextReadPath, or read fileReadPath and its explicit dependencies. No judgment was truncated or delivered." };
      return JSON.stringify(fallback).length <= budget ? fallback : { type: "source_page", evidence: false, complete: false, status: "record_exceeds_budget", records: [] };
    }
    const result = build();
    delivered.set(signature, new Set([...previous, ...selected.map(key)]));
    return result;
  };
}
