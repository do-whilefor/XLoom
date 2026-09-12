#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig, loadConfig, saveNewConfig } from "./config.js";
import { BlackboardStore } from "./store.js";
import { LoopController } from "./controller.js";
import { DemoRunner } from "./demo.js";
import { renderReport } from "./report.js";
import type { BoardSnapshot } from "./types.js";

const help = `xloom — local two-agent research loop (Windows MVP)

  xloom init --goal "User-supplied goal / authorized target" [--scope "target details"]
  xloom run [--headless]       Open TUI, or start immediately in headless mode
  xloom status               Read the saved board without running agents
  xloom report               Print a Markdown report with evidence references
  xloom doctor               Check local Node/PowerShell/config/model credentials
  xloom models [--provider NAME]  List Pi's local built-in/cached/custom model catalog
  xloom demo [--headless]     Offline synthetic fixture in a new temporary workspace

Options: --workspace PATH  --config PATH  --help
TUI: /start /pause /stop /hint text /meta /board /help /exit /quit
User input defines authorization. No extra authorization confirmation or hooks.
Execute has read/write/edit/powershell with the current user's OS permissions.
`;

function savedBoard(workspace: string): BoardSnapshot {
  const file = path.join(workspace, ".xloom", "blackboard.sqlite");
  if (!existsSync(file)) throw new Error("No blackboard yet. Initialize xloom.json and run xloom first.");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM board WHERE id=1").get();
    if (!row) throw new Error("Blackboard is empty.");
    return JSON.parse(String(row.value));
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    goal: { type: "string" }, scope: { type: "string" }, workspace: { type: "string" }, config: { type: "string" },
    provider: { type: "string" },
    headless: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
  }, allowPositionals: true, strict: true });
  const command = positionals[0] ?? "run";
  if (values.help || command === "help") { process.stdout.write(help); return; }
  if (positionals.length > 1) throw new Error("Unexpected positional arguments; use --goal for task text.");
  const demo = command === "demo";
  if (!["init", "run", "status", "report", "doctor", "demo", "models"].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (values.provider !== undefined && command !== "models") throw new Error("--provider is only supported by the models command.");
  if (command === "models") {
    const { listModels } = await import("./runtime/index.js");
    const models = await listModels(values.provider);
    // Select public identifiers only; never print model headers or authentication.
    process.stdout.write(`${JSON.stringify(models.map(model => ({ provider: model.provider, model: model.id, api: model.api })), null, 2)}\n`);
    return;
  }
  if (demo && (values.workspace || values.config)) throw new Error("Demo always uses a new temporary workspace; omit --workspace and --config.");
  const workspace = demo ? mkdtempSync(path.join(tmpdir(), "xloom-demo-")) : realpathSync(path.resolve(values.workspace ?? process.cwd()));
  const configPath = path.resolve(workspace, values.config ?? "xloom.json");
  if (command === "init") {
    if (!values.goal?.trim()) throw new Error("init requires --goal. Your input defines the authorized task and targets.");
    saveNewConfig(configPath, defaultConfig(values.goal, values.scope));
    process.stdout.write(`Created ${configPath}\nChoose models via xloom models, configure context, and use Pi credentials or a model key environment variable. Goal completion, not a Step count, ends the loop.\n`);
    return;
  }
  if (command === "status" || command === "report") {
    const board = savedBoard(workspace);
    process.stdout.write(command === "report" ? renderReport(board) : `${JSON.stringify({ status: board.status, outcome: board.outcome, reason: board.reason, revision: board.revision, steps: board.completedSteps, findings: board.findings.length, usage: board.usage, elapsedMs: board.elapsedMs ?? 0 }, null, 2)}\n`);
    return;
  }
  if (command === "doctor") {
    const shell = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    process.stdout.write(`Node ${process.version}; platform ${process.platform}\nPowerShell 7: ${shell.status === 0 ? shell.stdout.trim() : "not found on PATH"}\n`);
    if (process.platform !== "win32" || shell.status !== 0) throw new Error("This MVP expects Windows and PowerShell 7 (pwsh.exe) on PATH.");
    if (existsSync(configPath)) {
      const config = loadConfig(configPath);
      const { resolveModel } = await import("./runtime/index.js");
      for (const role of ["decide", "execute"] as const) {
        const resolved = await resolveModel(config.models[role], new AbortController().signal);
        process.stdout.write(`${role}: ${resolved.model.provider}/${resolved.model.id}; Pi credential resolution OK (no model request)\n`);
      }
    } else process.stdout.write("No xloom.json yet; use init --goal. No model request was made.\n");
    return;
  }
  if (!values.headless && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("TUI needs an interactive terminal. Use --headless to run explicitly without a TUI.");
  const config = demo ? defaultConfig("DEMO: validate only the offline synthetic protocol fixture", "Local synthetic fixture; no external target") : loadConfig(configPath);
  if (demo) { config.title = "xloom DEMO (synthetic, no live test)"; saveNewConfig(configPath, config); process.stdout.write(`DEMO workspace: ${workspace}\n`); }
  const runner = demo ? new DemoRunner() : new (await import("./runtime/index.js")).PiRunner();
  const store = new BlackboardStore(workspace, config);
  const controller = new LoopController(store, runner);
  try {
    if (values.headless) {
      const interrupt = () => controller.pause();
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      const unsubscribe = controller.subscribe(event => {
        if (event.type === "state" && event.snapshot) process.stdout.write(`[${event.snapshot.status}] ${event.snapshot.reason}\n`);
        else if (event.type === "handoff" && event.handoff) {
          const { role, mode, revision, trigger } = event.handoff;
          process.stdout.write(`[${mode === "metacog" ? "Decide · Meta" : role === "execute" ? "Execute" : "Decide"}] r${revision} · ${trigger.kind}\n`);
        }
        else if (event.type === "notice" && event.message) process.stdout.write(`${event.message}\n`);
        else if (event.runtime && event.runtime.type !== "text" && event.runtime.type !== "tool_update") process.stdout.write(`[${event.runtime.mode}] ${event.runtime.type}${event.runtime.toolName ? ` ${event.runtime.toolName}` : ""}\n`);
      });
      try { await controller.start(); } finally { unsubscribe(); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
      const board = controller.snapshot();
      process.stdout.write(`${board.outcome ?? board.status}: ${board.reason}\nBlackboard: ${path.join(workspace, "state", "blackboard.md")}\n`);
      if (board.status === "error") process.exitCode = 1;
    } else {
      const { startTui } = await import("./ui/index.js");
      await startTui(controller);
    }
  } finally { await controller.waitForIdle(); store.close(); }
}

main().catch(error => { process.stderr.write(`xloom: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
