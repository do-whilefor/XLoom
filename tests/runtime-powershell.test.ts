import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PowerShellOperations } from "@earendil-works/pi-coding-agent";
import { createCheckedPowerShellOperations, createCheckedPowerShellTool, powerShellPrompt } from "../src/runtime/powershell.js";
import { decidePrompt, executePrompt, metacogPrompt } from "../src/runtime/prompts.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "xloom-powershell-test-"));
  directories.push(directory);
  return directory;
}

function parserSourcePath(command: string) {
  const match = command.match(/::ParseFile\('((?:[^']|'')*)',/);
  expect(match).not.toBeNull();
  return match![1].replaceAll("''", "'");
}

describe("PowerShell syntax preflight", () => {
  it("parses source as file data and executes the identical command exactly once", async () => {
    const command = String.raw`$items = @('"', 'it''s', 'C:\tmp\a_b.txt', 'http\://example.invalid', 'literal\_name')
$items | ConvertTo-Json -Compress`;
    let sourcePath = "";
    const seen: string[] = [];
    const signal = new AbortController().signal;
    const env = { TASK_TEST: "yes" };
    const onData = vi.fn();
    const operations: PowerShellOperations = { exec: async (source, cwd, options) => {
      seen.push(source);
      expect(cwd).toBe("workspace");
      expect(options.signal).toBe(signal);
      expect(options.env).toBe(env);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(10);
      if (seen.length === 1) {
        sourcePath = parserSourcePath(source);
        expect(await readFile(sourcePath, "utf8")).toBe(`\uFEFF${command}`);
        expect(source).not.toContain(command);
        return { exitCode: 0 };
      }
      options.onData(Buffer.from("observed output"));
      return { exitCode: 0 };
    } };
    await expect(createCheckedPowerShellOperations(operations).exec(command, "workspace", { onData, signal, env, timeout: 10 })).resolves.toEqual({ exitCode: 0 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(command);
    expect(onData).toHaveBeenCalledExactlyOnceWith(Buffer.from("observed output"));
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(dirname(sourcePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns parser diagnostics and actionable quoting guidance without running invalid source", async () => {
    const command = '$words = @("alpha",""","omega")';
    const onData = vi.fn();
    const exec = vi.fn<PowerShellOperations["exec"]>(async (source, _cwd, options) => {
      expect(source).not.toBe(command);
      options.onData(Buffer.from("PowerShell ParserError: Line 1, column 24"));
      return { exitCode: 65 };
    });
    await expect(createCheckedPowerShellOperations({ exec }).exec(command, "workspace", { onData })).resolves.toEqual({ exitCode: 65 });
    expect(exec).toHaveBeenCalledTimes(1);
    const text = onData.mock.calls.map(([data]) => data.toString()).join("");
    expect(text).toContain("Line 1, column 24");
    expect(text).toContain("Backslash does not escape quotes");
    expect(text).toContain("No command text was repaired or replayed automatically");
  });

  it("does not replay a valid command after a runtime error", async () => {
    const exec = vi.fn<PowerShellOperations["exec"]>()
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 1 });
    await expect(createCheckedPowerShellOperations({ exec }).exec("Write-Output 'partial'; exit 1", "workspace", { onData() {} })).resolves.toEqual({ exitCode: 1 });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([1, null])("never executes source if the parser process exits with %s", async exitCode => {
    const exec = vi.fn<PowerShellOperations["exec"]>().mockResolvedValue({ exitCode });
    const result = createCheckedPowerShellOperations({ exec }).exec("Write-Output 'test'", "workspace", { onData() {} });
    if (exitCode === null) await expect(result).rejects.toThrow("preflight did not complete");
    else await expect(result).resolves.toEqual({ exitCode });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("uses one timeout across parsing and execution", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const exec = vi.fn<PowerShellOperations["exec"]>(async () => {
      now = 1500;
      return { exitCode: 0 };
    });
    await expect(createCheckedPowerShellOperations({ exec }).exec("Write-Output 'test'", "workspace", { onData() {}, timeout: 1 })).rejects.toThrow("timeout:1");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("cleans up parser source after cancellation and never starts the original command", async () => {
    const controller = new AbortController();
    let sourcePath = "";
    const exec = vi.fn<PowerShellOperations["exec"]>(async source => {
      sourcePath = parserSourcePath(source);
      controller.abort();
      throw new Error("aborted");
    });
    await expect(createCheckedPowerShellOperations({ exec }).exec("Write-Output 'test'", "workspace", { onData() {}, signal: controller.signal })).rejects.toThrow("aborted");
    expect(exec).toHaveBeenCalledTimes(1);
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps PowerShell quoting guidance in its tool description without duplicating it in system prompts", () => {
    const tool = createCheckedPowerShellTool("workspace");
    expect(tool.name).toBe("powershell");
    expect(tool.description).toContain(powerShellPrompt);
    expect(tool.description).toContain("Backslash does not escape PowerShell quotes");
    expect(tool.description).toContain("do not assume python3 exists on Windows");
    for (const prompt of [decidePrompt, executePrompt, metacogPrompt]) expect(prompt).not.toContain(powerShellPrompt);
  });

  it("allows truthful tool progress while retaining the final JSON contract in all research modes", () => {
    for (const prompt of [decidePrompt, executePrompt, metacogPrompt]) {
      expect(prompt).toContain("Brief factual progress narration is optional");
      expect(prompt).toContain("Never invent evidence or private reasoning");
      expect(prompt).toContain("Final response: one JSON object");
    }
  });
});

describe.runIf(process.platform === "win32")("PowerShell syntax regressions on Windows", () => {
  it("rejects the reported triple-double-quote list before any file side effect", async () => {
    const directory = await workspace();
    const tool = createCheckedPowerShellTool(directory);
    const command = `Set-Content -LiteralPath 'should-not-exist.txt' -Value 'side effect'
$words = @("alpha",""","omega")`;
    await expect(tool.execute("invalid-quote", { command, timeout: 10 })).rejects.toThrow(/PowerShell ParserError: command was not executed[\s\S]*Line 2, column/);
    await expect(readFile(join(directory, "should-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    String.raw`$words = @("alpha","\"","omega")`,
    String.raw`$words = @("alpha","'","\"","-","%",""+'"',"omega")`,
  ])("rejects the C-style quote escape seen in recorded commands: %s", async command => {
    const tool = createCheckedPowerShellTool(await workspace());
    await expect(tool.execute("recorded-quote-regression", { command, timeout: 10 })).rejects.toThrow(/PowerShell ParserError: command was not executed[\s\S]*Line 1, column[\s\S]*Backslash does not escape quotes/);
  });

  it("preserves valid quote literals, Unicode, paths and intentional backslashes", async () => {
    const directory = await workspace();
    const tool = createCheckedPowerShellTool(directory);
    const command = String.raw`$items = @('"', 'it''s', '中文', 'C:\tmp\a_b.txt', 'http\://example.invalid', 'literal\_name')
$items | ConvertTo-Json -Compress`;
    const result = await tool.execute("valid-quote", { command, timeout: 10 });
    const output = result.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
    expect(JSON.parse(output)).toEqual(['"', "it's", "中文", String.raw`C:\tmp\a_b.txt`, String.raw`http\://example.invalid`, String.raw`literal\_name`]);
  });
});
