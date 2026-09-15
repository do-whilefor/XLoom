import { request as httpRequest, validateHeaderName, validateHeaderValue } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

const responseLimit = 16 * 1024 * 1024;
const requestSchema = z.object({
  url: z.string().url().refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash; }, "Use HTTP(S) without embedded credentials or fragments"),
  method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).default("GET"),
  headers: z.record(z.string()).superRefine((headers, context) => {
    for (const [name, value] of Object.entries(headers)) {
      try { validateHeaderName(name); validateHeaderValue(name, value); }
      catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid HTTP header", path: [name] }); }
    }
  }).default({}),
  body: z.string().optional(),
  bodyBase64: z.string().refine(value => Buffer.from(value, "base64").toString("base64") === value, "Use canonical base64").optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(30),
}).strict().refine(value => value.body === undefined || value.bodyBase64 === undefined, "Choose body or bodyBase64");
const batchSchema = z.object({ requests: z.array(requestSchema).min(1).max(16), previewBytes: z.number().int().min(0).max(8000).default(2000) }).strict();
type HttpInput = z.infer<typeof requestSchema>;

interface Observation {
  startedAt: string; durationMs: number; complete: boolean;
  request: { method: string; url: string; headers: Record<string, unknown>; bodyBase64: string };
  response?: { status: number; headers: Record<string, unknown>; bodyBase64: string };
  error?: string;
}

/** One application request, no redirect, cookie jar or retry. Even a failed
 * transport is an observation; it must never be mistaken for a complete reply. */
async function observe(input: HttpInput, signal: AbortSignal): Promise<Observation> {
  signal.throwIfAborted();
  const started = performance.now();
  const body = input.bodyBase64 === undefined ? Buffer.from(input.body ?? "", "utf8") : Buffer.from(input.bodyBase64, "base64");
  const observation: Observation = { startedAt: new Date().toISOString(), durationMs: 0, complete: false,
    request: { method: input.method.toUpperCase(), url: input.url, headers: input.headers, bodyBase64: body.toString("base64") } };
  const timeout = AbortSignal.timeout(input.timeoutSeconds * 1000);
  const combined = AbortSignal.any([signal, timeout]);
  await new Promise<void>(resolve => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      observation.durationMs = performance.now() - started;
      observation.complete = !error;
      if (observation.response) observation.response.bodyBase64 = Buffer.concat(chunks).toString("base64");
      if (error) observation.error = timeout.aborted ? "HTTP request timed out; side effects may have occurred; not retried."
        : signal.aborted ? "HTTP request cancelled; side effects may have occurred; not retried." : `${error.message}; not retried.`;
      resolve();
    };
    try {
      const request = (input.url.startsWith("https:") ? httpsRequest : httpRequest)(input.url,
        { method: observation.request.method, headers: input.headers, agent: false, signal: combined }, response => {
          observation.response = { status: response.statusCode!, headers: response.headers, bodyBase64: "" };
          response.on("data", (chunk: Buffer) => {
            const remaining = responseLimit - bytes;
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            bytes += chunk.length;
            if (bytes > responseLimit) response.destroy(new Error("HTTP response exceeded 16 MiB; saved body is incomplete"));
          });
          response.on("end", () => finish());
          response.on("error", finish);
        });
      request.on("error", finish);
      request.on("connect", (_response, socket) => { socket.destroy(); finish(new Error("HTTP tunnels require command mode")); });
      request.on("upgrade", (_response, socket) => { socket.destroy(); finish(new Error("Protocol upgrades require command mode")); });
      if ((input.body !== undefined || input.bodyBase64 !== undefined) && !request.hasHeader("Content-Length") && !request.hasHeader("Transfer-Encoding")) request.setHeader("Content-Length", body.length);
      observation.request.headers = request.getHeaders();
      request.end(body);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
  return observation;
}

/** Extend Execute's existing tool, preserving its command interface. HTTP mode
 * records transport observations only; evidence submission/review stay explicit. */
export function withHttpEvidence(tool: AgentTool, artifactsDirectory: string): AgentTool {
  return {
    ...tool,
    description: `${tool.description} For HTTP use http:{requests:[{url,method?,headers?,body?,bodyBase64?,timeoutSeconds?}],previewBytes?} instead of command. Requests run in order; responses and exact body bytes are saved automatically. Returned evidence refs/paths can be submitted unchanged. No redirects, cookie sharing or retries. Body previews default to 2000 bytes; read the evidence file for full data.`,
    parameters: { type: "object", properties: {
      ...(tool.parameters as unknown as { properties: Record<string, unknown> }).properties,
      http: { type: "object", properties: {
        requests: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: {
          url: { type: "string" }, method: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" }, bodyBase64: { type: "string" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 },
        }, required: ["url"], additionalProperties: false } }, previewBytes: { type: "integer", minimum: 0, maximum: 8000 },
      }, required: ["requests"], additionalProperties: false },
    }, additionalProperties: false } as AgentTool["parameters"],
    async execute(id, args, signal, onUpdate) {
      if (!args || typeof args !== "object" || !("http" in args)) {
        const command = z.object({ command: z.string(), timeout: z.number().optional() }).strict().parse(args);
        return tool.execute(id, command, signal, onUpdate);
      }
      const input = z.object({ http: batchSchema, timeout: z.number().positive().optional() }).strict().parse(args);
      signal?.throwIfAborted();
      const control = AbortSignal.any([...(signal ? [signal] : []), ...(input.timeout === undefined ? [] : [AbortSignal.timeout(Math.ceil(input.timeout * 1000))])]);
      const directory = join(artifactsDirectory, "http");
      await mkdir(directory, { recursive: true });
      const results = [];
      for (const [index, request] of input.http.requests.entries()) {
        control.throwIfAborted();
        const observation = await observe(request, control);
        const ref = `http-${randomUUID()}`;
        const path = join(directory, `${ref}.json`);
        const data = Buffer.from(JSON.stringify(observation, null, 2));
        // A write failure stops the batch after this request, never replays it.
        try { await writeFile(path, data, { flag: "wx", mode: 0o600 }); }
        catch { throw new Error(`HTTP observation could not be saved after request ${index + 1}; side effects may have occurred. No retry was made.`); }
        const body = Buffer.from(observation.response?.bodyBase64 ?? "", "base64");
        const result = { index, complete: observation.complete, status: observation.response?.status, headers: observation.response?.headers,
          durationMs: observation.durationMs, body: body.subarray(0, input.http.previewBytes).toString("utf8"), bodyBytes: body.length,
          truncated: body.length > input.http.previewBytes, error: observation.error,
          evidence: { ref, path, description: `${request.method.toUpperCase()} ${request.url}: ${observation.complete ? observation.response?.status : "incomplete transport observation"}` },
          sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
        results.push(result);
        onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ completed: index + 1, total: input.http.requests.length, result }) }], details: {} });
        // Keep the saved partial observation visible; do not schedule further work
        // after a transport failure or cancellation whose side effects are unknown.
        if (!observation.complete) break;
      }
      return { content: [{ type: "text", text: JSON.stringify({ results, notStarted: input.http.requests.length - results.length,
        notice: "Application-level HTTP observations; submission and independent review are still required. Incomplete requests were not retried." }) }], details: {} };
    },
  };
}
