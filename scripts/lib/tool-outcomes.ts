import type { LoopEvent, RuntimeEvent } from "../../src/types.js";

/** Keep first-pass errors visible. A submit validation rejection followed by
 * a successful controller commit in the SAME run proves protocol recovery. */
export function analyzeToolOutcomes(events: readonly LoopEvent[]) {
  let run: { id: string; mode: RuntimeEvent["mode"] } | undefined;
  let calls = 0;
  const errors: { runId?: string; mode: RuntimeEvent["mode"]; toolName?: string; toolCallId?: string; message: string; recovered: boolean }[] = [];
  for (const event of events) {
    if (event.handoff) run = { id: event.handoff.runId, mode: event.handoff.mode };
    const runtime = event.runtime;
    if (runtime?.type === "tool_start") calls++;
    if (runtime?.type === "tool_end" && runtime.isError) errors.push({
      runId: run?.mode === runtime.mode ? run.id : undefined, mode: runtime.mode,
      toolName: runtime.toolName, toolCallId: runtime.toolCallId, message: runtime.text, recovered: false,
    });
    const committed = event.result;
    if (run && committed && !committed.kind && committed.mode === run.mode && (!committed.runId || committed.runId === run.id)) {
      for (const error of errors) if (error.runId === run.id && error.mode === run.mode && error.toolName === "submit"
        && (error.message.includes("Rejected proposal retained in this run.")
          || error.message.startsWith('Validation failed for tool "submit":\n'))) error.recovered = true;
      run = undefined;
    }
  }
  return { calls, firstPass: errors.length === 0, recoveredErrors: errors.filter(error => error.recovered).length,
    unrecoveredErrors: errors.filter(error => !error.recovered).length, errors };
}
