import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { disposeHttpTool, withHttpEvidence } from "../src/runtime/http.js";
import { executeTools } from "../src/runtime/pi-runner.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import type { RunRequest, Step } from "../src/types.js";

const roots: string[] = [], servers: Server[] = [];
const tools: AgentTool[] = [];
afterEach(async () => {
  tools.splice(0).forEach(disposeHttpTool);
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xloom-native-http-")); roots.push(root);
  const received: { path: string; method: string; body: Buffer; headers: Record<string, unknown>; port: number }[] = [];
  const completed: string[] = [];
  let active = 0, peak = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url!, method: request.method!, body: Buffer.concat(chunks), headers: request.headers, port: request.socket.remotePort! });
    if (request.url === "/slow") return;
    if (request.url === "/reset") { request.socket.destroy(); return; }
    if (request.url?.startsWith("/parallel/")) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, Number(request.url!.split("/").at(-1)) % 2 ? 60 : 30));
      active--;
    }
    if (request.url === "/write-failure") await rm(join(root, "http"), { recursive: true, force: true });
    if (request.url === "/large") { response.end(Buffer.alloc(16 * 1024 * 1024 + 1, 65)); return; }
    response.writeHead(request.url === "/redirect" ? 302 : request.url === "/denied" ? 403 : 200,
      { "Set-Cookie": "identity=other", ...(request.url === "/redirect" ? { Location: "/must-not-follow" } : {}) });
    response.end(request.url === "/text" ? "fixture-你好" : Buffer.from([0, 255, 65]));
    completed.push(request.url!);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const exec = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "shell result" }], details: {} });
  const tool = withHttpEvidence({ name: "powershell", label: "powershell", description: "shell", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } }, execute: exec } as unknown as AgentTool, root);
  tools.push(tool);
  const call = async (args: unknown, signal?: AbortSignal) => JSON.parse((await tool.execute("fixture", args, signal)).content.filter(x => x.type === "text").map(x => x.text).join(""));
  return { root, url, received, exec, tool, call, completed, peak: () => peak };
}

describe("automatic HTTP evidence", () => {
  it.each(["success", "failure", "cancel"])("disposes the real Pi runner's HTTP session on %s", async outcome => {
    const f = await fixture();
    const model: Model<"openai-completions"> = { api: "openai-completions", id: "fixture", provider: "fixture", name: "fixture", baseUrl: "https://example.invalid",
      reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    let calls = 0;
    let captured: AgentTool | undefined;
    const control = new AbortController();
    const runner = new PiRunner({ createAgent: options => { captured = options.initialState!.tools!.find(tool => tool.name === "powershell"); return new Agent(options); },
      resolveModel: async () => ({ model, streamFn: () => {
        const first = calls++ === 0;
        const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
          content: first ? [{ type: "toolCall", id: "http", name: "powershell", arguments: { http: { requests: [{ url: `${f.url}/text` }] } } }]
            : [{ type: "text", text: JSON.stringify({ summary: "Synthetic transport fixture", result: "no_progress" }) }],
          stopReason: first ? "toolUse" : outcome === "failure" ? "error" : "stop", ...(outcome === "failure" ? { errorMessage: "Deliberate terminal fixture failure" } : {}),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream();
        queueMicrotask(() => { if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
        return stream;
      } }) });
    const config = defaultConfig("Synthetic HTTP fixture"); config.chrome = { enabled: false };
    const step: Step = { id: "S1", goalId: "G0", description: "Read fixture", successSignal: "Response captured", evidencePlan: "HTTP observation", from: [], priority: 1, status: "claimed", attempts: 1, runId: "execute-fixture", leaseUntil: null };
    const request: RunRequest = { id: "execute-fixture", mode: "execute", workspace: f.root, runDir: join(f.root, "run"), step, signal: control.signal,
      onEvent: event => { if (outcome === "cancel" && event.type === "tool_end") control.abort(); },
      snapshot: { revision: 0, config, status: "running", outcome: null, reason: "fixture", goals: [{ id: "G0", parentId: null, description: "fixture", status: "active", factIds: [] }],
        steps: [step], facts: [], evidence: [], findings: [], hints: [], completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0, usage: { input: 0, output: 0, cost: 0 } } };
    if (outcome === "success") await expect(runner.run(request)).resolves.toMatchObject({ output: { result: "no_progress" } });
    else await expect(runner.run(request)).rejects.toThrow();
    expect(f.received).toHaveLength(1);
    await expect(captured!.execute("closed", { http: { requests: [{ url: f.url }] } })).rejects.toThrow("session is closed");
    const folder = join(f.root, "run", "artifacts", "http");
    const observation = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]), "utf8"));
    expect(observation.response.body).toBe("fixture-你好");
    expect(Buffer.from(observation.response.bodyBase64, "base64").toString()).toBe(observation.response.body);
  });

  it("reuses same-identity connections across calls, isolates changed identities and closes the session", async () => {
    const f = await fixture();
    for (const identity of ["alice", "alice", "bob", "alice"]) await f.call({ http: { requests: [{ url: f.url, headers: { "X-Identity": identity } }] } });
    expect(f.received[0].port).toBe(f.received[1].port);
    expect(f.received[2].port).not.toBe(f.received[0].port);
    expect(f.received[3].port).toBe(f.received[0].port);
    disposeHttpTool(f.tool);
    await expect(f.call({ http: { requests: [{ url: f.url }] } })).rejects.toThrow("session is closed");
    expect(f.received).toHaveLength(4);
  });

  it("bounds idle identity pools without mixing headers or replaying requests", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) await f.call({ http: { requests: [{ url: f.url, headers: { "X-Identity": String(i) } }] } });
    await f.call({ http: { requests: [{ url: f.url, headers: { "X-Identity": "0" } }] } });
    expect(f.received).toHaveLength(11);
    expect(f.received[10].port).not.toBe(f.received[0].port);
    expect(f.received.map(x => x.headers["x-identity"])).toEqual([...Array.from({ length: 10 }, (_, i) => String(i)), "0"]);
  });

  it("bounds explicitly independent read batches and returns receipts in request order", async () => {
    const f = await fixture();
    const output = await f.call({ http: { independent: true, concurrency: 4,
      requests: Array.from({ length: 11 }, (_, i) => ({ url: `${f.url}/parallel/${i}` })) } });
    expect(f.peak()).toBe(4);
    expect(output.results.map((x: { index: number }) => x.index)).toEqual(Array.from({ length: 11 }, (_, i) => i));
    expect(await readdir(join(f.root, "http"))).toHaveLength(11);
  });

  it("keeps sequential batches ordered and rejects unsafe concurrency before any request", async () => {
    const f = await fixture();
    for (const http of [
      { concurrency: 2, requests: [{ url: f.url }] },
      { concurrency: 2, independent: true, requests: [{ url: f.url }, { url: f.url, method: "POST" }] },
      { concurrency: 2, independent: true, requests: [{ url: f.url, body: "data" }] },
    ]) await expect(f.call({ http })).rejects.toThrow("Concurrent batches require");
    expect(f.received).toHaveLength(0);
    await f.call({ http: { requests: [1, 2, 3].map(i => ({ url: `${f.url}/parallel/${i}`, method: "POST" })) } });
    expect(f.peak()).toBe(1); expect(f.completed).toEqual(["/parallel/1", "/parallel/2", "/parallel/3"]);
  });

  it("drains in-flight read evidence after failure and leaves later requests unstarted", async () => {
    const f = await fixture();
    const output = await f.call({ http: { independent: true, concurrency: 2, requests: [
      { url: `${f.url}/reset` }, { url: `${f.url}/parallel/1` }, { url: `${f.url}/never` },
    ] } });
    expect(output.results.map((x: { complete: boolean }) => x.complete)).toEqual([false, true]);
    expect(output.notStarted).toBe(1); expect(f.received.map(x => x.path).sort()).toEqual(["/parallel/1", "/reset"]);
    expect(await readdir(join(f.root, "http"))).toHaveLength(2);
  });

  it("records exact sent/received bytes, hashes and ordered HTTP errors without invoking a shell", async () => {
    const f = await fixture();
    const body = Buffer.from([0, 255, 65]);
    const output = await f.call({ http: { requests: [
      { url: `${f.url}/denied`, method: "POST", headers: { Cookie: "identity=alice", "X-Identity": "alice" }, bodyBase64: body.toString("base64") },
      { url: `${f.url}/redirect` }, { url: `${f.url}/last`, method: "POST", body: "你好" },
    ], previewBytes: 2 } });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.received.map(x => x.path)).toEqual(["/denied", "/redirect", "/last"]);
    expect(f.received[0].body).toEqual(body); expect(f.received[2].body.toString()).toBe("你好");
    expect(f.received[0].headers.cookie).toBe("identity=alice"); expect(f.received[2].headers.cookie).toBeUndefined();
    expect(output.results.map((x: { status: number }) => x.status)).toEqual([403, 302, 200]);
    expect(output.notStarted).toBe(0);
    for (const result of output.results) {
      expect(result.complete).toBe(true); expect(result.truncated).toBe(true);
      const bytes = await readFile(result.evidence.path);
      expect(result.bytes).toBe(bytes.length); expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      const observation = JSON.parse(bytes.toString());
      expect(observation.response.bodyBase64).toBe(body.toString("base64"));
      expect(observation.request.headers.host).toBe(new URL(f.url).host);
      expect(observation.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.parse(await readFile(output.results[0].evidence.path, "utf8")).request.bodyBase64).toBe(body.toString("base64"));
  });

  it("validates the entire batch before any request, including ambiguous modes and payloads", async () => {
    const f = await fixture();
    for (const args of [
      { command: "echo no", http: { requests: [{ url: f.url }] } },
      { http: { requests: [{ url: f.url }, { url: "file:///private" }] } },
      { http: { requests: [{ url: f.url }, { url: f.url, headers: { "X-Invalid": "one\r\ntwo" } }] } },
      { http: { requests: [{ url: f.url, body: "x", bodyBase64: "eA==" }] } },
      { http: { requests: [{ url: f.url, bodyBase64: "not base64" }] } },
      { http: { requests: [{ url: "http://secret:password@127.0.0.1" }] } },
      {},
    ]) await expect(f.call(args)).rejects.toThrow();
    expect(f.received).toHaveLength(0); expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancel"])("retains completed and partial observations after %s without retrying or starting later requests", async kind => {
    const f = await fixture();
    const control = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (kind === "cancel") timer = setInterval(() => { if (f.received.some(x => x.path === "/slow")) control.abort(); }, 5);
    try {
      const output = await f.call({ http: { requests: [{ url: f.url }, { url: `${f.url}/slow`, timeoutSeconds: 1 }, { url: `${f.url}/never` }] } }, control.signal);
      expect(output.results.map((x: { complete: boolean }) => x.complete)).toEqual([true, false]);
      expect(output.results[1].error).toContain(kind === "timeout" ? "timed out" : "cancelled");
      expect(output.notStarted).toBe(1); expect(f.received.map(x => x.path)).toEqual(["/", "/slow"]);
      expect(await readdir(join(f.root, "http"))).toHaveLength(2);
    } finally { clearInterval(timer); }
  });

  it("records an oversized response as incomplete and stops the batch", async () => {
    const f = await fixture();
    const output = await f.call({ http: { requests: [{ url: `${f.url}/large` }, { url: `${f.url}/never` }], previewBytes: 0 } });
    expect(output.results[0]).toMatchObject({ complete: false, bodyBytes: 16 * 1024 * 1024, body: "" });
    expect(output.results[0].error).toContain("incomplete"); expect(output.notStarted).toBe(1);
  });

  it("does not repeat a request after an evidence write failure", async () => {
    const f = await fixture();
    await expect(f.call({ http: { requests: [{ url: `${f.url}/write-failure` }, { url: `${f.url}/never` }] } })).rejects.toThrow("could not be saved after request 1");
    expect(f.received).toHaveLength(1);
  });

  it("preserves command mode and exposes HTTP only when Execute has an artifact directory", async () => {
    const f = await fixture();
    await f.tool.execute("command", { command: "Write-Output 'fixture'", timeout: 2 });
    expect(f.exec).toHaveBeenCalledWith("command", { command: "Write-Output 'fixture'", timeout: 2 }, undefined, undefined);
    expect(executeTools(f.root)[3].description).not.toContain("http:{requests");
    expect(executeTools(f.root, f.root)[3].description).toContain("http:{requests");
  });
});
