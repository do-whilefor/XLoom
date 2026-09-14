import type { BoardSnapshot } from "../types.js";
import { refKey, type RetrievalRef } from "./catalog.js";
import { wikiDigest } from "./model.js";
import { originalReadPath } from "./originals.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Per-reader delivery hints, never persisted as research/review receipts. No
 * body is suppressed: fresh roles and compacted contexts may need it again. */
export function createReadingTracker() {
  const records = new Map<string, string>(), candidates = new Set<string>();
  const ranges = new Map<string, [number, number][]>();
  return <T extends object>(packet: T, board: BoardSnapshot, budget = Infinity) => {
    const value = object(packet);
    if (value.complete === false && value.type !== "source_page") return packet;
    let newRecords = 0, repeatedRecords = 0, repeatedOriginalRange = false;
    const current = new Map<string, object>();
    for (const bundle of [value, object(value.wiki), object(value.sourceContext)]) for (const entry of list(bundle.records)) {
      const record = object(entry), ref = object(record.ref);
      if (typeof ref.kind !== "string" || typeof ref.id !== "string" || record.status === "source_missing") continue;
      const key = refKey(ref as unknown as RetrievalRef); current.set(key, record);
      if (ref.kind === "evidence") candidates.add(ref.id);
    }
    for (const [key, record] of current) {
      const signature = wikiDigest(record);
      if (records.get(key) === signature) repeatedRecords++; else newRecords++;
      records.set(key, signature);
    }
    for (const originals of [value, object(value.originals)]) for (const hit of list(originals.hits)) {
      const id = object(object(hit).locator).evidenceId;
      if (typeof id === "string") candidates.add(id);
    }
    if (value.type === "original_read" && value.integrity === "verified") {
      const loc = object(value.locator), id = String(loc.evidenceId), start = Number(loc.byteOffset), end = start + Number(loc.byteLength);
      candidates.add(id);
      const key = JSON.stringify([id, loc.sha256]), previous = ranges.get(key) ?? [];
      repeatedOriginalRange = previous.some(([left, right]) => left <= start && right >= end);
      const merged: [number, number][] = [];
      for (const interval of [...previous, [start, end] as [number, number]].sort(([a], [b]) => a - b)) {
        const last = merged.at(-1);
        if (last && last[1] >= interval[0]) last[1] = Math.max(last[1], interval[1]); else merged.push([...interval]);
      }
      ranges.set(key, merged);
    }
    let originalsWithUnreadBytes = 0, fullyDeliveredOriginals = 0, nextOriginalReadPath: string | undefined;
    for (const evidence of board.evidence) {
      if (!candidates.has(evidence.id)) continue;
      let offset = 0;
      for (const [start, end] of ranges.get(JSON.stringify([evidence.id, evidence.sha256])) ?? []) {
        if (start > offset) break; offset = Math.max(offset, end);
      }
      if (offset < evidence.bytes) {
        originalsWithUnreadBytes++;
        nextOriginalReadPath ??= originalReadPath({ evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: offset });
      } else fullyDeliveredOriginals++;
    }
    const reading = { newRecords, repeatedRecords, originalsWithUnreadBytes, fullyDeliveredOriginals,
      ...(repeatedOriginalRange ? { repeatedOriginalRange } : {}), ...(nextOriginalReadPath ? { nextOriginalReadPath } : {}) };
    const result = { ...packet, reading };
    // Hints cannot consume space reserved for a complete source package.
    if (JSON.stringify(result).length > budget) delete result.reading.nextOriginalReadPath;
    return JSON.stringify(result).length <= budget ? result : packet;
  };
}
