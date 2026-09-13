import { DatabaseSync } from "node:sqlite";
import { discoverKnowledge } from "../knowledge/discovery.js";
import { gapQueue } from "../knowledge/gaps.js";
import { parseArgs } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BoardSnapshot } from "../types.js";
import { organizeWiki, type RetrievalRef } from "./catalog.js";
import { auditWiki } from "./audit.js";
import { retrieveWiki } from "./retrieval.js";

/** The existing powershell tool can launch this local module. No Agent or tool registration. */
export function runLocal(argv: string[]): { output: object; exitCode: number } {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    task: { type: "string" }, workspace: { type: "string" }, query: { type: "string" },
    limit: { type: "string" }, "budget-chars": { type: "string" }, kind: { type: "string" }, id: { type: "string" }, page: { type: "string" },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || !["search", "organize", "audit", "discover", "gaps"].includes(action ?? "")) throw new Error("Use search|organize|audit|discover|gaps --task <absolute task directory> --workspace <absolute workspace>.");
  if (!values.task || !values.workspace || !isAbsolute(values.task) || !isAbsolute(values.workspace)) throw new Error("task and workspace must be absolute directories.");
  const number = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("limit and budget-chars must be positive integers.");
    return Number(value);
  };
  const limit = number(values.limit), budgetChars = number(values["budget-chars"]);
  let anchors: RetrievalRef[] | undefined;
  if (values.kind || values.id || values.page) {
    if (!values.id || !values.kind || !["goal", "step", "fact", "finding", "evidence", "attempt", "capability", "chain", "block"].includes(values.kind)
      || (values.kind === "block") !== Boolean(values.page)) throw new Error("An exact reference requires --kind and --id; blocks also require --page.");
    anchors = [{ kind: values.kind as RetrievalRef["kind"], id: values.id, ...(values.page ? { pageId: values.page } : {}) }];
  }
  if (action !== "search" && [values.query, values.limit, values["budget-chars"], values.kind, values.id, values.page].some(value => value !== undefined)) throw new Error("Query and budget options apply only to search.");
  const db = new DatabaseSync(join(values.task, "blackboard.sqlite"), { readOnly: true });
  try {
    const read = () => String(db.prepare("SELECT value FROM board WHERE id=1").get()?.value ?? "");
    const original = read();
    if (!original) throw new Error("Task blackboard is empty.");
    const board = JSON.parse(original) as BoardSnapshot;
    const output = action === "search" ? retrieveWiki(board, values.task, values.workspace, values.query ?? "", { limit, budgetChars, anchors })
      : action === "organize" ? organizeWiki(board) : action === "discover" ? discoverKnowledge(board)
      : action === "gaps" ? { type: "gap_review", evidence: false, boardRevision: board.revision, items: gapQueue(board) } : auditWiki(board, values.task, values.workspace);
    // Do not open BlackboardStore: its constructor owns locks and recovers runs.
    if (read() !== original) throw new Error("Task changed during the local operation; retry against a stable snapshot. No result was published.");
    return { output, exitCode: "status" in output && output.status === "unavailable" ? 2 : 0 };
  } finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = runLocal(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`); process.exitCode = result.exitCode;
  } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
