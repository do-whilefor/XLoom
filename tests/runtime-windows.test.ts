import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTools } from "../src/runtime/index.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function workspace() { const directory = await mkdtemp(join(tmpdir(), "xloom-windows-test-")); directories.push(directory); return directory; }

describe.runIf(process.platform === "win32")("Windows Pi built-ins", () => {
  it("handles Chinese paths, UTF-8 read/write/edit and PowerShell output", async () => {
    const directory = await workspace();
    const [read, write, edit, powershell] = executeTools(directory);
    // Factory tools have different TypeBox schemas, so select named factories through their shared execute contract.
    await write.execute("write", { path: "中文 空格.txt", content: "第一行\n原始内容\n" } as never);
    await edit.execute("edit", { path: "中文 空格.txt", edits: [{ oldText: "原始内容", newText: "更新内容" }] } as never);
    const observed = await read.execute("read", { path: "中文 空格.txt" } as never);
    expect(JSON.stringify(observed.content)).toContain("更新内容");
    const result = await powershell.execute("powershell", { command: "Get-Content -LiteralPath '中文 空格.txt' -Encoding utf8", timeout: 10 } as never);
    expect(JSON.stringify(result.content)).toContain("更新内容");
  });

  it("aborts a running PowerShell command and terminates its child process", async () => {
    const directory = await workspace();
    const powershell = executeTools(directory)[3];
    const controller = new AbortController();
    let childPid: number | undefined;
    // Cancellation is triggered by the child's ready message, not by a fixed
    // startup delay. Allow both parser and shell to start under full-suite load;
    // this watchdog only prevents a broken readiness path from hanging the test.
    const timer = setTimeout(() => controller.abort(), 20000);
    const command = "$worker = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru\nWrite-Output \"child:$($worker.Id)\"\nStart-Sleep -Seconds 30";
    try {
      const result = powershell.execute("abort-test", { command, timeout: 25 } as never, controller.signal, (update) => {
        const match = JSON.stringify(update.content).match(/child:(\d+)/);
        if (match) { childPid = Number(match[1]); controller.abort(); }
      });
      await expect(result).rejects.toThrow(/abort/i);
      expect(childPid).toBeTypeOf("number");
      if (childPid !== undefined) expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (childPid !== undefined) { try { process.kill(childPid); } catch { /* Already terminated by Pi's process tree cancellation. */ } }
    }
  }, 30000);
});
