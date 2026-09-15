import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import type { Usage } from "./types.js";

export function cacheInput(usage: Usage): number {
  return usage.cacheInput ?? (usage.cacheRead === undefined ? 0 : usage.input);
}

/** Cache reads are a subset of input, never extra tokens in the total budget. */
export function modelUsage(usage: ModelUsage): Usage {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return { input, output: usage.output, cost: usage.cost.total, cacheRead: usage.cacheRead, cacheInput: input };
}

/** Retain coverage when mixing new measurements with pre-upgrade totals. */
export function addUsage(total: Usage, added: Usage): Usage {
  if (total.cacheRead !== undefined || added.cacheRead !== undefined) {
    total.cacheInput = cacheInput(total) + cacheInput(added);
    total.cacheRead = (total.cacheRead ?? 0) + (added.cacheRead ?? 0);
  }
  total.input += added.input; total.output += added.output; total.cost += added.cost;
  return total;
}
