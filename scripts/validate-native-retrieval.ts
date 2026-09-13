/** Opt-in paid model smoke test. Uses only synthetic fixtures in an isolated data home. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, loadConfig } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { resolveModel } from "../src/runtime/models.js";
import { planningMaterials } from "../src/wiki/materials.js";
import { gapQueue } from "../src/knowledge/gaps.js";
import { capabilityIssues } from "../src/knowledge/model.js";
import type { Decision, RunRequest, RuntimeEvent } from "../src/types.js";
import { nativeFixture, zero } from "../tests/fixtures/native-retrieval.js";

const { values } = parseArgs({ options: { live: { type: "boolean" }, output: { type: "string" } }, strict: true });
if (!values.live) throw new Error("Pass --live explicitly to use the configured model and incur model usage.");
const workspace = process.cwd(), configured = loadConfig(projectConfigPath(workspace));
// Resolve credentials once in the user's configured home, before isolating all fixture writes.
const selected = await resolveModel(configured.models.decide, AbortSignal.timeout(30000));
const root = mkdtempSync(join(tmpdir(), "xloom-native-live-"));
const reportFile = resolve(values.output ?? join(root, "report.json"));
const previousHome = process.env.XLOOM_HOME;
process.env.XLOOM_HOME = join(root, "home");
const config = defaultConfig("验证本地报表的实际下载结果；已有凭据不等于完成下载", "Only synthetic local files; no external target");
config.models = configured.models;
config.context = "这是原生检索接口的合成样本回放。每轮先用 read 的 mode=wiki 或 combined 搜索 BridgeNote，读取 C-download 的原生 discover 入口。有新的原件命中时必须跟随 original 定位入口核对内容与 alice/v1 条件。资料缺少授权时计划获取缺失输入；新授权到来时先查来源和更正，再规划带 revisits 的有界实际下载验证。尚未执行下载，不要 resolve 下载缺口或结束根目标。只规划，不访问外部目标。";
config.limits = { ...config.limits, maxTurnsPerRun: 10, maxTokens: 300000, maxMinutes: 10, stepTimeoutSeconds: 120 };
const fixture = nativeFixture(root, config), phases: object[] = [];
let requests = 0;
const runner = new PiRunner({ resolveModel: async () => ({ ...selected, streamFn: (...args) => { requests++; return selected.streamFn(...args); } }) });
async function phase(id: string, hasProvider: boolean) {
  fixture.store.setStatus("running", "Live native interface smoke test"); fixture.store.beginRun(id, "decide");
  const events: RuntimeEvent[] = [], baseline = fixture.store.materialReceipts();
  const snapshot = fixture.store.snapshot();
  const request: RunRequest = { id, mode: "decide", snapshot, workspace: root, runDir: join(fixture.store.dataDir, "runs", id),
    blackboardPath: fixture.store.projectionPath, signal: AbortSignal.timeout(120000), onEvent: event => { events.push(event); },
    materialBaseline: baseline, materials: planningMaterials(snapshot, baseline, fixture.store.dataDir, root) };
  const started = Date.now(), requestStart = requests;
  const result = await runner.run(request), decision = result.output as Decision;
  const paths = events.filter(event => event.type === "tool_start" && event.toolName === "read").map(event => JSON.parse(event.text).path as string);
  const outputs = events.filter(event => event.type === "tool_end" && !event.isError).flatMap(event => { try { return [JSON.parse(event.text)]; } catch { return []; } });
  const search = outputs.find(output => output.type === "task_search" && ["wiki", "combined"].includes(output.mode) && output.complete);
  const discovery = outputs.find(output => output.type === "discovery_context" && output.consumerId === "C-download" && output.complete);
  // Earlier planning may declare counterevidence against the consumer's source.
  // A new supplier cannot acknowledge that source change on the author's behalf.
  const expectedReview = capabilityIssues(snapshot, snapshot.capabilities!.find(item => item.id === "C-download")!);
  const candidate = discovery?.items[0];
  const compatibleSupplier = candidate?.inputs?.some((input: any) => input.alternatives.some((alt: any) => alt.producerId === "C-grant"
    && alt.conditions.status === "compatible" && !alt.reviewIssues.length));
  const checks = {
    wikiSearch: !!search?.wiki?.records?.some((record: any) => record.ref.kind === "block"),
    targetedDiscovery: !!discovery,
    supplierMatchesState: hasProvider ? !!compatibleSupplier : !compatibleSupplier,
    planMatchesState: !!candidate && (hasProvider && !expectedReview.length ? candidate.plan?.requirementsCovered === true : candidate.plan === null),
    sourceReviewPreserved: !!candidate && expectedReview.every(issue => candidate.reviewIssues.includes(issue)),
    readVerifiedOriginal: !hasProvider || outputs.some(output => output.type === "original_read" && output.integrity === "verified" && output.text?.includes("LOCAL_ONLY")),
    sawCorrection: !hasProvider || !!search?.wiki?.records?.some((record: any) => record.ref.kind === "block" && record.status === "review_required"),
    plannedRevisit: !hasProvider || !!decision.steps?.some(step => step.revisits?.some(ref => ref.stepId === fixture.step.id && ref.gapId === "gap-download")),
    noPrematureCompletion: !decision.conclusion && !decision.gapReviews?.some(review => review.action === "resolve") && !decision.updateGoals?.some(goal => goal.id === "G0" && goal.status === "satisfied"),
    noToolErrors: !events.some(event => event.type === "tool_end" && event.isError),
  };
  phases.push({ id, checks, expectedConsumerReview: expectedReview, requests: requests - requestStart, usage: result.usage, durationMs: Date.now() - started, readPaths: paths, decision });
  assert(Object.values(checks).every(Boolean), `Native smoke assertions failed: ${JSON.stringify(checks)}`);
  fixture.store.applyDecision(id, decision, result.usage, { ...request.materials!, items: [...request.materials!.items, ...request.materialReads ?? []] });
  assert.notEqual(gapQueue(fixture.store.snapshot())[0]!.state, "resolved");
}
let failure: string | undefined;
try {
  await phase("live-before", false);
  // Do not execute model-proposed actions: the harness supplies a new synthetic observation.
  const ready = fixture.store.snapshot().steps.filter(step => step.status === "ready");
  if (ready.length) { fixture.store.beginRun("harness-supersede", "decide"); fixture.store.applyDecision("harness-supersede", { summary: "Harness supplies next synthetic sample",
    updateSteps: ready.map(step => ({ id: step.id, action: "abandon", reason: "Synthetic harness supplies new input; no target action executed" })) }, zero); }
  fixture.addProvider();
  await phase("live-after", true);
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  fixture.store.close();
  if (previousHome === undefined) delete process.env.XLOOM_HOME; else process.env.XLOOM_HOME = previousHome;
}
const report = { status: failure ? "failed" : "passed", model: { provider: configured.models.decide.provider, id: configured.models.decide.model },
  scope: "Explicitly guided native-interface smoke test over two synthetic snapshots; not autonomous research or vulnerability recall evaluation", root, phases, requests, ...(failure ? { failure } : {}) };
mkdirSync(dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, model: report.model, requests, reportFile, phases: phases.map((phase: any) => ({ id: phase.id, checks: phase.checks, usage: phase.usage })), ...(failure ? { failure } : {}) }, null, 2));
if (failure) process.exitCode = 1;
