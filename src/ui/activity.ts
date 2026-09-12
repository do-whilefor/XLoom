import type { FeedEntry } from "./model.js";

/** A presentation-only group; every member remains the original feed object. */
export interface ActivityGroup {
  kind: "group";
  anchor: FeedEntry;
  entries: FeedEntry[];
}

/** Group one contiguous model/tool activity without swallowing replies or roles. */
export function groupActivities(entries: readonly FeedEntry[]): Array<FeedEntry | ActivityGroup> {
  const result: Array<FeedEntry | ActivityGroup> = [];
  let group: ActivityGroup | undefined;
  let hasTool = false;
  const flush = (): void => {
    if (group) result.push(group);
    group = undefined;
    hasTool = false;
  };
  for (const entry of entries) {
    if (entry.kind === "diagnostic") {
      // Diagnostics neither split an active group nor become a visible heading.
      if (group) group.entries.push(entry);
      else result.push(entry);
      continue;
    }
    if (entry.kind !== "thinking" && entry.kind !== "tool" && entry.kind !== "protocol") {
      flush();
      result.push(entry);
      continue;
    }
    // A new thought after tools belongs to the next model round. Multiple thought
    // blocks before the first tool may still describe the same round.
    if (entry.kind === "thinking" && hasTool) flush();
    if (!group) group = { kind: "group", anchor: entry, entries: [] };
    group.entries.push(entry);
    if (entry.kind === "tool") hasTool = true;
  }
  flush();
  return result;
}

type ToolKind = "read" | "write" | "edit" | "powershell" | "other";
const TOOL_KINDS: readonly ToolKind[] = ["read", "write", "edit", "powershell", "other"];

function toolKind(entry: FeedEntry): ToolKind {
  const name = entry.label.toLowerCase();
  return name === "read" || name === "write" || name === "edit" || name === "powershell" ? name : "other";
}

function toolPhrase(kind: ToolKind, count: number, running: boolean): string {
  const noun = kind === "powershell" ? "shell command" : kind === "other" ? "tool call" : "file";
  const verbs: Record<ToolKind, [string, string]> = {
    read: ["read", "reading"], write: ["wrote", "writing"], edit: ["edited", "editing"],
    powershell: ["ran", "running"], other: ["ran", "running"],
  };
  return `${verbs[kind][running ? 1 : 0]} ${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Union actual thought intervals; tool duration is not invented thinking time. */
function thinkingMilliseconds(entries: readonly FeedEntry[], now: number): number | undefined {
  const intervals: Array<[number, number]> = [];
  for (const entry of entries) {
    if (entry.durationKnown === false || !Number.isFinite(entry.startedAt)) return;
    const end = entry.endedAt === undefined ? now : entry.endedAt;
    if (!Number.isFinite(end)) return;
    intervals.push([entry.startedAt!, Math.max(entry.startedAt!, end)]);
  }
  intervals.sort((left, right) => left[0] - right[0]);
  let total = 0;
  let previous: [number, number] | undefined;
  for (const interval of intervals) {
    if (!previous) previous = [...interval];
    else if (interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else { total += previous[1] - previous[0]; previous = [...interval]; }
  }
  return total + (previous ? previous[1] - previous[0] : 0);
}

/** Counts successful/running/failed calls, not unique paths or inferred impact.
 * Protocol-only groups intentionally have an empty summary and remain details. */
export function summarizeActivity(group: ActivityGroup, now: number): { text: string; active: boolean; failed: number } {
  const thoughts = group.entries.filter(entry => entry.kind === "thinking");
  const thoughtActive = thoughts.some(entry => !Number.isFinite(entry.endedAt));
  const done = new Map<ToolKind, number>();
  const running = new Map<ToolKind, number>();
  let failed = 0;
  for (const entry of group.entries) {
    if (entry.kind !== "tool") continue;
    if (entry.error || entry.state === "error") { failed++; continue; }
    const kind = toolKind(entry);
    const counts = entry.state === "done" ? done : running;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (thoughts.length) {
    const milliseconds = thinkingMilliseconds(thoughts, now);
    parts.push(milliseconds === undefined ? thoughtActive ? "Thinking…" : "Thought" : `${thoughtActive ? "Thinking" : "Thought"} for ${Math.floor(milliseconds / 1000)}s`);
  }
  for (const kind of TOOL_KINDS) if (done.has(kind)) parts.push(toolPhrase(kind, done.get(kind)!, false));
  for (const kind of TOOL_KINDS) if (running.has(kind)) parts.push(toolPhrase(kind, running.get(kind)!, true));
  if (failed) parts.push(`${failed} failed`);
  const text = parts.join(", ");
  return { text: text ? text[0]!.toUpperCase() + text.slice(1) : "", active: thoughtActive || running.size > 0, failed };
}
