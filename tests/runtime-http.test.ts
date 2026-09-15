import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { withHttpEvidence } from "../src/runtime/http.js";
import { executeTools } from "../src/runtime/pi-runner.js";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xloom-native-http-")); roots.push(root);
  const received: { path: string; method: string; body: Buffer; headers: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url!, method: request.method!, body: Buffer.concat(chunks), headers: request.headers });
    if (request.url === "/slow") return;
    if (request.url === "/write-failure") await rm(join(root, "http"), { recursive: true, force: true });
    if (request.url === "/large") { response.end(Buffer.alloc(16 * 1024 * 1024 + 1, 65)); return; }
    response.writeHead(request.url === "/redirect" ? 302 : request.url === "/denied" ? 403 : 200,
      { "Set-Cookie": "identity=other", ...(request.url === "/redirect" ? { Location: "/must-not-follow" } : {}) });
    response.end(Buffer.from([0, 255, 65]));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const exec = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "shell result" }], details: {} });
  const tool = withHttpEvidence({ name: "powershell", label: "powershell", description: "shell", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } }, execute: exec } as unknown as AgentTool, root);
  const call = async (args: unknown, signal?: AbortSignal) => JSON.parse((await tool.execute("fixture", args, signal)).content.filter(x => x.type === "text").map(x => x.text).join(""));
  return { root, url, received, exec, tool, call };
}

describe("automatic HTTP evidence", () => {
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
