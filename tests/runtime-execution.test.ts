import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { scheduledTools, executionContext } from "../src/runtime/execution.js";
import { defaultConfig } from "../src/config.js";
import type { RunRequest, Step } from "../src/types.js";

const run = promisify(execFile);
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
async function httpFixture() {
  const root = await mkdtemp(join(tmpdir(), "xloom-http-test-")); roots.push(root);
  const received: { url: string; body: string; cookie?: string; auth?: string }[] = [];
  const ports = new Set<number>();
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url!, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie, auth: req.headers["x-identity"] as string });
    ports.add(req.socket.remotePort!);
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/must-not-follow", "Set-Cookie": "identity=other" }); res.end(); }
    else if (req.url === "/slow") { /* caller must cancel; no retry */ }
    else { res.writeHead(req.url === "/denied" ? 403 : 200, { "Content-Type": "application/octet-stream", "Set-Cookie": "identity=other" }); res.end(Buffer.from([0, 255, 65])); }
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const log = join(root, "evidence.jsonl");
  async function shell(source: string) {
    return run("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; . ${quote(resolve("resources/runtime/http-client.ps1"))}; $client=New-XloomHttpClient; try { ${source} } finally { $client.Dispose() }`],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  }
  return { root, url, log, shell, received, ports };
}

describe("Execute HTTP client", () => {
  it("reuses a connection, records exact body bytes, and keeps identities and redirects explicit", async () => {
    const f = await httpFixture();
    await f.shell(`$null=Invoke-XloomHttp -Client $client -Uri '${f.url}/first' -EvidenceFile ${quote(f.log)};
      $null=Invoke-XloomHttp -Client $client -Uri '${f.url}/denied' -Method POST -Headers @{'X-Identity'='alice'; 'Cookie'='identity=alice'; 'Content-Type'='text/plain'} -Body ([Text.Encoding]::UTF8.GetBytes('body-你好')) -EvidenceFile ${quote(f.log)};
      $null=Invoke-XloomHttp -Client $client -Uri '${f.url}/redirect' -EvidenceFile ${quote(f.log)};
      $null=Invoke-XloomHttp -Client $client -Uri '${f.url}/last' -EvidenceFile ${quote(f.log)};`);
    expect(f.received).toHaveLength(4); expect(f.ports.size).toBe(1);
    expect(f.received[1]).toMatchObject({ body: "body-你好", cookie: "identity=alice", auth: "alice" });
    expect(f.received[0].cookie).toBeUndefined(); expect(f.received[3].cookie).toBeUndefined();
    const records = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(r => r.Status)).toEqual([200, 403, 302, 200]);
    expect(records[0].BodyBase64).toBe(Buffer.from([0, 255, 65]).toString("base64"));
    expect(records[0].Request.BodyBase64).toBe("");
    expect(Buffer.from(records[1].Request.BodyBase64, "base64").toString()).toBe("body-你好");
    expect(records.every(r => Number.isFinite(r.DurationMs) && !Number.isNaN(Date.parse(r.StartedAt)))).toBe(true);
  });

  it("retains completed evidence after timeout without replaying the uncertain request", async () => {
    const f = await httpFixture();
    await expect(f.shell(`$null=Invoke-XloomHttp -Client $client -Uri '${f.url}/ok' -EvidenceFile ${quote(f.log)};
      $null=Invoke-XloomHttp -Client $client -Uri '${f.url}/slow' -TimeoutSeconds 1 -EvidenceFile ${quote(f.log)}`)).rejects.toThrow();
    expect(f.received.map(r => r.url)).toEqual(["/ok", "/slow"]);
    expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("reports an evidence write failure after one request without replay", async () => {
    const f = await httpFixture();
    await expect(f.shell(`$null=Invoke-XloomHttp -Client $client -Uri '${f.url}/ok' -EvidenceFile ${quote(join(f.root, "missing", "log"))}`)).rejects.toThrow();
    expect(f.received).toHaveLength(1);
  });
});

describe("Execute scheduling and reuse", () => {
  it("bounds concurrent reads and marks every other tool as sequential", async () => {
    let active = 0, peak = 0;
    const read = { name: "read", async execute() {
      active++; peak = Math.max(active, peak);
      await new Promise(r => setTimeout(r, 5)); active--;
      return { content: [{ type: "text", text: "read" }], details: {} };
    } } as AgentTool;
    const tools = scheduledTools([read, { ...read, name: "write" }, { ...read, name: "powershell" }, { ...read, name: "chrome" }]);
    expect(tools.map(t => t.executionMode)).toEqual(["parallel", "sequential", "sequential", "sequential"]);
    await Promise.all(Array.from({ length: 11 }, (_, i) => tools[0].execute(String(i), {})));
    expect(peak).toBe(4); expect(active).toBe(0);
    const aborted = AbortSignal.abort();
    await expect(tools[0].execute("cancelled", {}, aborted)).rejects.toThrow();
    await expect(tools[0].execute("after", {})).resolves.toMatchObject({ content: [{ text: "read" }] });
  });

  it("offers only completed prerequisite artifacts and keeps private logs out of the handoff", () => {
    const step = { id: "S0", status: "done", runId: "execute-safe" } as Step;
    const request = { mode: "execute", runDir: join("task", "runs", "current"), step: { from: ["F0", "F1"] },
      snapshot: { config: defaultConfig("fixture"), facts: [{ id: "F0", stepId: "S0" }, { id: "F1", stepId: "S1" }],
        steps: [step, { ...step, id: "S1", runId: "../escape" }, { ...step, id: "unrelated", runId: "other" }] } } as RunRequest;
    expect(executionContext(request)?.reusableArtifacts).toEqual([{ stepId: "S0", path: join("task", "runs", "execute-safe", "artifacts") }]);
    expect(executionContext({ ...request, mode: "decide" })).toBeUndefined();
  });
});
