import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { evidencePath } from "../../src/paths.js";
import type { Evidence, RuntimeEvent } from "../../src/types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = (text: string): any => { try { return JSON.parse(text); } catch { return undefined; } };

/** Delivery diagnostics for the guided replay. Filesystem delivery is reported
 * separately and never satisfies the native-interface benchmark. */
export function analyzeReadingOutcomes(events: readonly RuntimeEvent[], evidence: readonly Evidence[], taskDir: string, workspace: string) {
  const starts = new Map<string, RuntimeEvent>();
  const deliveries: { mode: RuntimeEvent["mode"]; evidenceId: string; route: "native" | "file"; start: number; end: number }[] = [];
  const nativeSearchRoles = new Set<RuntimeEvent["mode"]>();
  for (const event of events) {
    if (!event.toolCallId || event.toolName !== "read") continue;
    const key = JSON.stringify([event.mode, event.toolCallId]);
    if (event.type === "tool_start") { starts.set(key, event); continue; }
    if (event.type !== "tool_end") continue;
    const call = starts.get(key); starts.delete(key);
    const path = call && parse(call.text)?.path;
    if (event.isError || typeof path !== "string") continue;
    const packet = parse(event.text);
    if (path.startsWith("xloom://search?") && packet?.type === "task_search" && packet.mode === "wiki" && packet.complete === true
      && packet.query === "BridgeAlias" && packet.wiki?.records?.length) nativeSearchRoles.add(event.mode);
    for (const item of evidence) {
      const loc = packet?.locator;
      if (path.startsWith("xloom://original?") && packet?.type === "original_read" && packet.integrity === "verified"
        && loc?.evidenceId === item.id && loc.sha256 === item.sha256 && typeof packet.text === "string"
        && Number.isSafeInteger(loc.byteOffset) && loc.byteOffset >= 0 && Number.isSafeInteger(loc.byteLength) && loc.byteLength >= 0
        && loc.byteOffset + loc.byteLength <= item.bytes && Buffer.byteLength(packet.text) === loc.byteLength && hash(packet.text) === packet.rangeSha256) {
        deliveries.push({ mode: event.mode, evidenceId: item.id, route: "native", start: loc.byteOffset, end: loc.byteOffset + loc.byteLength });
      } else if (isAbsolute(path) && resolve(path) === resolve(evidencePath(item, taskDir, workspace))
        && Buffer.byteLength(event.text) === item.bytes && hash(event.text) === item.sha256) {
        deliveries.push({ mode: event.mode, evidenceId: item.id, route: "file", start: 0, end: item.bytes });
      }
    }
  }
  const coverage = (["decide", "execute"] as const).map(mode => ({ mode, nativeSearch: nativeSearchRoles.has(mode),
    evidence: evidence.map(item => {
      const ranges = deliveries.filter(value => value.mode === mode && value.evidenceId === item.id);
      let end = 0;
      const native = ranges.filter(value => value.route === "native").sort((a, b) => a.start - b.start);
      for (const range of native) { if (range.start > end) break; end = Math.max(end, range.end); }
      return { id: item.id, nativeComplete: native.length > 0 && end === item.bytes, fileComplete: ranges.some(value => value.route === "file") };
    }),
  }));
  return { coverage, deliveries,
    nativeSearchByBothRoles: coverage.every(role => role.nativeSearch),
    nativeReadingByBothRoles: evidence.length > 0 && coverage.every(role => role.evidence.every(item => item.nativeComplete)),
    originalDeliveryByBothRoles: evidence.length > 0 && coverage.every(role => role.evidence.every(item => item.nativeComplete || item.fileComplete)) };
}
