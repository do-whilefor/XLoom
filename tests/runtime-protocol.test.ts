import { describe, expect, it, vi } from "vitest";
import { validateFinalJson } from "../src/runtime/protocol.js";
import { decisionSchema } from "../src/schema.js";

describe("final JSON diagnostic preflight", () => {
  it("reports schema errors inside prose without accepting the extracted object", () => {
    expect(() => validateFinalJson('Summary first.\n```json\n{"steps":[]}\n```', parsed => decisionSchema.parse(parsed)))
      .toThrow(/single JSON object.*Embedded JSON diagnostics.*summary/s);
  });

  it.each(['Before {"summary":"ok"}', '{"summary":"ok"} After'])
    ("still rejects surrounding prose even when the embedded proposal is valid: %s", text => {
      const validate = vi.fn(parsed => decisionSchema.parse(parsed));
      expect(() => validateFinalJson(text, validate)).toThrow("single JSON object");
      expect(validate).toHaveBeenCalledOnce();
    });

  it.each(['{"summary":"one"} {"summary":"two"}', 'Before {broken} then {"summary":"valid"}',
    '{"unfinished": {"summary":"nested"}', '[{"summary":"inside-array"}]', '```json\n[{"summary":"inside-array"}]\n```', '"{\\"summary\\":\\"inside-string\\"}"'])
    ("does not select from ambiguous or nested proposals: %s", text => {
      const validate = vi.fn(parsed => decisionSchema.parse(parsed));
      expect(() => validateFinalJson(text, validate)).toThrow();
      expect(validate).not.toHaveBeenCalled();
    });

  it("preserves escaped braces and schema errors in an otherwise valid final object", () => {
    const proposal = { summary: 'Literal { brace } and an escaped quote " are data' };
    expect(validateFinalJson(JSON.stringify(proposal), parsed => decisionSchema.parse(parsed))).toEqual(proposal);
    expect(() => validateFinalJson('{"summary":42}', parsed => decisionSchema.parse(parsed))).toThrow();
  });
});
