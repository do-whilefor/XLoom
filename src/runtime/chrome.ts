import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { ProjectConfig } from "../types.js";

const require = createRequire(import.meta.url);
const parameters = {
  type: "object", properties: {
    action: { type: "string", enum: ["list", "describe", "call"] },
    tool: { type: "string", description: "Chrome tool name for describe/call." },
    args: { type: "object", additionalProperties: true, description: "Arguments from describe's inputSchema." },
  }, required: ["action"], additionalProperties: false,
};
const inputSchema = z.object({ action: z.enum(["list", "describe", "call"]), tool: z.string().min(1).optional(), args: z.record(z.unknown()).optional() }).strict();
const connectionHelp = "Use the already running Chrome; enable chrome://inspect/#remote-debugging and accept Chrome's connection prompt. No browser/profile was launched. After a timeout or disconnect, inspect page state before retrying an action.";
const maxText = 24_000;

export interface ChromeOptions {
  workspace: string;
  artifactsDirectory: string;
  config?: ProjectConfig["chrome"];
  signal?: AbortSignal;
}
export interface ChromeSession { tool: AgentTool; close(): Promise<void> }

/** A pinned Node entry point avoids npx downloads, shell quoting and wrapper child processes. */
export function chromeServerParameters(options: ChromeOptions): StdioServerParameters {
  const entry = join(dirname(require.resolve("chrome-devtools-mcp/package.json")), "build", "src", "bin", "chrome-devtools-mcp.js");
  return { command: process.execPath, args: [entry,
    "--autoConnect", `--channel=${options.config?.channel ?? "stable"}`,
    "--page-id-routing", "--experimental-devtools", "--experimental-vision", "--experimental-structured-content",
    "--experimental-include-all-pages", "--memory-debugging", "--category-experimental-third-party",
    "--category-experimental-webmcp", "--category-extensions", "--no-usage-statistics", "--no-performance-crux",
    "--screenshot-format=webp", "--screenshot-quality=85", "--screenshot-max-width=1920", "--screenshot-max-height=1080",
    `--workspace=${resolve(options.workspace)}`, `--workspace=${resolve(options.artifactsDirectory)}`,
  ], cwd: options.workspace, stderr: "ignore", env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" } };
}

/** One lazy stdio connection per Execute run; only the bridge process is owned by Xloom. */
export function createChromeSession(options: ChromeOptions,
  transportFactory: () => Transport | Promise<Transport> = async () => {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    return new StdioClientTransport(chromeServerParameters(options));
  }): ChromeSession {
  let client: Client | undefined;
  let transport: Transport | undefined;
  let ready: Promise<Tool[]> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    lifetime.abort();
    closing = (async () => { try { await client?.close(); } finally { await transport?.close(); } })();
    return closing;
  };
  const connect = (signal: AbortSignal) => ready ??= (async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    signal.throwIfAborted();
    const candidate = await transportFactory();
    if (signal.aborted) { await candidate.close(); signal.throwIfAborted(); }
    transport = candidate;
    client = new Client({ name: "xloom-chrome", version: "0.1.0" });
    await client.connect(transport, { signal, timeout: 30_000 });
    const tools: Tool[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 30_000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Chrome tool listing repeated a cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  })();
  const jsonResult = (value: unknown): AgentToolResult<unknown> => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });
  return {
    close,
    tool: {
      name: "chrome", label: "Chrome", description: "Control the user's running Chrome with its current login. list discovers tools; describe a tool before call. Page-scoped args require pageId. Results include original evidence paths; screenshots return images. No isolated contexts.",
      parameters,
      async execute(_id, value, toolSignal) {
        const input = inputSchema.parse(value);
        if (closed) throw new Error("Chrome connection is closed for this run.");
        if (options.config?.enabled === false) throw new Error("Chrome is disabled in this task's configuration.");
        const signal = AbortSignal.any([lifetime.signal, ...[options.signal, toolSignal].filter((item): item is AbortSignal => !!item)]);
        signal.throwIfAborted();
        if (input.action !== "list" && !input.tool) throw new Error("Chrome describe/call requires tool; use list to discover names.");
        if (input.args?.isolatedContext) throw new Error("Chrome uses the user's existing session; isolatedContext is unavailable.");
        let tools: Tool[];
        try { tools = await connect(signal); }
        catch (error) { await close(); throw new Error(`Chrome connection failed: ${error instanceof Error ? error.message : String(error)}. ${connectionHelp}`); }
        signal.throwIfAborted();
        if (input.action === "list") return jsonResult({ tools: tools.map(tool => ({ name: tool.name, description: tool.description?.split("\n")[0].slice(0, 180) })), next: "describe a tool for its inputSchema, then call it" });
        const tool = tools.find(tool => tool.name === input.tool);
        if (!tool) throw new Error(`Unknown Chrome tool: ${input.tool}. Use list.`);
        if (input.action === "describe") return jsonResult(tool);
        let result: CallToolResult;
        try { result = await client!.callTool({ name: tool.name, arguments: input.args ?? {} }, undefined, { signal, timeout: 120_000 }) as CallToolResult; }
        catch (error) { await close(); throw new Error(`Chrome call failed; it was not replayed: ${error instanceof Error ? error.message : String(error)}. ${connectionHelp}`); }
        signal.throwIfAborted();
        const artifactBase = join(options.artifactsDirectory, `chrome-${randomUUID()}`);
        const artifact = `${artifactBase}.json`;
        await mkdir(options.artifactsDirectory, { recursive: true });
        await writeFile(artifact, JSON.stringify({ tool: tool.name, args: input.args ?? {}, observedAt: new Date().toISOString(), result }, null, 2), { flag: "wx", mode: 0o600 });
        const content: AgentToolResult<unknown>["content"] = [];
        const images: string[] = [];
        let remaining = maxText;
        for (const part of result.content) {
          if (part.type === "image") {
            const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[part.mimeType] ?? "bin";
            const file = `${artifactBase}-${images.length + 1}.${extension}`;
            await writeFile(file, Buffer.from(part.data, "base64"), { flag: "wx", mode: 0o600 });
            images.push(file);
            content.push({ type: "image", data: part.data, mimeType: part.mimeType });
          }
          else {
            const text = part.type === "text" ? part.text : JSON.stringify(part);
            if (remaining > 0) content.push({ type: "text", text: text.slice(0, remaining) });
            remaining -= text.length;
          }
        }
        if (!result.content.length && result.structuredContent) {
          const text = JSON.stringify(result.structuredContent);
          content.push({ type: "text", text: text.slice(0, remaining) });
          remaining -= text.length;
        }
        content.push({ type: "text", text: `${remaining < 0 ? "Output truncated. " : ""}Original Chrome result: ${artifact}${images.length ? `\nImages: ${images.join(", ")}` : ""}` });
        if (result.isError) throw new Error(content.filter(part => part.type === "text").map(part => part.text).join("\n"));
        return { content, details: { artifact, images, chromeTool: tool.name } };
      },
    },
  };
}
