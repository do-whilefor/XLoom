import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRequest } from "../types.js";
import { wikiFilename } from "../wiki/format.js";
import { discoverKnowledge } from "./discovery.js";
import { capabilityIssues, chainIssues } from "./model.js";

export function knowledgeContext(request: RunRequest) {
  if (!request.blackboardPath) return undefined;
  const board = request.snapshot, taskDirectory = dirname(request.blackboardPath);
  const directory = join(taskDirectory, "wiki", "pages");
  const page = (kind: string, id: string) => join(directory, wikiFilename(kind, id));
  const capabilities = (board.capabilities ?? []).slice().reverse().map(record => ({ id: record.id, title: record.title, status: record.status,
    reviewIssues: capabilityIssues(board, record), provides: record.provides.map(port => port.type), needs: record.needs.map(port => port.type),
    factIds: record.factIds, counterFactIds: record.counterFactIds, conditions: record.conditions, pageFile: page("capability", record.id) }));
  const chains = (board.chains ?? []).slice().reverse().map(record => ({ id: record.id, title: record.title, status: record.status,
    reviewIssues: chainIssues(board, record), capabilityIds: record.capabilityIds, resultFactIds: record.resultFactIds, pageFile: page("chain", record.id) }));
  const discovery = discoverKnowledge(board, { limit: 6, maxAlternatives: 6 });
  let used = 0;
  const deferred: { kind: string; id: string; pageFile: string }[] = [];
  const pack = <T>(values: T[], ref: (value: T) => { kind: string; id: string; pageFile: string }) => values.filter(value => {
    const size = JSON.stringify(value).length;
    if (used + size > 12000) { deferred.push(ref(value)); return false; }
    used += size; return true;
  });
  // Whole entries are deferred; conditions, negations and individual alternatives are never cut into fragments.
  const items = pack(discovery.items, item => ({ kind: "capability", id: item.consumerId, pageFile: page("capability", item.consumerId) }));
  const selectedCapabilities = pack(capabilities, item => ({ kind: "capability", id: item.id, pageFile: item.pageFile }));
  const selectedChains = pack(chains, item => ({ kind: "chain", id: item.id, pageFile: item.pageFile }));
  return { notice: "Task-local knowledge, not proof. Review changed sources first. Execute may submit optional capabilities/chains in existing final/checkpoint output; read authoringGuide before first submission. A chain cannot rate a Finding or complete a Goal. Read referenced pages and original Facts/Evidence before planning tests.",
    authoringGuide: fileURLToPath(new URL("../../resources/knowledge/authoring.md", import.meta.url)),
    capabilities: selectedCapabilities, chains: selectedChains, discovery: { ...discovery, items }, deferred,
    ...(request.mode === "execute" ? { local: { nodeExecutable: process.execPath, scriptFile: fileURLToPath(new URL("../../dist/wiki/local.js", import.meta.url)), taskDirectory, workspace: request.workspace,
      action: "discover", note: "Use existing powershell for full discovery." } } : {}) };
}
