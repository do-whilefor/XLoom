/** Opt-in paid Execute smoke test against a synthetic page in the user's running Chrome. */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, loadConfig } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";
import { createChromeSession, type ChromeSession } from "../src/runtime/chrome.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { resolveModel } from "../src/runtime/models.js";
import { BlackboardStore } from "../src/store.js";
import type { Execution, RuntimeEvent } from "../src/types.js";

const { values } = parseArgs({ options: { live: { type: "boolean" }, output: { type: "string" } }, strict: true });
if (!values.live) throw new Error("Pass --live to use the configured model and the current Chrome session.");
const configured = loadConfig(projectConfigPath(process.cwd()));
if (configured.chrome?.enabled === false) throw new Error("Chrome is disabled in the project settings.");
const selected = await resolveModel(configured.models.execute, AbortSignal.timeout(30_000));
const root = await mkdtemp(join(tmpdir(), "xloom-chrome-live-"));
const reportFile = resolve(values.output ?? join(root, "report.json"));
const cookieName = `xloom_smoke_${randomUUID().replaceAll("-", "")}`, cookie = randomUUID(), confirmation = randomUUID();
const prefix = `/xloom-${randomUUID()}`;
let confirmations = 0, authenticatedProbes = 0, unauthorizedRequests = 0, seeds = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url!, "http://127.0.0.1").pathname;
  const authenticated = request.headers.cookie?.split("; ").includes(`${cookieName}=${cookie}`) === true;
  response.setHeader("Cache-Control", "no-store");
  if (path === `${prefix}/seed`) {
    seeds++; response.writeHead(302, { "Set-Cookie": `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=${prefix}`, Location: `${prefix}/probe` }); response.end(); return;
  }
  if (path === `${prefix}/cleanup`) {
    response.writeHead(200, { "Set-Cookie": `${cookieName}=; HttpOnly; Max-Age=0; Path=${prefix}` }); response.end("Fixture cookie removed."); return;
  }
  if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
  if (!authenticated) { unauthorizedRequests++; response.writeHead(401); response.end("No existing fixture session"); return; }
  if (path === `${prefix}/confirm` && request.method === "POST") {
    confirmations++; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ confirmation })); return;
  }
  if (path === `${prefix}/probe`) {
    authenticatedProbes++; response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Xloom Chrome session fixture</title><style>body{font:24px system-ui;margin:70px}button{font:inherit;padding:15px}#result{color:green}</style>
      <h1>Xloom Chrome session fixture</h1><p>Authenticated by an existing HttpOnly session cookie.</p>
      <button id="confirm">Confirm session</button><p id="result">Waiting for confirmation</p>
      <script>document.querySelector('#confirm').onclick=async()=>{const r=await fetch('${prefix}/confirm',{method:'POST'});const data=await r.json();document.querySelector('#result').textContent='Confirmed: '+data.confirmation;};</script>`); return;
  }
  response.writeHead(404); response.end();
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const url = `${origin}${prefix}/probe`;
const chromeOptions = { workspace: root, artifactsDirectory: join(root, "bootstrap"), config: configured.chrome };
// A stable endpoint fingerprint proves the harness never replaced the browser instance on Windows.
async function browserFingerprint() {
  if (process.platform !== "win32" || (configured.chrome?.channel ?? "stable") !== "stable") return undefined;
  const endpoint = await readFile(join(process.env.LOCALAPPDATA!, "Google", "Chrome", "User Data", "DevToolsActivePort"));
  return createHash("sha256").update(endpoint).digest("hex");
}
const previousHome = process.env.XLOOM_HOME;
let bootstrap: ChromeSession | undefined, cleanup: ChromeSession | undefined, store: BlackboardStore | undefined;
let failure: string | undefined, runDir: string | undefined, requests = 0, modelUsage: unknown, execution: Execution | undefined;
const events: RuntimeEvent[] = [], checks: Record<string, boolean> = {};
const call = async (session: ChromeSession, tool: string, args = {}) => {
  const result = await session.tool.execute("harness", { action: "call", tool, args }, AbortSignal.timeout(60_000));
  return JSON.parse(await readFile(result.details.artifact, "utf8")).result;
};
try {
  const before = await browserFingerprint();
  bootstrap = createChromeSession(chromeOptions);
  console.log("Preparing the fixture in the existing Chrome session...");
  await call(bootstrap, "new_page", { url: `${origin}${prefix}/seed`, background: true });
  assert.equal(seeds, 1); assert.equal(authenticatedProbes, 1);
  await bootstrap.close(); bootstrap = undefined;
  process.env.XLOOM_HOME = join(root, "home");
  const config = defaultConfig("验证已有 Chrome 会话可被 Execute 复用", `Only operate the synthetic page ${url}. Other Chrome pages are outside this smoke test.`);
  config.models = configured.models; config.chrome = configured.chrome;
  config.limits = { ...config.limits, maxTurnsPerRun: 28, maxMinutes: 10, stepTimeoutSeconds: 480 };
  config.context = "这是浏览器工具验证。只用 chrome 工具操作给定的已打开测试页。先 list 并 describe 将调用的工具（不要猜参数），读取页面快照、点击 Confirm session、读取确认结果、获取截图。截图省略 format/filePath，验证默认图片返回路径；模型不支持图片时用快照核对文字。只交付一个包含完整确认码的 Fact 和两个 Evidence（确认快照和截图原始 JSON）。工具已自动归档，无需读取原始 JSON 或计算哈希。不要新建页面、使用脚本直接调用接口、重新登录或设置/读取 Cookie；只使用已有会话。不创建 Finding。";
  store = new BlackboardStore(root, config);
  const zero = { input: 0, output: 0, cost: 0 };
  store.setStatus("running", "Chrome smoke fixture"); store.beginRun("plan", "decide");
  const planned = store.applyDecision("plan", { summary: "Local browser fixture", steps: [{ goalId: "G0", from: [],
    description: `通过 chrome 操作已打开的 ${url}，点击 Confirm session 并截图，保存实际确认结果为有原始证据的 Fact。`,
    successSignal: "Authenticated confirmation displayed and screenshot observed", evidencePlan: "Chrome raw result artifacts", priority: 1 }] }, zero);
  const step = planned.steps.find(step => step.status === "ready")!;
  const runId = "chrome-execute";
  const snapshot = store.beginRun(runId, "execute", step.id);
  runDir = join(store.dataDir, "runs", runId);
  const runner = new PiRunner({ resolveModel: async () => ({ ...selected, streamFn: (...args) => { requests++; return selected.streamFn(...args); } }) });
  const result = await runner.run({ id: runId, mode: "execute", snapshot, workspace: root, runDir, blackboardPath: store.projectionPath,
    step: snapshot.steps.find(item => item.id === step.id), signal: AbortSignal.timeout(480_000), onEvent: event => {
      events.push(event);
      if (event.type === "tool_start") { const args = JSON.parse(event.text); console.log(`Execute: ${event.toolName} ${args.action ?? ""} ${args.tool ?? ""}`); }
    } });
  execution = result.output as Execution; modelUsage = result.usage;
  const board = store.applyExecution(runId, execution, result.usage);
  const calls = events.filter(event => event.type === "tool_start" && event.toolName === "chrome").map(event => JSON.parse(event.text));
  const originals = await Promise.all((await readdir(join(runDir, "artifacts"))).filter(file => /^chrome-.*\.json$/.test(file)).map(async file => JSON.parse(await readFile(join(runDir!, "artifacts", file), "utf8"))));
  Object.assign(checks, {
    modelUsedChrome: calls.some(call => call.action === "call"),
    modelDiscoveredTools: calls.some(call => call.action === "list") && calls.some(call => call.action === "describe"),
    modelClicked: calls.some(call => call.action === "call" && ["click", "click_at"].includes(call.tool)),
    reusedHttpOnlySession: seeds === 1 && confirmations > 0 && unauthorizedRequests === 0,
    screenshotReturned: originals.some(item => item.tool === "take_screenshot" && item.result.content.some((part: any) => part.type === "image")),
    confirmationGroundedInFact: board.facts.some(fact => fact.description.includes(confirmation) && fact.evidenceIds.length > 0),
    evidenceCommitted: board.evidence.length > 0,
    noToolErrors: !events.some(event => event.type === "tool_end" && event.isError),
    completed: execution.result === "done",
  });
  if (before !== undefined) checks.sameBrowserInstance = before === await browserFingerprint();
  assert(Object.values(checks).every(Boolean), `Chrome smoke checks failed: ${JSON.stringify(checks)}`);
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  await bootstrap?.close();
  store?.close();
  if (previousHome === undefined) delete process.env.XLOOM_HOME; else process.env.XLOOM_HOME = previousHome;
  try {
    cleanup = createChromeSession(chromeOptions);
    const result = await call(cleanup, "list_pages");
    const pages = result.structuredContent?.pages ?? [];
    const fixturePages = pages.filter((page: any) => page.url.startsWith(`${origin}${prefix}`));
    for (const page of fixturePages) {
      await call(cleanup, "navigate_page", { pageId: page.id, type: "url", url: `${origin}${prefix}/cleanup` });
      await call(cleanup, "close_page", { pageId: page.id });
    }
    checks.fixtureCleaned = fixturePages.length > 0;
    checks.browserStillConnected = !!result.structuredContent?.pages;
  } catch (error) { failure ??= `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
  await cleanup?.close();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
const report = { status: failure ? "failed" : "passed", scope: "Guided local Execute tool smoke test in the existing Chrome; no external website tested.",
  model: { provider: selected.model.provider, id: selected.model.id, supportsImages: selected.model.input.includes("image") }, requests, usage: modelUsage, checks,
  otherTools: events.filter(event => event.type === "tool_start" && event.toolName !== "chrome").map(event => event.toolName),
  server: { seeds, authenticatedProbes, confirmations, unauthorizedRequests }, runDir, ...(failure ? { failure } : {}) };
await mkdir(dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, reportFile }, null, 2));
if (failure) process.exitCode = 1;
