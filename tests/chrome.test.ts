import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromeServerParameters, createChromeSession, type ChromeSession } from "../src/runtime/chrome.js";
import { decidePrompt, executePrompt, metacogPrompt } from "../src/runtime/prompts.js";

const roots: string[] = [], sessions: ChromeSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(config?: { enabled?: boolean }, signal?: AbortSignal) {
  const root = await mkdtemp(join(tmpdir(), "xloom-chrome-")); roots.push(root);
  const options = { workspace: root, artifactsDirectory: join(root, "artifacts"), config, signal };
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/chrome-server.mjs", import.meta.url))], stderr: "ignore" });
  const factory = vi.fn(() => transport);
  const session = createChromeSession(options, factory); sessions.push(session);
  const call = (action: string, tool?: string, args?: object, signal?: AbortSignal) => session.tool.execute("test", { action, ...(tool ? { tool } : {}), ...(args ? { args } : {}) }, signal);
  return { root, options, transport, session, factory, call };
}
describe("Chrome attach-only tool", () => {
  it("pins a direct Node entry, attach-only flags and local output roots with no update subprocess", async () => {
    const { options } = await fixture();
    const parameters = chromeServerParameters({ ...options, config: { channel: "beta" } });
    expect(parameters.command).toBe(process.execPath);
    expect(parameters.args).toContain("--autoConnect");
    expect(parameters.args).toContain("--channel=beta");
    expect(parameters.args).toContain("--no-usage-statistics");
    expect(parameters.args).toContain("--no-performance-crux");
    expect(parameters.env).toMatchObject({ CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" });
    expect(parameters.args!.slice(1).some(arg => /isolated|headless|executable|user-data|browserUrl|wsEndpoint|allow-unrestricted/i.test(arg))).toBe(false);
    expect(parameters.args).toContain(`--workspace=${options.artifactsDirectory}`);
    // Parse the exact shipped flags in the pinned package without ever connecting to Chrome.
    const help = execFileSync(parameters.command, [...parameters.args!, "--help"], { encoding: "utf8", env: { ...process.env, ...parameters.env }, windowsHide: true });
    expect(help).toContain("--autoConnect");
    expect(help).not.toContain("Unknown arguments");
  });
  it("starts lazily, paginates discovery, returns schemas and reuses one client", async () => {
    const { factory, call } = await fixture();
    expect(factory).not.toHaveBeenCalled();
    const inventory = await call("list");
    expect(JSON.parse((inventory.content[0] as any).text).tools.map((tool: any) => tool.name)).toContain("new_page");
    const schema = await call("describe", "echo");
    expect(JSON.parse((schema.content[0] as any).text).inputSchema.type).toBe("object");
    await call("call", "echo", { value: "same session" });
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("discovers the pinned server's enabled capabilities without attaching to a browser", async () => {
    const { options } = await fixture();
    const session = createChromeSession(options); sessions.push(session);
    const result = await session.tool.execute("list", { action: "list" });
    const names = JSON.parse((result.content[0] as any).text).tools.map((tool: any) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_pages", "new_page", "evaluate_script", "take_screenshot", "click_at", "list_extensions", "list_webmcp_tools", "take_heapsnapshot"]));
    const description = await session.tool.execute("describe", { action: "describe", tool: "take_snapshot" });
    expect(JSON.parse((description.content[0] as any).text).inputSchema.required).toContain("pageId");
  });
  it("archives exact arguments and results as evidence and forwards images to Pi", async () => {
    const { call } = await fixture();
    const result = await call("call", "echo", { value: "literal \"\\n 中文" });
    const raw = JSON.parse(await readFile(result.details.artifact, "utf8"));
    expect(raw).toMatchObject({ tool: "echo", args: { value: "literal \"\\n 中文" }, result: { content: result.content.slice(0, 1) } });
    const image = await call("call", "image");
    expect(image.content[0]).toEqual({ type: "image", data: "dGVzdA==", mimeType: "image/webp" });
    expect(await readFile(image.details.images[0], "utf8")).toBe("test");
    const structured = await call("call", "structured");
    expect(JSON.parse((structured.content[0] as any).text)).toEqual({ answer: 42 });
  });
  it("bounds model text while retaining the full original and reports upstream errors as tool errors", async () => {
    const { root, call } = await fixture();
    const result = await call("call", "large");
    expect((result.content[0] as any).text).toHaveLength(24000);
    expect((result.content[1] as any).text).toContain("truncated");
    expect(JSON.parse(await readFile(result.details.artifact, "utf8")).result.content[0].text).toHaveLength(30000);
    await expect(call("call", "failure")).rejects.toThrow("Fixture tool failed");
    const files = await readdir(join(root, "artifacts"));
    expect(files).toHaveLength(2);
  });
  it("rejects invalid actions, names and isolated contexts without executing them", async () => {
    const { factory, call } = await fixture();
    await expect(call("launch")).rejects.toThrow();
    await expect(call("call")).rejects.toThrow("requires tool");
    await expect(call("call", "new_page", { isolatedContext: "incognito" })).rejects.toThrow("existing session");
    expect(factory).not.toHaveBeenCalled();
    await expect(call("call", "unknown")).rejects.toThrow("Unknown Chrome tool");
  });
  it("does not spawn for disabled, unused or already cancelled runs", async () => {
    const disabled = await fixture({ enabled: false });
    await expect(disabled.call("list")).rejects.toThrow("disabled");
    expect(disabled.factory).not.toHaveBeenCalled();
    const unused = await fixture(); await unused.session.close();
    expect(unused.factory).not.toHaveBeenCalled();
    const aborted = await fixture();
    await expect(aborted.call("list", undefined, undefined, AbortSignal.abort())).rejects.toThrow();
    expect(aborted.factory).not.toHaveBeenCalled();
  });
  it.each(["tool", "run"])("cancels an in-flight call via %s, reaps the child and never replays the action", async kind => {
    const controller = new AbortController();
    const { call, factory, transport, session } = await fixture(undefined, kind === "run" ? controller.signal : undefined);
    await call("list"); const pid = transport.pid!;
    const pending = call("call", "hang", {}, kind === "tool" ? AbortSignal.timeout(100) : undefined);
    if (kind === "run") setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow("not replayed");
    await expect(call("call", "echo")).rejects.toThrow("closed");
    await session.close(); await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("closes a transport acquired after cancellation without starting it", async () => {
    const { options } = await fixture(), acquired = Promise.withResolvers<any>(), started = Promise.withResolvers<void>();
    const transport = { close: vi.fn(async () => {}), start: vi.fn() };
    const session = createChromeSession(options, async () => { started.resolve(); return acquired.promise; }); sessions.push(session);
    const pending = session.tool.execute("test", { action: "list" });
    const failed = expect(pending).rejects.toThrow("connection failed");
    await started.promise; await session.close(); acquired.resolve(transport); await failed;
    expect(transport.start).not.toHaveBeenCalled(); expect(transport.close).toHaveBeenCalledTimes(1);
  });
  it("reports transport failure and clears the connection without restarting Chrome", async () => {
    const { call, factory } = await fixture();
    await expect(call("call", "disconnect")).rejects.toThrow("No browser/profile was launched");
    await expect(call("list")).rejects.toThrow("closed");
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("reports startup failure with actionable attach instructions and cleans transport", async () => {
    const { options } = await fixture();
    const transport = new StdioClientTransport({ command: join(options.workspace, "missing-executable"), stderr: "ignore" });
    const session = createChromeSession(options, () => transport); sessions.push(session);
    await expect(session.tool.execute("test", { action: "list" })).rejects.toThrow("chrome://inspect/#remote-debugging");
    await session.close();
  });
  it("keeps role prompts short and exposes only one concise tool description", async () => {
    const { session } = await fixture();
    expect(decidePrompt.length).toBeLessThanOrEqual(760);
    expect(executePrompt.length).toBeLessThanOrEqual(660);
    expect(metacogPrompt.length).toBeLessThanOrEqual(960);
    expect(session.tool.description.length).toBeLessThan(300);
  });
});
