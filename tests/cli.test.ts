import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveNewConfig } from "../src/config.js";
import { renderReport } from "../src/report.js";
import type { BoardSnapshot } from "../src/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cliFile = path.join(projectRoot, "src", "cli.ts");
const tsxFile = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const roots: string[] = [];
const missingKeyVariable = "XLOOM_CLI_TEST_MISSING_MODEL_CREDENTIAL_17";

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-cli-test-"));
  roots.push(root);
  return root;
}

function cli(args: string[], cwd = workspace()) {
  const result = spawnSync(process.execPath, [tsxFile, cliFile, ...args], {
    cwd, encoding: "utf8", timeout: 20_000, windowsHide: true,
    env: { ...process.env, [missingKeyVariable]: "", NO_COLOR: "1" },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { ...result, combined: `${result.stdout}\n${result.stderr}` };
}

function databaseState(root: string) {
  const db = new DatabaseSync(path.join(root, ".xloom", "blackboard.sqlite"), { readOnly: true });
  try {
    return {
      board: JSON.parse(String(db.prepare("SELECT value FROM board WHERE id=1").get()!.value)) as BoardSnapshot,
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY startedAt").all(),
    };
  } finally { db.close(); }
}

function registerDemoRoot(root: string): string {
  const canonical = realpathSync(root);
  const temporaryRoot = realpathSync(tmpdir());
  expect(path.dirname(canonical).toLocaleLowerCase()).toBe(temporaryRoot.toLocaleLowerCase());
  expect(path.basename(canonical)).toMatch(/^xloom-demo-[A-Za-z0-9]+$/);
  roots.push(canonical);
  return canonical;
}

afterEach(() => {
  const temporaryRoot = realpathSync(tmpdir());
  for (const root of roots.splice(0)) {
    const canonical = realpathSync(root);
    if (path.dirname(canonical).toLocaleLowerCase() !== temporaryRoot.toLocaleLowerCase()
      || !/^xloom-(?:cli-test|demo)-[A-Za-z0-9]+$/.test(path.basename(canonical))) {
      throw new Error(`Refusing test cleanup outside exact generated temp workspace: ${canonical}`);
    }
    rmSync(canonical, { recursive: true, force: true });
  }
});

describe("command-line entry points", () => {
  it("shows help without creating project state or starting agents", () => {
    const root = workspace();
    const result = cli(["--help"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local two-agent research loop");
    expect(result.stdout).toContain("read/write/edit/powershell");
    expect(result.stdout).toContain("--headless");
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
    expect(existsSync(path.join(root, "xloom.json"))).toBe(false);
  });

  it("initializes user-input scope and preserves the config byte-for-byte on repeated init", () => {
    const root = workspace();
    const initialized = cli(["init", "--goal", "验证本地 fixture 对象权限"], root);
    expect(initialized.status).toBe(0);
    const file = path.join(root, "xloom.json");
    const config = loadConfig(file);
    expect(config.goal).toBe("验证本地 fixture 对象权限");
    expect(config.scope).toBe(config.goal);
    const original = readFileSync(file);
    const repeated = cli(["init", "--goal", "Must not replace the original goal"], root);
    expect(repeated.status).toBe(1);
    expect(repeated.combined).toMatch(/EEXIST|already exists/i);
    expect(readFileSync(file)).toEqual(original);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("supports explicit workspace, scope and config filename", () => {
    const cwd = workspace();
    const target = workspace();
    const result = cli(["init", "--workspace", target, "--config", "project.json", "--goal", "Check fixture ownership", "--scope", "http://127.0.0.1:8000 fixture only"], cwd);
    expect(result.status).toBe(0);
    expect(loadConfig(path.join(target, "project.json")).scope).toBe("http://127.0.0.1:8000 fixture only");
    expect(existsSync(path.join(cwd, "xloom.json"))).toBe(false);
  });

  it("requires an explicit initialization goal", () => {
    const root = workspace();
    const result = cli(["init"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires --goal/);
    expect(existsSync(path.join(root, "xloom.json"))).toBe(false);
  });

  it("refuses non-TTY run unless headless execution was explicit, before loading agents or state", () => {
    const root = workspace();
    const result = cli(["run"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/TUI needs an interactive terminal/);
    expect(result.stderr).not.toMatch(/credential|configuration at/i);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("fails safely when a headless run has no configuration", () => {
    const root = workspace();
    const result = cli(["run", "--headless"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot read xloom configuration/);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("fails without a model request when the named credential variable is missing", () => {
    const root = workspace();
    const config = defaultConfig("Missing-credential fixture");
    config.models.decide.apiKeyEnv = missingKeyVariable;
    config.models.execute.apiKeyEnv = missingKeyVariable;
    saveNewConfig(path.join(root, "xloom.json"), config);
    const result = cli(["run", "--headless"], root);
    expect(result.status).toBe(1);
    expect(result.combined).toContain(`Missing model credential environment variable: ${missingKeyVariable}`);
    expect(result.combined).not.toMatch(/VULN_FOUND/);
    const saved = databaseState(root);
    expect(saved.board).toMatchObject({ status: "error", outcome: null, completedSteps: 0, usage: { input: 0, output: 0, cost: 0 } });
    expect(saved.board.facts).toEqual([]);
    expect(existsSync(path.join(root, ".xloom", "controller.lock"))).toBe(false);
  });

  it("rejects status/report without creating an empty database", () => {
    const root = workspace();
    for (const command of ["status", "report"]) {
      const result = cli([command], root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/No blackboard yet/);
    }
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("ships a valid example config with the same strict runtime contract", () => {
    const config = loadConfig(path.join(projectRoot, "xloom.example.json"));
    expect(config.version).toBe(1);
    expect(config.models.decide.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.models.execute.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.context).toContain("不会自动加载");
  });
});

describe("offline demo and read-only reports", () => {
  it("runs the complete synthetic loop, then reads status/report without changing saved state", () => {
    const result = cli(["demo", "--headless"]);
    const reportedRoot = result.stdout.match(/^DEMO workspace: (.+)\r?$/m)?.[1].trim();
    expect(reportedRoot).toBeTruthy();
    const root = registerDemoRoot(reportedRoot!);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DEMO ONLY");
    expect(result.stdout).toContain("no live target or model was tested");
    expect(result.stdout).not.toContain("VULN_FOUND");
    const before = databaseState(root);
    expect(before.board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, usage: { input: 0, output: 0, cost: 0 } });
    expect(before.board.config.title).toContain("synthetic");
    expect(before.board.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(before.board.evidence).toHaveLength(1);
    const artifact = JSON.parse(readFileSync(path.join(root, before.board.evidence[0].path), "utf8"));
    expect(artifact.synthetic).toBe(true);
    expect(artifact.purpose).toContain("NOT a network response or vulnerability evidence");
    expect(before.runs.map(run => run.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    const projection = readFileSync(path.join(root, "state", "blackboard.md"));

    const status = cli(["status", "--workspace", root]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", steps: 1 });
    const report = cli(["report", "--workspace", root]);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("synthetic");
    expect(report.stdout).toContain("SHA-256");
    expect(report.stdout).toContain("PoC evidence: not attached");
    expect(report.stdout).toContain("Integrity and schema checks do not independently establish a vulnerability");
    expect(report.stdout).not.toContain("VULN_FOUND");
    expect(databaseState(root)).toEqual(before);
    expect(readFileSync(path.join(root, "state", "blackboard.md"))).toEqual(projection);
    expect(existsSync(path.join(root, ".xloom", "controller.lock"))).toBe(false);
  }, 30_000);

  it("renders claimed impact and evidence as reviewable data, not independently proven truth", () => {
    const board: BoardSnapshot = {
      revision: 1, config: defaultConfig("Report fixture"), status: "paused", outcome: null, reason: "Impact needs validation",
      goals: [], facts: [], steps: [], hints: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: -1,
      evidence: [{ id: "E1", path: ".xloom/evidence/test.bin", sha256: "a".repeat(64), bytes: 12, description: "Synthetic report fixture", runId: "R1", stepId: "S1" }],
      findings: [{ id: "V1", key: "fixture", title: "Unverified fixture claim", target: "fixture object", status: "technical_hit", rating: "unrated", evidenceIds: ["E1"], factIds: [], next: "Validate capability and affected object", impact: { capability: "Claimed read", object: "Fixture object", result: "Unverified result", scope: "Unknown", prerequisites: "Fixture account" } }],
    };
    const report = renderReport(board);
    expect(report).toContain("Status: technical_hit | Rating: unrated");
    expect(report).toContain("capability: Claimed read");
    expect(report).toContain("result: Unverified result");
    expect(report).toContain("Evidence: E1");
    expect(report).toContain("SHA-256");
    expect(report).toContain("do not independently establish a vulnerability");
    expect(report).not.toContain("VULN_FOUND");
  });
});
