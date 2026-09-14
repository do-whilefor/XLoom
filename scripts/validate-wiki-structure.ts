/** Opt-in configured-model replay of Wiki authoring and metadata-only maintenance. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, loadConfig } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { resolveModel } from "../src/runtime/models.js";
import { wikiIssues } from "../src/wiki/model.js";
import { createTaskReader } from "../src/wiki/read.js";
import type { Execution, RunRequest, RuntimeEvent } from "../src/types.js";
import { wikiStructureFixture } from "../tests/fixtures/wiki-structure.js";

const { values } = parseArgs({ options: { live: { type: "boolean" }, output: { type: "string" } }, strict: true });
if (!values.live) throw new Error("Pass --live explicitly to use the configured model and incur model usage.");
const configured = loadConfig(projectConfigPath(process.cwd()));
// Resolve credentials before isolating fixture storage. Never copy secrets into reports.
const selected = await resolveModel(configured.models.execute, AbortSignal.timeout(30000));
const root = mkdtempSync(join(tmpdir(), "xloom-wiki-live-")), reportFile = resolve(values.output ?? join(root, "report.json"));
const previousHome = process.env.XLOOM_HOME; process.env.XLOOM_HOME = join(root, "home");
const config = defaultConfig("记录本地报表提交的边界；实际下载仍待验证", "Only synthetic local files; no external target");
config.models = configured.models;
config.context = "这是 Wiki 原生写入协议的合成样本验证。只维护本步骤指定的解释页；用现有 read 读取 wiki.authoringGuide 和原生 Wiki 搜索，保留必要解释、来源条件及待复核状态。没有执行任何真实下载，不新增 Facts、Evidence、Findings、Capabilities、Chains、Attempts、gapReviews 或目标完成声明。仅在最终 Execute JSON 中返回 wikiPages，result=no_progress，无需 checkpoint。";
config.limits = { ...config.limits, maxTurnsPerRun: 12, maxTokens: 450000, maxMinutes: 10, stepTimeoutSeconds: 180 };
const fixture = wikiStructureFixture(root, config), phases: object[] = [];
let requests = 0, failure: string | undefined;
const runner = new PiRunner({ resolveModel: async () => ({ ...selected, streamFn: (...args) => { requests++; return selected.streamFn(...args); } }) });

async function phase(metadataOnly: boolean) {
  const id = metadataOnly ? "metadata-after-correction" : "author-required-block";
  const instruction = metadataOnly
    ? "来源已有新的合成更正。先用 read 搜索 xloom://search?mode=wiki&query=ModelBridgeAlias&budgetChars=64000，检查 WK-agent-note 及其必要解释为何待复核。本轮只是目录维护：将 WK-agent-note 移到根目录(parentPageId=null)，更新标题和页面 aliases 为 [MovedBridgeAlias]；用 blockMetadata 修改 B-judgment 的 aliases 为 [MovedBlockAlias]。必须省略 blocks，保留正文、sources、requiredBlockRefs 和全部复核基线。不要把旧解释标成已复核。"
    : `先读 wiki.authoringGuide，再用 read 搜索 xloom://search?mode=wiki&query=BridgeAlias&budgetChars=64000。阅读完整必要解释及原件定位入口。新建 WK-agent-note，parentPageId=WK-index，title 自拟，summary 写清合成观察的边界，questions 至少一个，aliases=[ModelBridgeAlias]。只含 B-judgment，一个完整判断：已有提交返回标识，但下载成功与跨账号消费仍未验证；sources 使用 fact ${fixture.factId}；requiredBlockRefs=[{pageId:WK-context,blockId:B-limit}]。块必须有 keywords 和 aliases。只返回这个新页面。`;
  const run = fixture.claim(instruction), snapshot = fixture.store.snapshot(), before = snapshot.wikiPages?.find(page => page.id === "WK-agent-note");
  const events: RuntimeEvent[] = [], requestStart = requests, started = Date.now();
  const request: RunRequest = { id: run.runId, mode: "execute", snapshot, workspace: root,
    runDir: join(fixture.store.dataDir, "runs", run.runId), blackboardPath: fixture.store.projectionPath, step: snapshot.steps.find(step => step.id === run.step.id),
    signal: AbortSignal.timeout(180000), onEvent: event => { events.push(event); } };
  const entry: Record<string, unknown> = { id, runDir: request.runDir }; phases.push(entry);
  try {
    const result = await runner.run(request), execution = result.output as Execution;
    const paths = events.filter(event => event.type === "tool_start" && event.toolName === "read").map(event => JSON.parse(event.text).path as string);
    const outputs = events.filter(event => event.type === "tool_end" && !event.isError).flatMap(event => { try { return [JSON.parse(event.text)]; } catch { return []; } });
    const search = outputs.find(output => output.type === "task_search" && output.mode === "wiki" && output.complete);
    const page = execution.wikiPages?.find(page => page.id === "WK-agent-note");
    const unchangedRecords = ![execution.facts, execution.evidence, execution.findings, execution.capabilities, execution.chains, execution.attempts,
      execution.gaps, execution.gapLinks].some(items => items?.length);
    const checks: Record<string, boolean> = {
      nativeWikiRead: !!search,
      deliveredRequiredBlocks: ["B-limit", "B-scope"].every(id => search?.wiki.records.some((doc: any) => doc.ref.kind === "block" && doc.ref.id === id)),
      noToolErrors: !events.some(event => event.type === "tool_end" && event.isError),
      onlyWikiMaintenance: unchangedRecords && execution.result === "no_progress" && execution.wikiPages?.length === 1,
      correctProtocol: !!page && (metadataOnly ? !page.blocks && page.parentPageId === null && !!page.blockMetadata?.some(block => block.id === "B-judgment" && block.aliases?.includes("MovedBlockAlias"))
        : page.parentPageId === "WK-index" && !!page.summary && !!page.questions?.length && !!page.aliases?.includes("ModelBridgeAlias")
        && !!page.blocks?.some(block => block.id === "B-judgment" && !!block.keywords?.length && !!block.aliases?.length
          && block.sources.some(ref => ref.kind === "fact" && ref.id === fixture.factId)
          && block.requiredBlockRefs?.some(ref => ref.pageId === "WK-context" && ref.blockId === "B-limit"))),
      sawCorrection: !metadataOnly || !!search?.wiki.records.some((doc: any) => doc.ref.kind === "block" && doc.ref.pageId === "WK-agent-note" && doc.status === "review_required"),
    };
    Object.assign(entry, { checks, requests: requests - requestStart, usage: result.usage, durationMs: Date.now() - started, readPaths: paths, execution });
    assert(Object.values(checks).every(Boolean), `Wiki model replay failed: ${JSON.stringify(checks)}`);
    const board = fixture.store.applyExecution(run.runId, execution, result.usage), committed = board.wikiPages!.find(page => page.id === "WK-agent-note")!;
    const reader = createTaskReader(root, { dataDir: fixture.store.dataDir, snapshot: () => board });
    const delivered = reader(`xloom://search?mode=wiki&query=${metadataOnly ? "MovedBridgeAlias" : "ModelBridgeAlias"}&budgetChars=64000`) as any;
    checks.committedMetadataRecall = !!delivered.complete && !!delivered.wiki.records.some((doc: any) => doc.ref.pageId === "WK-agent-note");
    checks.reviewBaselinePreserved = metadataOnly ? committed.blocks[0]!.text === before!.blocks[0]!.text
      && JSON.stringify(committed.blocks[0]!.basis) === JSON.stringify(before!.blocks[0]!.basis)
      && JSON.stringify(committed.blocks[0]!.requiredBasis) === JSON.stringify(before!.blocks[0]!.requiredBasis)
      && JSON.stringify(wikiIssues(board, committed)) === JSON.stringify(wikiIssues(snapshot, before!)) && wikiIssues(board, committed).length > 0
      : wikiIssues(board, committed).length === 0;
    checks.researchStatePreserved = JSON.stringify(board.facts) === JSON.stringify(snapshot.facts) && board.goals.every(goal => goal.status !== "satisfied");
    Object.assign(entry, { issues: wikiIssues(board, committed) });
    assert(Object.values(checks).every(Boolean), `Wiki commit assertions failed: ${JSON.stringify(checks)}`);
  } catch (error) {
    Object.assign(entry, { failure: error instanceof Error ? error.message : String(error), requests: requests - requestStart,
      durationMs: Date.now() - started, events }); throw error;
  }
}
try { await phase(false); fixture.correct(); await phase(true); }
catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally { fixture.store.close(); if (previousHome === undefined) delete process.env.XLOOM_HOME; else process.env.XLOOM_HOME = previousHome; }
const report = { status: failure ? "failed" : "passed", model: { provider: configured.models.execute.provider, id: configured.models.execute.model },
  scope: "Guided two-phase synthetic authoring replay; not autonomous recall, vulnerability discovery or cost benchmark", root, phases, requests, ...(failure ? { failure } : {}) };
mkdirSync(dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, model: report.model, requests, reportFile,
  phases: phases.map((phase: any) => ({ id: phase.id, checks: phase.checks, usage: phase.usage })), ...(failure ? { failure } : {}) }, null, 2));
if (failure) process.exitCode = 1;
