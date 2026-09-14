import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveNewConfig } from "../src/config.js";
import { decisionSchema, executionSchema, modelConfigSchema, projectConfigSchema, usageSchema } from "../src/schema.js";
import type { Decision, Execution, ProjectConfig } from "../src/types.js";

const temporaryDirectories: string[] = [];
function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xloom-schema-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "xloom.json");
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project configuration", () => {
  it("preserves explicit Chrome settings and keeps old configs valid", () => {
    const config = defaultConfig("target"), file = configPath();
    expect(config.chrome).toBeUndefined();
    config.chrome = { enabled: false, channel: "beta" };
    saveNewConfig(file, config);
    expect(loadConfig(file).chrome).toEqual(config.chrome);
    for (const chrome of [{ channel: "invalid" }, { enabled: "true" }, { command: "chrome" }, { args: ["--isolated"] }]) {
      expect(projectConfigSchema.safeParse({ ...config, chrome }).success).toBe(false);
    }
  });
  it("ships an example config with no application time, turn, token or cost limits", () => {
    const config = projectConfigSchema.parse(JSON.parse(readFileSync(new URL("../xloom.example.json", import.meta.url), "utf8")));
    expect(config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null, maxTurnsPerRun: null, maxTokens: null, maxCost: null });
  });

  it("uses user input as scope without extra authorization settings", () => {
    const config = defaultConfig("测试本地 Web 靶场");
    expect(config.scope).toBe(config.goal);
    expect(config.limits).toEqual({ maxNoProgress: 3, maxMinutes: null, maxTokens: null, maxCost: null, maxTurnsPerRun: null, stepTimeoutSeconds: null, metacogEvery: 3 });
    expect(config.models.decide.model).toBe("claude-sonnet-4-6");
    expect(config.models.decide).not.toHaveProperty("apiKeyEnv");
    expect(config.models.execute).not.toBe(config.models.decide);
    expect(config).not.toHaveProperty("authorization");
  });

  it("keeps independent model configuration and an explicit scope", () => {
    const config = defaultConfig("Test ownership", "http://localhost:8000");
    config.models.execute.model = "custom-model";
    expect(config.models.decide.model).toBe("claude-sonnet-4-6");
    expect(projectConfigSchema.parse(config).scope).toBe("http://localhost:8000");
  });

  it.each([0, -1, 1.5, NaN, Infinity, 10_001])("rejects invalid maxSteps %s", (maxSteps) => {
    const config = defaultConfig("target");
    Object.assign(config.limits, { maxSteps });
    expect(projectConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts legacy maxSteps but removes it, without discarding explicit resource limits", () => {
    const config = defaultConfig("target");
    Object.assign(config.limits, { maxSteps: 24, maxTokens: 50000, maxCost: 2, maxMinutes: 15 });
    const parsed = projectConfigSchema.parse(config);
    expect(parsed.limits).not.toHaveProperty("maxSteps");
    expect(parsed.limits).toMatchObject({ maxTokens: 50000, maxCost: 2, maxMinutes: 15 });
  });

  it.each(["maxTokens", "maxCost", "maxMinutes", "maxTurnsPerRun", "stepTimeoutSeconds"])("supports opting out of %s, not invalid numerical budgets", (field) => {
    const config = defaultConfig("target");
    for (const value of [null, 5]) expect(projectConfigSchema.safeParse({ ...config, limits: { ...config.limits, [field]: value } }).success).toBe(true);
    for (const value of [0, -1, NaN, Infinity]) expect(projectConfigSchema.safeParse({ ...config, limits: { ...config.limits, [field]: value } }).success).toBe(false);
  });

  it("loads omitted or null turn caps as unlimited while preserving explicit legacy caps", () => {
    const config = defaultConfig("target");
    const file = configPath();
    for (const limits of [{}, { maxTurnsPerRun: null, maxTokens: null }, { maxTurnsPerRun: 12 }]) {
      writeFileSync(file, JSON.stringify({ ...config, limits }));
      expect(loadConfig(file).limits.maxTurnsPerRun).toBe(limits.maxTurnsPerRun ?? null);
      expect(loadConfig(file).limits.maxTokens).toBeNull();
    }
  });

  it("loads omitted or null run timeouts as unlimited and preserves explicit legacy timeouts", () => {
    const config = defaultConfig("target");
    const file = configPath();
    for (const limits of [{}, { stepTimeoutSeconds: null }, { stepTimeoutSeconds: 180 }]) {
      writeFileSync(file, JSON.stringify({ ...config, limits }));
      expect(loadConfig(file).limits.stepTimeoutSeconds).toBe(limits.stepTimeoutSeconds ?? null);
    }
    expect(projectConfigSchema.safeParse({ ...config, limits: { stepTimeoutSeconds: 86_401 } }).success).toBe(false);
  });

  it.each(["google-generative-ai", "bedrock-converse-stream", "azure-openai-responses", "future-pi-api"])("delegates API support for %s to Pi instead of a local allowlist", (api) => {
    expect(modelConfigSchema.parse({ provider: "pi-provider", model: "pi-model", api }).api).toBe(api);
  });

  it.each(["apiKey", "hooks", "skills", "mcpServers"])("rejects unknown config field %s", (field) => {
    expect(projectConfigSchema.safeParse({ ...defaultConfig("target"), [field]: "unexpected" }).success).toBe(false);
  });

  it("rejects inline credentials in model configs", () => {
    const model = defaultConfig("target").models.decide;
    expect(modelConfigSchema.safeParse({ ...model, apiKey: "must-not-be-stored" }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ ...model, apiKeyEnv: "sk-secret-value" }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ ...model, baseUrl: "https://secret@example.com" }).success).toBe(false);
    expect(modelConfigSchema.safeParse({ ...model, baseUrl: "https://example.com?api_key=secret" }).success).toBe(false);
  });

  it("accepts custom provider routing without contacting it", () => {
    expect(modelConfigSchema.parse({ provider: "local", model: "local-model", api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "LOCAL_API_KEY", thinking: "off" }).baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("round trips with exclusive creation and refuses overwrite", () => {
    const path = configPath();
    const config = defaultConfig("target");
    saveNewConfig(path, config);
    expect(loadConfig(path)).toEqual(config);
    const original = readFileSync(path, "utf8");
    expect(() => saveNewConfig(path, defaultConfig("other target"))).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("accepts Windows UTF-8 BOM", () => {
    const path = configPath();
    writeFileSync(path, `\uFEFF${JSON.stringify(defaultConfig("测试目标"))}`);
    expect(loadConfig(path).goal).toBe("测试目标");
  });

  it("reports field paths but never submitted secret values", () => {
    const path = configPath();
    const config = defaultConfig("target");
    writeFileSync(path, JSON.stringify({ ...config, models: { ...config.models, decide: { ...config.models.decide, apiKey: "secret-never-echo" } } }));
    expect(() => loadConfig(path)).toThrow(/models.decide/);
    expect(() => loadConfig(path)).not.toThrow(/secret-never-echo/);
  });

  it("reports malformed JSON without echoing its content", () => {
    const path = configPath();
    writeFileSync(path, "{secret-never-echo");
    expect(() => loadConfig(path)).toThrow(/Invalid JSON/);
    expect(() => loadConfig(path)).not.toThrow(/secret-never-echo/);
  });

  it("does not create invalid configuration", () => {
    const path = configPath();
    expect(() => saveNewConfig(path, { ...defaultConfig("target"), goal: "" } as ProjectConfig)).toThrow(/goal/);
    expect(() => readFileSync(path)).toThrow();
  });
});

describe("agent output contracts", () => {
  const decision: Decision = {
    summary: "Validate ownership with two accounts",
    goals: [{ id: "goal-child", description: "Check object boundary", parentId: "goal-root" }],
    steps: [{ goalId: "goal-child", from: ["fact-1"], description: "Compare access", successSignal: "Cross-account access observed or denied", evidencePlan: "Save response pair", priority: 80 }],
    updateSteps: [{ id: "step-old", action: "abandon", reason: "Duplicate hypothesis" }],
    updateGoals: [{ id: "goal-old", status: "satisfied", factIds: ["fact-1"], reason: "Evidence complete" }],
    reviews: [{ findingId: "finding-1", status: "closed", rating: "unrated", reason: "Not reproduced; reopen with new identity" }],
    conclusion: { outcome: "NOT_REPRODUCED", reason: "Variables reasonably covered" },
  };
  const execution: Execution = {
    summary: "Observed an object-access difference",
    result: "done",
    evidence: [{ ref: "e1", path: "responses.txt", description: "Original response pair" }],
    facts: [{ ref: "f1", description: "Response difference", evidenceRefs: ["e1"] }],
    findings: [{ key: "object-access", title: "Ownership lead", target: "Account B × object A", status: "technical_hit", factRefs: ["f1"], evidenceRefs: ["e1"], next: "Validate impact" }],
  };

  it("accepts the complete typed contracts", () => {
    const parsedDecision: Decision = decisionSchema.parse(decision);
    const parsedExecution: Execution = executionSchema.parse(execution);
    expect(parsedDecision).toEqual(decision);
    expect(parsedExecution).toEqual(execution);
  });

  it("accepts explicit combination conditions and evidence-backed conditional attempts", () => {
    const combination = { requires: ["fact-1"], missing: ["A second account"], scope: "fixture", stateVersion: "v1", expectedCapability: "Read fixture", counterEvidence: [] };
    expect(decisionSchema.parse({ ...decision, steps: [{ ...decision.steps![0], combination }] }).steps![0].combination).toEqual(combination);
    const attempt = { hypothesis: "fixture-read", scope: "fixture", identity: "account-A", stateVersion: "v1", baseline: "owner access", changedVariable: "requester", outcome: "refutes", observation: "Denied", evidenceRefs: ["e1"] };
    expect(executionSchema.parse({ ...execution, attempts: [attempt] }).attempts).toEqual([attempt]);
    expect(executionSchema.safeParse({ ...execution, attempts: [{ ...attempt, evidenceRefs: [] }] }).success).toBe(false);
    expect(executionSchema.safeParse({ ...execution, attempts: [{ ...attempt, outcome: "confirmed" }] }).success).toBe(false);
    expect(executionSchema.safeParse({ ...execution, attempts: [{ ...attempt, conditionKey: "invented" }] }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...decision, steps: [{ ...decision.steps![0], combination: { ...combination, requires: [] } }] }).success).toBe(false);
  });

  it.each(["lead", "technical_hit"])("allows Execute finding status %s", (status) => {
    expect(executionSchema.safeParse({ ...execution, findings: [{ ...execution.findings![0], status }] }).success).toBe(true);
  });

  it("accepts omitted finding targets for Store to resolve, but rejects empty explicit targets", () => {
    const { target: _target, ...update } = execution.findings![0];
    expect(executionSchema.parse({ ...execution, findings: [update] }).findings![0]).not.toHaveProperty("target");
    for (const target of ["", "   ", null]) {
      expect(executionSchema.safeParse({ ...execution, findings: [{ ...update, target }] }).success).toBe(false);
    }
  });

  it.each(["impact_verified", "closed", "VULN_FOUND"])("prevents Execute from setting status %s", (status) => {
    expect(executionSchema.safeParse({ ...execution, findings: [{ ...execution.findings![0], status }] }).success).toBe(false);
  });

  it("prevents Execute from assigning ratings or conclusions", () => {
    expect(executionSchema.safeParse({ ...execution, findings: [{ ...execution.findings![0], rating: "P1" }] }).success).toBe(false);
    expect(executionSchema.safeParse({ ...execution, conclusion: { outcome: "VULN_FOUND", reason: "Tool hit" } }).success).toBe(false);
  });

  it("rejects unknown nested and top-level fields instead of silently removing them", () => {
    expect(decisionSchema.safeParse({ ...decision, messages: [] }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...decision, steps: [{ ...decision.steps![0], messages: [] }] }).success).toBe(false);
    expect(executionSchema.safeParse({ ...execution, evidence: [{ ...execution.evidence![0], sha256: "invented" }] }).success).toBe(false);
  });

  it("bounds output size and rejects NUL paths", () => {
    expect(decisionSchema.safeParse({ summary: "x".repeat(8_001) }).success).toBe(false);
    expect(decisionSchema.safeParse({ summary: "Plan", steps: Array(33).fill(decision.steps![0]) }).success).toBe(false);
    expect(executionSchema.safeParse({ ...execution, evidence: [{ ...execution.evidence![0], path: "x\0.txt" }] }).success).toBe(false);
  });

  it.each([NaN, Infinity, -1, 1.5])("rejects invalid token usage %s", (input) => {
    expect(usageSchema.safeParse({ input, output: 1, cost: 0 }).success).toBe(false);
  });

  it("accepts zero and fractional costs but only integral token counts", () => {
    expect(usageSchema.parse({ input: 0, output: 32, cost: 0.001 })).toEqual({ input: 0, output: 32, cost: 0.001 });
    expect(usageSchema.safeParse({ input: 0, output: 1, cost: Infinity }).success).toBe(false);
    expect(usageSchema.safeParse({ input: 0, output: 1, cost: 0, other: true }).success).toBe(false);
  });
});
