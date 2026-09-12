import { describe, expect, it } from "vitest";
import { retainToolOutput, summarizeToolFailure } from "../src/ui/tool-output.js";

describe("tool output diagnostics", () => {
  const response = "HTTP/1.1 200 OK\n" + "synthetic response body\n".repeat(800);
  const failure = [
    "2>&1:",
    "Line |",
    "  33 | } 2>&1 | Out-File 'output.txt'",
    "     |   ~~~~",
    "     | The term '2>&1' is not recognized as a name of a cmdlet.",
    "Get-Content:",
    "Line |",
    "  34 | Get-Content 'output.txt' -Raw",
    "     | Cannot find path 'output.txt' because it does not exist.",
    "",
    "Command exited with code 1",
  ].join("\n");

  it("preserves both response context and the actual failure after a long response", () => {
    const output = retainToolOutput(response + failure, true);
    expect(output.length).toBeLessThanOrEqual(9000);
    expect(output.startsWith("HTTP/1.1 200 OK\n")).toBe(true);
    expect(output).toContain("[output omitted]");
    expect(output).toContain("The term '2>&1' is not recognized");
    expect(output).toContain("Cannot find path 'output.txt'");
    expect(output.endsWith("Command exited with code 1")).toBe(true);
    const summary = summarizeToolFailure(output);
    expect(summary.length).toBeLessThanOrEqual(240);
    expect(summary.startsWith("Command exited with code 1")).toBe(true);
    expect(summary).toContain("Cannot find path 'output.txt'");
    expect(summary).not.toContain("HTTP/1.1 200");
  });

  it("keeps the original successful-output truncation regardless of text mentioning errors", () => {
    const text = response + failure;
    expect(retainToolOutput(text, false)).toBe(text.slice(0, 9000));
    expect(retainToolOutput("Error: a quoted message in a successful result", false)).toBe("Error: a quoted message in a successful result");
  });

  it.each([false, true])("keeps short output unchanged for isError=%s", isError => {
    expect(retainToolOutput("short output\n", isError)).toBe("short output\n");
    expect(retainToolOutput("", isError)).toBe("");
    expect(retainToolOutput("x".repeat(9000), isError)).toHaveLength(9000);
  });

  it.each([
    "ENOENT: file is missing\n" + "additional detail\n".repeat(30),
    "EISDIR: illegal operation on a directory, read",
    "ParserError: unexpected token",
    "TypeError: invalid argument",
    "System.InvalidOperationException: invalid state",
  ])("retains a specific reported exception: %s", text => {
    expect(summarizeToolFailure(text)).toBe(text.split("\n")[0]);
  });

  it.each(["Command timed out after 5 seconds", "Command aborted", "Command exited with code -1"])("prioritizes terminal status: %s", status => {
    expect(summarizeToolFailure(response + status)).toBe(status);
  });

  it("uses the tail when an already-failed tool has an unknown diagnostic format", () => {
    const summary = summarizeToolFailure(response + "final diagnostic from an unfamiliar tool");
    expect(summary.length).toBeLessThanOrEqual(240);
    expect(summary.startsWith("…")).toBe(true);
    expect(summary.endsWith("final diagnostic from an unfamiliar tool")).toBe(true);
    expect(summary).not.toContain("HTTP/1.1 200");
  });

  it("bounds a long actual exception while retaining its exit status", () => {
    const summary = summarizeToolFailure("Error: " + "specific failure ".repeat(40) + "\nCommand exited with code 2");
    expect(summary).toHaveLength(240);
    expect(summary.startsWith("Command exited with code 2 · Error: specific failure")).toBe(true);
    expect(summary.endsWith("…")).toBe(true);
  });
});
