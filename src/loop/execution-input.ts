import type { BoardSnapshot } from "../types.js";

/** Preserve an existing Finding's title when an exact-key update omits it.
 * New/unknown keys and explicit invalid values still undergo strict validation. */
export function normalizeExecutionInput(input: unknown, board: BoardSnapshot): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = structuredClone(input) as Record<string, unknown>;
  if (Array.isArray(value.findings)) for (const item of value.findings) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.hasOwn(item, "title")) continue;
    const existing = board.findings.filter(finding => finding.key === item.key);
    if (existing.length === 1) item.title = existing[0]!.title;
  }
  return value;
}
