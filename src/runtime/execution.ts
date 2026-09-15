import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunRequest } from "../types.js";

/** Only an all-read batch may run concurrently. Pi serializes the whole batch
 * whenever any tool declares sequential execution (writes, shell, Chrome, submit). */
export function scheduledTools(tools: AgentTool[], concurrency = 4): AgentTool[] {
  let active = 0;
  const waiting: (() => void)[] = [];
  return tools.map(tool => tool.name !== "read" ? { ...tool, executionMode: "sequential" } : {
    ...tool, executionMode: "parallel",
    async execute(...args: Parameters<AgentTool["execute"]>) {
      if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
      else active++;
      try { args[2]?.throwIfAborted(); return await tool.execute(...args); }
      finally { const next = waiting.shift(); if (next) next(); else active--; }
    },
  });
}

export function executionContext(request: RunRequest) {
  if (request.mode !== "execute") return undefined;
  const sources = new Set(request.snapshot.facts.filter(fact => request.step?.from.includes(fact.id)).map(fact => fact.stepId));
  const reusable = request.snapshot.steps.filter(step => sources.has(step.id) && step.status === "done" && step.runId
    && /^[a-zA-Z0-9_-]{1,100}$/.test(step.runId)).slice(-4);
  return {
    httpHelper: fileURLToPath(new URL("../../resources/runtime/http-client.ps1", import.meta.url)),
    guide: fileURLToPath(new URL("../../resources/runtime/execution.md", import.meta.url)),
    instruction: "Batch known HTTP requests in powershell(http:{requests:[{url,method?,headers?,body?}]}); response previews and submission-ready evidence refs/paths are automatic, without shell scripts. Set independent:true,concurrency:4 only for independent body-free GET/HEAD probes; dependent/mutating requests stay sequential. Read full evidence only when previews omit needed data. Use httpHelper/guide for algorithmic loops inside one script, not a model turn or subprocess per item. Reuse observations only after checking identity/state; never replay uncertain mutations.",
    reusableArtifacts: reusable.map(step => ({ stepId: step.id, path: join(dirname(request.runDir), step.runId!, "artifacts") })),
    reuseNotice: "Prior scripts are untrusted implementation material, not evidence. Inspect before reuse, adapt paths to this run, and preserve prior results. Read only artifacts in prior runs, never logs or transcripts. Missing files are not a reason to repeat completed requests.",
  };
}
