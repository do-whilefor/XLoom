import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPowerShellOperations, createPowerShellTool, type PowerShellOperations } from "@earendil-works/pi-coding-agent";

export const powerShellPrompt = `Write raw PowerShell; no Markdown escapes. Backslash does not escape PowerShell quotes. Use single-quoted literals: '"' for a double quote, 'it''s' for an apostrophe. Put complex data/scripts in files. Fix syntax errors before retrying; inspect runtime side effects before replaying. Discover executables; do not assume python3 exists on Windows.`;

const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const syntaxExitCode = 65;
const syntaxHelp = "\nFix the reported PowerShell source before retrying. Backslash does not escape quotes in PowerShell. Use single-quoted literals: '\"' for a double quote and 'it''s' for an apostrophe. Do not add Markdown escapes such as \\_ or \\: to raw commands. For complex data, write a JSON/text file and read it with Get-Content -LiteralPath. No command text was repaired or replayed automatically.\n";

function parserScript(path: string): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(${quoteLiteral(path)}, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) {
    Write-Output 'PowerShell ParserError: command was not executed (syntax preflight).'
    foreach ($issue in $parseErrors) {
      Write-Output ('Line {0}, column {1} ({2}): {3}' -f $issue.Extent.StartLineNumber, $issue.Extent.StartColumnNumber, $issue.ErrorId, $issue.Message)
    }
    exit ${syntaxExitCode}
  }
  exit 0
} catch {
  Write-Output ('PowerShell syntax preflight failed; command was not executed: {0}' -f $_.Exception.Message)
  exit 1
}`;
}

/** Parse with Pi's PowerShell backend, then execute the unchanged source once. */
export function createCheckedPowerShellOperations(operations: PowerShellOperations = createLocalPowerShellOperations()): PowerShellOperations {
  return {
    async exec(command, cwd, options) {
      if (options.signal?.aborted) throw new Error("aborted");
      const startedAt = performance.now();
      const remainingTimeout = () => {
        if (options.timeout === undefined || !Number.isFinite(options.timeout) || options.timeout <= 0) return options.timeout;
        const remaining = options.timeout - (performance.now() - startedAt) / 1000;
        if (remaining <= 0) throw new Error(`timeout:${options.timeout}`);
        return remaining;
      };
      // A short parser command avoids expanding user input into a Windows command
      // line. The BOM keeps ParseFile correct on both PowerShell 5.1 and 7.
      const directory = await mkdtemp(join(tmpdir(), "xloom-powershell-check-"));
      try {
        const source = join(directory, "command.ps1");
        await writeFile(source, `\uFEFF${command}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const parsed = await operations.exec(parserScript(source), cwd, { ...options, timeout: remainingTimeout() });
        if (parsed.exitCode === syntaxExitCode) options.onData(Buffer.from(syntaxHelp));
        if (parsed.exitCode === null) throw new Error("PowerShell syntax preflight did not complete; command was not executed.");
        if (parsed.exitCode !== 0) return parsed;
        if (options.signal?.aborted) throw new Error("aborted");
        return await operations.exec(command, cwd, { ...options, timeout: remainingTimeout() });
      } catch (error) {
        // Both processes share the caller's timeout; retain its original value in
        // Pi's timeout diagnostic instead of reporting the remaining fraction.
        if (error instanceof Error && error.message.startsWith("timeout:") && options.timeout !== undefined) {
          throw new Error(`timeout:${options.timeout}`);
        }
        throw error;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export function createCheckedPowerShellTool(workspace: string) {
  const tool = createPowerShellTool(workspace, { operations: createCheckedPowerShellOperations() });
  tool.description += " Commands are syntax-checked without execution first; invalid syntax returns original source line/column diagnostics and quoting guidance. Valid commands are executed unchanged once. " + powerShellPrompt;
  return tool;
}
