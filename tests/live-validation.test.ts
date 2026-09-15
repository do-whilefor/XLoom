import { describe, expect, it } from "vitest";
import { analyzeToolOutcomes } from "../scripts/lib/tool-outcomes.js";
import type { LoopEvent } from "../src/types.js";
import { matchesBrowserToolContract } from "../scripts/lib/browser-tool-contract.js";

describe("browser validation tool contract", () => {
  const operations = ["read", "write", "edit", "powershell", "chrome"];
  const tools = (names: string[]) => names.map(name => ({ name }));
  it("requires Execute's submit channel while keeping Chat's five operation tools", () => {
    expect(matchesBrowserToolContract("chat", tools(operations))).toBe(true);
    expect(matchesBrowserToolContract("execute", tools([...operations, "submit"].reverse()))).toBe(true);
    expect(matchesBrowserToolContract("execute", tools(operations))).toBe(false);
    expect(matchesBrowserToolContract("chat", tools([...operations, "submit"]))).toBe(false);
  });
  it.each([undefined, [], [...operations, "unexpected"], ["read", "read", "edit", "powershell", "chrome"]])("rejects missing, extra and duplicate tools: %j", names => {
    expect(matchesBrowserToolContract("chat", names && tools(names))).toBe(false);
  });
});

const handoff = (id: string): LoopEvent => ({ type: "handoff", handoff: {
  role: "decide", mode: "decide", runId: id, revision: 0, trigger: { kind: "start" },
} } as LoopEvent);
const failure = (toolName = "submit", message = "steps.0.from: Required Rejected proposal retained in this run."): LoopEvent => ({
  type: "runtime", runtime: { type: "tool_end", mode: "decide", toolName, toolCallId: "failed", isError: true, text: message },
});
const accepted: LoopEvent = { type: "runtime", runtime: { type: "tool_end", mode: "decide", toolName: "submit", toolCallId: "repair", text: '{"accepted":true}', isError: false } };
const committed = (runId?: string): LoopEvent => ({ type: "result", result: { mode: "decide", summary: "Validated proposal committed", runId } });

describe("live integration recovery checks", () => {
  it("retains first-pass failure while allowing a repaired and committed proposal", () => {
    const result = analyzeToolOutcomes([handoff("one"), failure(), accepted, committed()]);
    expect(result).toMatchObject({ firstPass: false, recoveredErrors: 1, unrecoveredErrors: 0 });
    expect(result.errors[0]).toMatchObject({ runId: "one", toolCallId: "failed", recovered: true });
    expect(result.errors[0].message).toContain("steps.0.from");
  });

  it("accepts a validated text-JSON repair committed by the controller", () => {
    expect(analyzeToolOutcomes([handoff("one"), failure(), committed("one")]).unrecoveredErrors).toBe(0);
  });

  it("requires a controller commit, not just the tool's acceptance", () => {
    expect(analyzeToolOutcomes([handoff("one"), failure(), accepted]).unrecoveredErrors).toBe(1);
  });

  it.each(["read", "powershell", "chrome"])("does not excuse a %s failure after a successful final commit", tool => {
    const result = analyzeToolOutcomes([handoff("one"), failure(tool), accepted, committed()]);
    expect(result.unrecoveredErrors).toBe(1); expect(result.recoveredErrors).toBe(0);
  });

  it("does not excuse non-validation submit errors", () => {
    expect(analyzeToolOutcomes([handoff("one"), failure("submit", "Checkpoint could not be saved"), accepted, committed()]).unrecoveredErrors).toBe(1);
  });

  it("does not join recovery across runs or accept checkpoint/transition events", () => {
    for (const result of [
      analyzeToolOutcomes([handoff("one"), failure(), handoff("two"), accepted, committed()]),
      analyzeToolOutcomes([handoff("one"), failure(), accepted, committed("two")]),
      ...(["checkpoint", "transition"] as const).map(kind => analyzeToolOutcomes([handoff("one"), failure(), accepted, { type: "result", result: { mode: "decide", summary: "partial", kind } }])),
      analyzeToolOutcomes([failure(), accepted, committed()]),
    ]) expect(result.unrecoveredErrors).toBe(1);
  });

  it("counts every rejection until the same run commits and leaves later failures unresolved", () => {
    const result = analyzeToolOutcomes([handoff("one"), failure(), failure(), accepted, committed(), failure()]);
    expect(result).toMatchObject({ firstPass: false, recoveredErrors: 2, unrecoveredErrors: 1 });
  });
});
