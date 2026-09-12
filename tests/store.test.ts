import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, Impact, Mode, Usage } from "../src/types.js";

const roots: string[] = [];
const stores: BlackboardStore[] = [];
const usage: Usage = { input: 10, output: 5, cost: 0.001 };
const impact: Impact = { capability: "Mock read capability", object: "Mock object owned by second fixture identity", result: "Fixture content returned", scope: "One fixture object", prerequisites: "Two local fixture accounts" };
let runSequence = 0;
const nextRun = () => `test-run-${++runSequence}`;

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-store-test-"));
  roots.push(root);
  return root;
}

function openStore(root = workspace()): BlackboardStore {
  const store = new BlackboardStore(root, defaultConfig("Validate local test fixtures"));
  stores.push(store);
  return store;
}

function runDecision(store: BlackboardStore, decision: Decision, mode: "decide" | "metacog" = "decide") {
  if (store.snapshot().status !== "running") store.setStatus("running", "Test running");
  const runId = nextRun();
  store.beginRun(runId, mode);
  return store.applyDecision(runId, decision, usage);
}

function claimStep(store: BlackboardStore, description = `Fixture validation ${runSequence}`) {
  const board = runDecision(store, { summary: "Plan fixture validation", steps: [{ goalId: "G0", from: [], description, successSignal: "Fixture result saved", evidencePlan: "Save fixture responses", priority: 50 }] });
  const step = board.steps.find(item => item.status === "ready")!;
  const runId = nextRun();
  store.beginRun(runId, "execute", step.id);
  const artifacts = path.join(store.dataDir, "runs", runId, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  return { runId, step, artifacts };
}

function hitOutput(evidencePath = "response.txt", contentDescription = "Mock response difference"): Execution {
  return {
    summary: "Fixture boundary difference observed",
    result: "done",
    evidence: [{ ref: "e1", path: evidencePath, description: "Original mock fixture responses" }],
    facts: [{ ref: "f1", description: contentDescription, evidenceRefs: ["e1"] }],
    findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: "fixture identity B × object A", status: "technical_hit", factRefs: ["f1"], evidenceRefs: ["e1"], next: "Validate fixture impact" }],
  };
}

function produceHit(store: BlackboardStore) {
  const claimed = claimStep(store);
  writeFileSync(path.join(claimed.artifacts, "response.txt"), "TEST FIXTURE ONLY\nGET /fixture/object\nidentity=A -> fixture-200\nidentity=B -> fixture-200\n");
  return store.applyExecution(claimed.runId, hitOutput(), usage);
}

function verifiedDecision(store: BlackboardStore, rating: "info" | "P3" | "P2" | "P1" = "P3"): Decision {
  const finding = store.snapshot().findings[0];
  return { summary: "Review fixture evidence", reviews: [{ findingId: finding.id, status: "impact_verified", rating, reason: "Structurally complete mock review; not a real vulnerability claim", impact, pocEvidenceId: finding.evidenceIds[0] }] };
}

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("transactional blackboard", () => {
  it("initializes one root goal and a readable generated projection", () => {
    const store = openStore();
    expect(store.snapshot()).toMatchObject({ revision: 0, status: "idle", outcome: null, facts: [], usage: { input: 0, output: 0, cost: 0 }, goals: [{ id: "G0", status: "active", parentId: null }] });
    expect(store.events().map(event => event.kind)).toEqual(["initialized"]);
    expect(readFileSync(path.join(store.workspace, "state", "blackboard.md"), "utf8")).toContain("SQLite is authoritative");
  });

  it("rolls back graph, run completion, usage and audit event together on invalid references", () => {
    const store = openStore();
    store.setStatus("running", "Test");
    const runId = nextRun();
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    const eventsBefore = store.events();
    expect(() => store.applyDecision(runId, { summary: "Bad plan", goals: [{ id: "G1", parentId: "G0", description: "Must roll back" }], steps: [{ goalId: "G1", from: ["missing-fact"], description: "Invalid reference", successSignal: "None", evidencePlan: "None", priority: 1 }] }, usage)).toThrow(/Unknown fact reference/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
    expect(store.applyDecision(runId, { summary: "Corrected plan" }, usage).usage).toEqual(usage);
    expect(() => store.applyDecision(runId, { summary: "Duplicate submission" }, usage)).toThrow(/already committed/);
  });

  it("rolls back evidence references and step completion for invalid Execute output", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture response");
    const before = store.snapshot();
    const eventsBefore = store.events();
    const output = hitOutput();
    output.facts![0].evidenceRefs = ["missing-evidence"];
    expect(() => store.applyExecution(runId, output, usage)).toThrow(/Unknown evidence reference/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it("rejects unsupported facts and keeps them out of authoritative state", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    expect(() => store.applyExecution(runId, { summary: "Unsupported statement", result: "done", facts: [{ ref: "f1", description: "An agent thinks this is true", evidenceRefs: [] }] }, usage)).toThrow(/Facts require original evidence/);
    expect(store.snapshot().facts).toEqual([]);
    expect(store.snapshot().steps[0].status).toBe("claimed");
  });

  it("rejects a technical hit without evidence-backed facts", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    expect(() => store.applyExecution(runId, { summary: "No evidence", result: "done", findings: [{ key: "unsupported", title: "Unsupported hit", target: "fixture", status: "technical_hit", factRefs: [], evidenceRefs: [], next: "Verify" }] }, usage)).toThrow(/technical hit requires evidence-backed facts/);
  });

  it("rejects a new finding whose facts are grounded in unattached evidence, atomically", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture evidence E1");
    writeFileSync(path.join(artifacts, "grounding.txt"), "fixture evidence E2 grounding the fact");
    const output = hitOutput();
    output.evidence!.push({ ref: "e2", path: "grounding.txt", description: "Actual fact grounding" });
    output.facts![0].evidenceRefs = ["e2"];
    const before = store.snapshot();
    const eventsBefore = store.events();
    expect(() => store.applyExecution(runId, output, usage)).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it("rejects adding a fact to an existing finding without attaching the fact's new evidence", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId, artifacts } = claimStep(store, "Add another grounded observation");
    writeFileSync(path.join(artifacts, "new-grounding.txt"), "new fixture evidence missing from finding");
    const output: Execution = {
      summary: "Incomplete provenance", result: "done",
      evidence: [{ ref: "new-e", path: "new-grounding.txt", description: "New fact grounding" }],
      facts: [{ ref: "new-f", description: "A fact grounded in new-e", evidenceRefs: ["new-e"] }],
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "technical_hit", factRefs: ["new-f"], evidenceRefs: [first.evidence[0].id], next: "Review new fact" }],
    };
    const before = store.snapshot();
    expect(() => store.applyExecution(runId, output, usage)).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(store.snapshot().findings[0].factIds).toEqual(first.findings[0].factIds);
  });

  it("accepts fact provenance already covered by an existing finding's merged evidence", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "Interpret an already attached fixture response");
    const board = store.applyExecution(runId, {
      summary: "New grounded observation from existing attached evidence", result: "done",
      facts: [{ ref: "new-f", description: "A distinct observation about the same fixture response", evidenceRefs: [first.evidence[0].id] }],
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "lead", factRefs: ["new-f"], evidenceRefs: [], next: "Review both grounded observations" }],
    }, usage);
    expect(board.findings[0].factIds).toHaveLength(2);
    expect(board.findings[0].evidenceIds).toEqual(first.findings[0].evidenceIds);
    expect(board.findings[0].status).toBe("technical_hit");
  });

  it("deduplicates normalized steps and does not replay finished equivalents", () => {
    const store = openStore();
    const { runId } = claimStep(store, "Compare   Fixture Accounts");
    store.applyExecution(runId, { summary: "No new evidence", result: "done" }, usage);
    const board = runDecision(store, { summary: "Repeated proposal", steps: [{ goalId: "G0", from: [], description: " compare fixture accounts ", successSignal: "Compare", evidencePlan: "Save", priority: 5 }] });
    expect(board.steps).toHaveLength(1);
    expect(board.steps[0]).toMatchObject({ status: "no_progress", attempts: 1 });
    expect(board.noProgressCount).toBe(1);
  });

  it("returns detached snapshots, not writable authority", () => {
    const store = openStore();
    const snapshot = store.snapshot();
    snapshot.goals[0].description = "mutated externally";
    snapshot.config.goal = "changed";
    expect(store.snapshot().goals[0].description).toBe("Validate local test fixtures");
  });

  it.each(["decide", "metacog"] as Mode[])("does not permit %s to claim an Execute step", (mode) => {
    const store = openStore();
    store.setStatus("running", "Test");
    expect(() => store.beginRun(nextRun(), mode, "some-step")).toThrow(/Only Execute may claim/);
    expect(store.runs()).toEqual([]);
  });
});

describe("evidence boundaries and integrity", () => {
  it("archives original bytes with a verifiable SHA-256 independent of the mutable source", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const bytes = Buffer.from("TEST FIXTURE 原始响应\r\n");
    writeFileSync(path.join(artifacts, "response.txt"), bytes);
    const board = store.applyExecution(runId, hitOutput(), usage);
    const evidence = board.evidence[0];
    expect(evidence.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(evidence.bytes).toBe(bytes.length);
    expect(readFileSync(path.join(store.workspace, evidence.path))).toEqual(bytes);
    writeFileSync(path.join(artifacts, "response.txt"), "source changed after collection");
    expect(() => store.verifyEvidence(evidence)).not.toThrow();
  });

  it.each(["relative traversal", "absolute path"])("rejects evidence outside run artifacts via %s", (form) => {
    const store = openStore();
    const { runId } = claimStep(store);
    const outside = path.join(store.workspace, "outside.txt");
    writeFileSync(outside, "outside fixture");
    const source = form === "absolute path" ? outside : path.join("..", "..", "..", "..", "outside.txt");
    expect(() => store.applyExecution(runId, hitOutput(source), usage)).toThrow(/inside this run's artifacts/);
    expect(store.snapshot().evidence).toEqual([]);
  });

  it("rejects a directory junction escape from the artifacts directory", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const outside = path.join(store.workspace, "outside-directory");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "response.txt"), "outside fixture");
    symlinkSync(outside, path.join(artifacts, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => store.applyExecution(runId, hitOutput(path.join("escape", "response.txt")), usage)).toThrow(/inside this run's artifacts/);
  });

  it.each(["empty", "oversized", "directory"])("rejects %s evidence", (form) => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const file = path.join(artifacts, "response.txt");
    if (form === "directory") mkdirSync(file);
    else writeFileSync(file, form === "empty" ? Buffer.alloc(0) : Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(() => store.applyExecution(runId, hitOutput(), usage)).toThrow(/Evidence must/);
    expect(store.snapshot().evidence).toEqual([]);
  });

  it("rejects more than 50 MiB of aggregate evidence in one Execute output", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const evidence: NonNullable<Execution["evidence"]> = [];
    for (let index = 0; index < 6; index++) {
      const filename = `fixture-${index}.bin`;
      writeFileSync(path.join(artifacts, filename), Buffer.alloc(9 * 1024 * 1024, index + 1));
      evidence.push({ ref: `e${index}`, path: filename, description: "Large synthetic fixture artifact" });
    }
    const before = store.snapshot();
    expect(() => store.applyExecution(runId, { summary: "Oversized aggregate evidence", result: "done", evidence }, usage)).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it("rejects duplicate local evidence aliases atomically", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture");
    const output = hitOutput();
    output.evidence!.push({ ...output.evidence![0] });
    expect(() => store.applyExecution(runId, output, usage)).toThrow(/Duplicate or ambiguous evidence ref/);
    expect(store.snapshot().evidence).toEqual([]);
  });

  it("detects archive tampering before a finding can be verified", () => {
    const store = openStore();
    const board = produceHit(store);
    writeFileSync(path.join(store.workspace, board.evidence[0].path), "tampered");
    expect(() => store.verifyEvidence(board.evidence[0])).toThrow(/Evidence changed/);
    expect(() => runDecision(store, verifiedDecision(store), "metacog")).toThrow(/Evidence changed/);
    expect(store.snapshot().findings[0]).toMatchObject({ status: "technical_hit", rating: "unrated" });
  });

  it("detects tampering again at final VULN_FOUND validation", () => {
    const store = openStore();
    produceHit(store);
    const reviewed = runDecision(store, verifiedDecision(store));
    writeFileSync(path.join(store.workspace, reviewed.evidence[0].path), "tampered after review");
    expect(() => runDecision(store, { summary: "Final review", conclusion: { outcome: "VULN_FOUND", reason: "Mock completion" } }, "metacog")).toThrow(/Evidence changed/);
    expect(store.snapshot().outcome).toBeNull();
  });

  it.each(["NOT_REPRODUCED", "LOW_ROI"] as const)("rehashes original evidence before final %s", (outcome) => {
    const store = openStore();
    const board = produceHit(store);
    const review: Decision = outcome === "LOW_ROI" ? verifiedDecision(store, "info") : {
      summary: "Close a validated fixture hypothesis",
      reviews: [{ findingId: board.findings[0].id, status: "closed", rating: "unrated", reason: "Fixture counterexample refutes the hypothesis; reopen for a new identity" }],
    };
    const reviewed = runDecision(store, review);
    writeFileSync(path.join(store.workspace, reviewed.evidence[0].path), "tampered after review");
    expect(() => runDecision(store, { summary: "Final review", conclusion: { outcome, reason: "Mock completion" } }, "metacog")).toThrow(/Evidence changed/);
    expect(store.snapshot().outcome).toBeNull();
  });
});

describe("findings and outcome gates", () => {
  it("deduplicates finding keys, facts and evidence while retaining unrated technical hits", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "A distinct variable with existing evidence");
    const board = store.applyExecution(runId, {
      summary: "Repeated observation with no new evidence", result: "done",
      facts: [{ ref: "f2", description: "  mock RESPONSE difference ", evidenceRefs: [first.evidence[0].id] }],
      findings: [{ key: "  FIXTURE-OWNERSHIP ", title: "Repeated lead", target: "FIXTURE IDENTITY B × OBJECT A", status: "lead", factRefs: ["f2"], evidenceRefs: [first.evidence[0].id], next: "Validate fixture impact" }],
    }, usage);
    expect(board.evidence).toHaveLength(1);
    expect(board.facts).toHaveLength(1);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ id: first.findings[0].id, status: "technical_hit", rating: "unrated" });
    expect(board.noProgressCount).toBe(1);
  });

  it("rejects reuse of a finding key for a different target", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store);
    expect(() => store.applyExecution(runId, { summary: "Conflicting target", result: "done", findings: [{ key: "fixture-ownership", title: "Other target", target: "unrelated fixture", status: "lead", factRefs: [first.facts[0].id], evidenceRefs: [first.evidence[0].id], next: "Verify" }] }, usage)).toThrow(/different target/);
    expect(store.snapshot().findings[0].target).toBe(first.findings[0].target);
  });

  it("does not treat changing next-action prose as new evidence or progress", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "Repeated observation with a reworded next action");
    const board = store.applyExecution(runId, {
      summary: "No additional observation", result: "done",
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "technical_hit", factRefs: [first.facts[0].id], evidenceRefs: [first.evidence[0].id], next: "Reworded guidance without any new evidence", impact: { ...impact, result: "Still only a textual hypothesis" } }],
    }, usage);
    expect(board.findings[0].next).toBe("Reworded guidance without any new evidence");
    expect(board.steps.find(step => step.runId === runId)?.status).toBe("no_progress");
    expect(board.noProgressCount).toBe(1);
  });

  it("counts explicitly reopening a closed finding as a substantive state change", () => {
    const store = openStore();
    const first = produceHit(store);
    runDecision(store, { summary: "Close initial fixture hypothesis", reviews: [{ findingId: first.findings[0].id, status: "closed", rating: "unrated", reason: "Initial variable refuted; reopen under a new fixture state" }] });
    const { runId } = claimStep(store, "New fixture state reopens this hypothesis");
    const board = store.applyExecution(runId, {
      summary: "Reopened following a changed fixture state", result: "done",
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "technical_hit", factRefs: [first.facts[0].id], evidenceRefs: [first.evidence[0].id], next: "Validate reopened fixture state" }],
    }, usage);
    expect(board.findings[0]).toMatchObject({ status: "technical_hit", rating: "unrated" });
    expect(board.findings[0].review).toBeUndefined();
    expect(board.steps.find(step => step.runId === runId)?.status).toBe("done");
    expect(board.noProgressCount).toBe(0);
  });

  it("requires technical validation before a lead may be impact verified", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    store.applyExecution(runId, { summary: "Unverified lead", result: "done", findings: [{ key: "lead", title: "Unverified", target: "fixture", status: "lead", factRefs: [], evidenceRefs: [], next: "Validate" }] }, usage);
    expect(() => runDecision(store, verifiedDecision(store), "metacog")).toThrow(/lead cannot skip/);
  });

  it.each(["rating", "impact", "poc"])("requires %s before verified impact", (missing) => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store);
    if (missing === "rating") decision.reviews![0].rating = "unrated";
    if (missing === "impact") delete decision.reviews![0].impact;
    if (missing === "poc") delete decision.reviews![0].pocEvidenceId;
    expect(() => runDecision(store, decision, "metacog")).toThrow(/Verified impact requires/);
    expect(store.snapshot().findings[0].rating).toBe("unrated");
  });

  it("rejects final outcomes from ordinary Decide even with a complete fixture review", () => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store);
    decision.conclusion = { outcome: "VULN_FOUND", reason: "Premature final result" };
    expect(() => runDecision(store, decision)).toThrow(/fresh metacognitive review/);
    expect(store.snapshot().findings[0].rating).toBe("unrated");
  });

  it("commits a structurally complete mock lifecycle only after metacognitive review", () => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store);
    decision.conclusion = { outcome: "VULN_FOUND", reason: "Mock lifecycle complete; fixture test only" };
    const board = runDecision(store, decision, "metacog");
    expect(board).toMatchObject({ status: "completed", outcome: "VULN_FOUND", lastMetaStep: 1 });
    expect(board.lastMetaRevision).toBe(board.revision);
    expect(board.findings[0]).toMatchObject({ status: "impact_verified", rating: "P3", impact });
    expect(board.usage).toEqual({ input: 30, output: 15, cost: 0.003 });
    expect(store.events().map(event => event.kind)).toContain("execution");
  });

  it.each(["VULN_FOUND", "NOT_REPRODUCED", "LOW_ROI"] as const)("rejects %s when technical impact remains unreviewed", (outcome) => {
    const store = openStore();
    produceHit(store);
    expect(() => runDecision(store, { summary: "Insufficient review", conclusion: { outcome, reason: "Not complete" } }, "metacog")).toThrow();
    expect(store.snapshot().outcome).toBeNull();
  });

  it("refuses final completion while proposed steps remain pending", () => {
    const store = openStore();
    produceHit(store);
    runDecision(store, { summary: "Additional validation", steps: [{ goalId: "G0", from: [], description: "Check a second variable", successSignal: "Observed", evidencePlan: "Save", priority: 10 }] });
    const decision = verifiedDecision(store);
    decision.conclusion = { outcome: "VULN_FOUND", reason: "Incomplete coverage" };
    expect(() => runDecision(store, decision, "metacog")).toThrow(/Pending steps/);
  });

  it("permits LOW_ROI only after info impact validation", () => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store, "info");
    decision.conclusion = { outcome: "LOW_ROI", reason: "Fixture shows test-only impact" };
    expect(runDecision(store, decision, "metacog")).toMatchObject({ outcome: "LOW_ROI", status: "completed" });
  });

  it("permits an evidence-backed closed fixture hypothesis to conclude NOT_REPRODUCED", () => {
    const store = openStore();
    const board = produceHit(store);
    const closed = runDecision(store, {
      summary: "Fixture comparison refuted the hypothesis",
      reviews: [{ findingId: board.findings[0].id, status: "closed", rating: "unrated", reason: "Counterexample in fixture responses; reopen on new object or identity" }],
      conclusion: { outcome: "NOT_REPRODUCED", reason: "Mock hypothesis closed with fixture evidence" },
    }, "metacog");
    expect(closed).toMatchObject({ outcome: "NOT_REPRODUCED", status: "completed" });
    expect(closed.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(closed.findings[0].next).toContain("reopen");
  });

  it("keeps missing-input hypotheses unrated and pauses instead of declaring completion", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    store.applyExecution(runId, { summary: "Missing second fixture identity", result: "blocked", findings: [{ key: "ownership", title: "Ownership lead", target: "fixture object", status: "lead", factRefs: [], evidenceRefs: [], next: "Need user to provide a second authorized fixture account" }] }, usage);
    const board = runDecision(store, { summary: "Input genuinely unavailable", conclusion: { outcome: "NEED_INPUT", reason: "Second account required" } }, "metacog");
    expect(board).toMatchObject({ outcome: "NEED_INPUT", status: "paused" });
    expect(board.findings[0]).toMatchObject({ status: "lead", rating: "unrated" });
    expect(store.setStatus("running", "Second account supplied").outcome).toBeNull();
  });

  it("does not fabricate NEED_INPUT for an empty blackboard", () => {
    const store = openStore();
    expect(() => runDecision(store, { summary: "No work yet", conclusion: { outcome: "NEED_INPUT", reason: "Unjustified" } }, "metacog")).toThrow(/unresolved lead/);
  });

  it("requires original validation evidence before NOT_REPRODUCED, not merely a closed unsupported lead", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    const board = store.applyExecution(runId, { summary: "Only a hypothesis; no request performed", result: "done", findings: [{ key: "unvalidated", title: "No validation yet", target: "fixture", status: "lead", factRefs: [], evidenceRefs: [], next: "Perform actual validation" }] }, usage);
    expect(() => runDecision(store, { summary: "Unsupported closure", reviews: [{ findingId: board.findings[0].id, status: "closed", rating: "unrated", reason: "No observation; reopen with another identity" }], conclusion: { outcome: "NOT_REPRODUCED", reason: "No evidence supplied" } }, "metacog")).toThrow();
  });
});

describe("single controller and restart recovery", () => {
  it("refuses a second writer, preserving the first lock and database", () => {
    const store = openStore();
    const lock = path.join(store.dataDir, "controller.lock");
    const lockContents = readFileSync(lock, "utf8");
    expect(() => openStore(store.workspace)).toThrow(/Another controller owns/);
    expect(readFileSync(lock, "utf8")).toBe(lockContents);
    expect(store.hint("Still owned by first controller").hints).toHaveLength(1);
    store.close();
    expect(existsSync(lock)).toBe(false);
    expect(openStore(store.workspace).snapshot().hints).toHaveLength(1);
  });

  it("recovers interrupted Execute as failed and never restores its ready status", () => {
    const store = openStore();
    const { runId, step } = claimStep(store);
    expect(store.snapshot().steps[0]).toMatchObject({ status: "claimed", attempts: 1, runId });
    store.close();
    const recovered = openStore(store.workspace);
    const board = recovered.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 0, outcome: null });
    expect(board.steps.find(item => item.id === step.id)).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(board.steps[0].result).toMatch(/side effects may have occurred/i);
    expect(recovered.runs().find(run => run.id === runId)?.status).toBe("interrupted");
    recovered.setStatus("running", "Inspect before continuing");
    expect(() => recovered.beginRun(nextRun(), "execute", step.id)).toThrow(/not ready/);
    const dedup = runDecision(recovered, { summary: "Same work must not automatically replay", steps: [{ goalId: "G0", from: [], description: step.description, successSignal: step.successSignal, evidencePlan: step.evidencePlan, priority: step.priority }] });
    expect(dedup.steps).toHaveLength(1);
    expect(dedup.steps[0].status).toBe("failed");
  });

  it("does not overwrite user-owned state/blackboard.md and records projection failure", () => {
    const root = workspace();
    mkdirSync(path.join(root, "state"));
    const projection = path.join(root, "state", "blackboard.md");
    const original = "# Existing user research\nDo not overwrite this file.\n";
    writeFileSync(projection, original);
    const store = openStore(root);
    expect(store.projectionError).toMatch(/Preserving existing/);
    store.hint("This state still commits to SQLite");
    expect(readFileSync(projection, "utf8")).toBe(original);
    expect(store.snapshot().hints).toHaveLength(1);
  });

  it("rejects a different goal without destroying state or retaining its failed-constructor lock", () => {
    const store = openStore();
    store.hint("Preserve this task");
    store.close();
    expect(() => new BlackboardStore(store.workspace, defaultConfig("A different task"))).toThrow(/different goal\/scope/);
    expect(existsSync(path.join(store.dataDir, "controller.lock"))).toBe(false);
    expect(openStore(store.workspace).snapshot().hints[0].content).toBe("Preserve this task");
  });
});
