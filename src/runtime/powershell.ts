import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalPowerShellOperations, createPowerShellTool, type PowerShellOperations } from "@earendil-works/pi-coding-agent";

export const powerShellPrompt = `Write raw PowerShell; no Markdown escapes. Backslash does not escape PowerShell quotes. Use single-quoted literals: '"' for a double quote, 'it''s' for an apostrophe. Put complex scripts in files; pipe loops via & { ... }. Fix syntax errors before retrying; inspect runtime side effects before replaying. Discover executables; do not assume python3 exists on Windows.`;

const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const syntaxExitCode = 65;
const syntaxHelp = "\nFix the reported PowerShell source before retrying. Check matching parentheses; split deeply nested method arguments into named temporary variables. Backslash does not escape quotes in PowerShell. Use single-quoted literals: '\"' for a double quote and 'it''s' for an apostrophe. Do not add Markdown escapes such as \\_ or \\: to raw commands. For complex data, write a JSON/text file and read it with Get-Content -LiteralPath. No command text was repaired or replayed automatically.\n";

function checkedScript(path: string): string {
  // Keep parser variables/preferences out of the user's scope. Execute in-memory
  // source so $PSScriptRoot/$PSCommandPath do not become the temporary directory.
  // Capture $? INSIDE that script block: invoking a block resets its status.
  const state = `$xloomExecution${randomUUID().replaceAll("-", "")}`;
  return `& {
$ErrorActionPreference = 'Stop'
try {
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(${quoteLiteral(path)}, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) {
    Write-Output 'PowerShell ParserError: command was not executed (syntax preflight).'
    foreach ($issue in $parseErrors) {
      Write-Output ('Line {0}, column {1} ({2}): {3}' -f $issue.Extent.StartLineNumber, $issue.Extent.StartColumnNumber, $issue.ErrorId, $issue.Message)
    }
    Write-Output ${quoteLiteral(syntaxHelp)}
    exit ${syntaxExitCode}
  }
} catch {
  Write-Output ('PowerShell syntax preflight failed; command was not executed: {0}' -f $_.Exception.Message)
  exit 1
}
}
& {
  ${state} = @{ succeeded = $true; errors = 0 }
  . ([scriptblock]::Create([System.IO.File]::ReadAllText(${quoteLiteral(path)}) + "\`n" + '${state}.succeeded = $?')) 2>&1 | ForEach-Object {
    # Native stderr alone is not failure (successful programs also write it).
    # Caught/suppressed PowerShell errors never reach this stream.
    if ($_ -is [System.Management.Automation.ErrorRecord] -and $_.FullyQualifiedErrorId -notmatch '^NativeCommandError(?:Message)?$') { ${state}.errors++ }
    $_
  }
  if (${state}.errors -gt 0 -or ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) -or -not ${state}.succeeded) {
    Write-Output ('PowerShell execution diagnostics: unhandled errors={0}; final command succeeded={1}; last native exit code={2}. Inspect partial side effects before retrying; nothing was replayed.' -f ${state}.errors, ${state}.succeeded, $LASTEXITCODE)
    exit 1
  }
}`;
}

/** Parse only the supplied command, then run it unchanged once. Invoked scripts
 * have their own parsing/runtime failures after the outer command has started. */
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
      // One process parses and executes; the source stays off the Windows command
      // line. The BOM keeps ParseFile correct on both PowerShell 5.1 and 7.
      const directory = await mkdtemp(join(tmpdir(), "xloom-powershell-check-"));
      try {
        const source = join(directory, "command.ps1");
        await writeFile(source, `\uFEFF${command}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (options.signal?.aborted) throw new Error("aborted");
        const result = await operations.exec(checkedScript(source), cwd, { ...options, timeout: remainingTimeout() });
        if (result.exitCode === null) throw new Error("PowerShell process did not complete; inspect possible side effects before retrying.");
        return result;
      } catch (error) {
        // Setup and the process share the caller's timeout; retain its original value in
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
  tool.description += " Syntax preflight covers only supplied command text, not -File or dot-sourced scripts. A valid command runs unchanged once. Unhandled PowerShell errors or a nonzero last native exit fail the tool even if later output succeeds. Handle expected native exit codes explicitly (check the code, then exit 0); check each native result in multi-command scripts. " + powerShellPrompt;
  return tool;
}
