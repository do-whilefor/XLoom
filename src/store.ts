import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decisionSchema, executionSchema, projectConfigSchema, usageSchema } from "./schema.js";
import type { BoardSnapshot, Decision, Evidence, Execution, Mode, OuterLoopTrigger, Outcome, ProjectConfig, RunStatus, Usage } from "./types.js";

const marker = "<!-- xloom generated blackboard; SQLite is authoritative -->";
const zeroUsage = (): Usage => ({ input: 0, output: 0, cost: 0 });
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;
const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
const union = <T>(...lists: T[][]): T[] => [...new Set(lists.flat())];
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const progressKey = (board: BoardSnapshot) => JSON.stringify({ facts: board.facts.map(item => item.id), evidence: board.evidence.map(item => item.sha256).sort(), findings: board.findings.map(item => ({ key: item.key, status: item.status, evidence: [...item.evidenceIds].sort(), facts: [...item.factIds].sort() })) });
const assert: (test: unknown, message: string) => asserts test = (test, message) => { if (!test) throw new Error(message); };
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export interface StoredRun { id: string; mode: Mode; stepId: string | null; status: string; startedAt: number; finishedAt: number | null }

/** Single local writer. Events and the current graph are committed in one SQLite transaction. */
export class BlackboardStore {
  readonly workspace: string;
  readonly dataDir: string;
  projectionError: string | null = null;
  private db!: DatabaseSync;
  private lockPath: string;
  private lockToken = randomUUID();
  private closed = false;

  constructor(workspace: string, config: ProjectConfig) {
    this.workspace = realpathSync(workspace);
    this.dataDir = path.join(this.workspace, ".xloom");
    this.lockPath = path.join(this.dataDir, "controller.lock");
    config = projectConfigSchema.parse(config);
    mkdirSync(this.dataDir, { recursive: true });
    this.acquireLock();
    try {
      this.db = new DatabaseSync(path.join(this.dataDir, "blackboard.sqlite"));
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.db.exec(`CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, stepId TEXT, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER);`);
      const old = this.db.prepare("SELECT value FROM board WHERE id=1").get();
      if (!old) {
        const board: BoardSnapshot = { revision: 0, config, status: "idle", outcome: null, reason: "Ready",
          goals: [{ id: "G0", description: config.goal, parentId: null, status: "active", factIds: [] }],
          facts: [], steps: [], evidence: [], findings: [], hints: [], usage: zeroUsage(),
          completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: -1, elapsedMs: 0 };
        this.db.prepare("INSERT INTO board VALUES (1, ?)").run(JSON.stringify(board));
        this.event("initialized", { version: 1 });
      } else {
        const previous = this.snapshot();
        assert(previous.config.goal === config.goal && previous.config.scope === config.scope,
          "Existing blackboard belongs to a different goal/scope. Use a new workspace for a new task.");
        this.recover();
        this.recoverLegacyGoal();
        if (JSON.stringify(this.snapshot().config) !== JSON.stringify(config)) this.mutate("config_updated", {}, board => { board.config = config; });
      }
      this.project();
    } catch (error) {
      this.db?.close();
      this.releaseLock();
      throw error;
    }
  }

  private acquireLock(): void {
    try {
      const fd = openSync(this.lockPath, "wx");
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken })); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: { pid: number };
      try { previous = JSON.parse(readFileSync(this.lockPath, "utf8")); } catch {
        throw new Error(`Unreadable controller lock: ${this.lockPath}. Check for an active process before manually removing it.`);
      }
      assert(Number.isInteger(previous.pid) && previous.pid > 0, "Invalid controller lock; manual inspection required.");
      try { process.kill(previous.pid, 0); } catch (checkError) {
        if ((checkError as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(this.lockPath); this.acquireLock(); return; }
      }
      throw new Error(`Another controller owns this workspace (PID ${previous.pid}).`);
    }
  }

  private releaseLock(): void {
    if (!existsSync(this.lockPath)) return;
    try { if (JSON.parse(readFileSync(this.lockPath, "utf8")).token === this.lockToken) unlinkSync(this.lockPath); } catch { /* Preserve an unknown lock. */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.releaseLock();
  }

  snapshot(): BoardSnapshot { return JSON.parse(String(this.db.prepare("SELECT value FROM board WHERE id=1").get()!.value)); }
  events(): { seq: number; at: string; kind: string; payload: string }[] { return this.db.prepare("SELECT * FROM events ORDER BY seq").all() as never; }
  runs(): StoredRun[] { return this.db.prepare("SELECT * FROM runs ORDER BY startedAt").all() as never; }
  private event(kind: string, payload: unknown): void { this.db.prepare("INSERT INTO events (at,kind,payload) VALUES (?,?,?)").run(new Date().toISOString(), kind, JSON.stringify(payload)); }

  private mutate(kind: string, payload: unknown, change: (board: BoardSnapshot) => void): BoardSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const board = this.snapshot();
      change(board);
      board.revision++;
      this.db.prepare("UPDATE board SET value=? WHERE id=1").run(JSON.stringify(board));
      this.event(kind, payload);
      this.db.exec("COMMIT");
      this.project();
      return board;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private recover(): void {
    const active = this.runs().filter(run => run.status === "running");
    if (!active.length && this.snapshot().status !== "running") return;
    this.mutate("recovered", { interrupted: active.map(run => run.id) }, board => {
      for (const step of board.steps.filter(step => step.status === "claimed")) {
        step.status = "failed";
        step.leaseUntil = null;
        step.result = "Interrupted; side effects may have occurred. Inspect evidence and current target state before proposing any retry.";
      }
      for (const run of active) {
        board.elapsedMs = (board.elapsedMs ?? 0) + Math.min(Date.now() - run.startedAt, board.config.limits.stepTimeoutSeconds * 1000);
        this.db.prepare("UPDATE runs SET status='interrupted',finishedAt=? WHERE id=?").run(Date.now(), run.id);
      }
      board.status = "paused";
      board.reason = "Recovered interrupted run. No step was replayed; token usage for an abruptly killed call may be incomplete.";
    });
  }

  private recoverLegacyGoal(): void {
    const previous = this.snapshot();
    const root = previous.goals.find(goal => goal.id === "G0" && goal.parentId === null);
    if (!root || (previous.status === "completed" ? root.status === "satisfied" : root.status === "active")) return;
    this.mutate("legacy_goal_recovered", { prior: { status: previous.status, outcome: previous.outcome, rootStatus: root.status, reason: previous.reason } }, board => {
      board.goals.find(goal => goal.id === "G0" && goal.parentId === null)!.status = "active";
      if (board.status === "completed") {
        board.status = "paused";
        board.outcome = null;
        board.reason = "Legacy completion requires a fresh Goal review. State and evidence retained; no Step was replayed. Use /start to review the whole Goal.";
      } else {
        board.reason = "Legacy inactive root Goal reopened for fresh planning. State and evidence retained; no Step was replayed. Use /start to continue.";
      }
    });
  }

  setStatus(status: RunStatus, reason: string): BoardSnapshot {
    return this.mutate("status", { status, reason }, board => {
      board.status = status; board.reason = reason;
      if (status === "running" && board.outcome === "NEED_INPUT") board.outcome = null;
    });
  }

  hint(content: string): BoardSnapshot {
    assert(content.trim().length > 0 && content.length <= 12000, "Hint must contain 1–12000 characters.");
    return this.mutate("hint", { content }, board => { board.hints.push({ id: id("H"), content: content.trim(), createdAt: new Date().toISOString() }); });
  }

  beginRun(runId: string, mode: Mode, stepId?: string, trigger?: OuterLoopTrigger): BoardSnapshot {
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(runId), "Invalid run ID.");
    return this.mutate("run_started", { runId, mode, stepId, trigger }, board => {
      assert(board.status === "running", "Controller is not running.");
      assert(!this.runs().some(run => run.status === "running"), "A run is already active.");
      if (mode === "execute") {
        const step = board.steps.find(item => item.id === stepId);
        assert(step && step.status === "ready", "Step is not ready.");
        step.status = "claimed"; step.attempts++; step.runId = runId;
        step.leaseUntil = Date.now() + board.config.limits.stepTimeoutSeconds * 1000;
      } else assert(!stepId, "Only Execute may claim a step.");
      this.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,NULL)").run(runId, mode, stepId ?? null, "running", Date.now());
    });
  }

  private finishRun(board: BoardSnapshot, runId: string, usage: Usage, status: string): StoredRun {
    usage = usageSchema.parse(usage);
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as unknown as StoredRun | undefined;
    assert(run?.status === "running", "Run is not active or was already committed.");
    board.usage.input += usage.input; board.usage.output += usage.output; board.usage.cost += usage.cost;
    board.elapsedMs = (board.elapsedMs ?? 0) + Math.max(0, Date.now() - run.startedAt);
    this.db.prepare("UPDATE runs SET status=?,finishedAt=? WHERE id=?").run(status, Date.now(), runId);
    return run;
  }

  failRun(runId: string, reason: string, usage = zeroUsage(), cancelled = false): BoardSnapshot {
    return this.mutate("run_failed", { runId, reason, cancelled }, board => {
      const run = this.finishRun(board, runId, usage, cancelled ? "cancelled" : "failed");
      if (run.stepId) {
        const step = board.steps.find(item => item.id === run.stepId)!;
        step.status = "failed"; step.leaseUntil = null; step.result = `${reason} Side effects may have occurred; do not replay blindly.`;
      }
      if (board.status === "running") { board.status = cancelled ? "paused" : "error"; board.reason = reason; }
    });
  }

  applyDecision(runId: string, input: unknown, usage: Usage): BoardSnapshot {
    const decision: Decision = decisionSchema.parse(input);
    return this.mutate("decision", { runId, decision }, board => {
      const run = this.finishRun(board, runId, usage, "completed");
      assert(run.mode === "decide" || run.mode === "metacog", "Wrong run channel.");
      const factsExist = (ids: string[]) => assert(ids.every(ref => board.facts.some(fact => fact.id === ref)), "Unknown fact reference.");
      for (const goal of decision.goals ?? []) {
        assert(!board.goals.some(item => item.id === goal.id), `Goal ${goal.id} already exists.`);
        assert(board.goals.some(item => item.id === goal.parentId && item.status === "active"), "Unknown or inactive parent goal.");
        board.goals.push({ ...goal, status: "active", factIds: [] });
      }
      for (const update of decision.updateSteps ?? []) {
        const step = board.steps.find(item => item.id === update.id);
        assert(step?.status === "ready", "Only ready steps may be changed.");
        if (update.action === "abandon") { step.status = "abandoned"; step.result = update.reason; }
        else { assert(update.priority !== undefined, "Prioritize requires priority."); step.priority = update.priority; }
      }
      for (const update of decision.updateGoals ?? []) {
        const goal = board.goals.find(item => item.id === update.id);
        assert(goal?.status === "active", "Unknown or inactive goal.");
        if (goal.id === "G0") {
          assert(update.status === "satisfied", "The root goal cannot be abandoned; unfinished work must remain active.");
          assert(run.mode === "metacog", "Root goal completion requires a fresh metacognitive review.");
          assert(decision.conclusion && decision.conclusion.outcome !== "NEED_INPUT", "Root goal completion requires a final conclusion in the same review; missing input is not completion.");
        }
        factsExist(update.factIds);
        if (update.status === "satisfied") assert(update.factIds.length > 0, "Satisfied goals require evidence-backed facts.");
        assert(!board.steps.some(step => step.goalId === goal.id && ["ready", "claimed"].includes(step.status)), "Resolve a goal's pending steps first.");
        assert(!board.goals.some(child => child.parentId === goal.id && child.status === "active"), "Resolve active child goals first.");
        goal.status = update.status; goal.factIds = update.factIds;
      }
      for (const proposal of decision.steps ?? []) {
        assert(board.goals.some(goal => goal.id === proposal.goalId && goal.status === "active"), "Step requires an active goal.");
        factsExist(proposal.from);
        const equivalent = board.steps.some(step => step.goalId === proposal.goalId && normalize(step.description) === normalize(proposal.description) && JSON.stringify([...step.from].sort()) === JSON.stringify([...proposal.from].sort()));
        if (!equivalent) board.steps.push({ ...proposal, id: id("S"), status: "ready", attempts: 0, runId: null, leaseUntil: null });
      }
      for (const review of decision.reviews ?? []) {
        const finding = board.findings.find(item => item.id === review.findingId);
        assert(finding, "Unknown finding in review.");
        if (review.status === "impact_verified") {
          assert(["technical_hit", "impact_verified"].includes(finding.status), "A lead cannot skip technical validation.");
          assert(review.rating !== "unrated" && review.impact && review.pocEvidenceId, "Verified impact requires rating, impact and PoC evidence.");
          assert(finding.evidenceIds.length > 0 && finding.factIds.length > 0 && finding.evidenceIds.includes(review.pocEvidenceId), "PoC and facts must belong to the finding.");
          for (const evidenceId of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === evidenceId)!);
          finding.impact = review.impact; finding.pocEvidenceId = review.pocEvidenceId;
        } else {
          assert(review.rating === "unrated", "Closed findings remain unrated.");
          assert(finding.evidenceIds.length > 0 && finding.factIds.length > 0, "Closing a hypothesis requires evidence-backed validation, not just an assertion.");
          for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
        }
        finding.status = review.status; finding.rating = review.rating; finding.review = review.reason;
        if (review.status === "closed") finding.next = review.reason;
      }
      if (run.mode === "metacog") { board.lastMetaStep = board.completedSteps; board.lastMetaRevision = board.revision + 1; }
      board.reason = decision.summary;
      if (decision.conclusion) {
        assert(run.mode === "metacog", "Completion requires a fresh metacognitive review.");
        this.validateConclusion(board, decision.conclusion.outcome);
        board.outcome = decision.conclusion.outcome;
        board.status = board.outcome === "NEED_INPUT" ? "paused" : "completed";
        board.reason = decision.conclusion.reason;
      }
    });
  }

  applyExecution(runId: string, input: unknown, usage: Usage): BoardSnapshot {
    const output: Execution = executionSchema.parse(input);
    return this.mutate("execution", { runId, output }, board => {
      const run = this.finishRun(board, runId, usage, "completed");
      assert(run.mode === "execute", "Wrong run channel.");
      const step = board.steps.find(item => item.id === run.stepId);
      assert(step?.status === "claimed" && step.runId === runId, "Step claim does not match run.");
      const before = progressKey(board);
      const evidenceMap = new Map<string, string>();
      const factMap = new Map<string, string>();
      let artifactBytes = 0;
      for (const proposal of output.evidence ?? []) {
        assert(!evidenceMap.has(proposal.ref) && !board.evidence.some(item => item.id === proposal.ref), "Duplicate or ambiguous evidence ref.");
        const evidence = this.ingestEvidence(runId, step.id, proposal.path, proposal.description);
        artifactBytes += evidence.bytes;
        assert(artifactBytes <= 50 * 1024 * 1024, "A result may attach at most 50 MiB of evidence.");
        const existing = board.evidence.find(item => item.sha256 === evidence.sha256);
        if (!existing) board.evidence.push(evidence);
        evidenceMap.set(proposal.ref, existing?.id ?? evidence.id);
      }
      const resolveEvidence = (refs: string[]) => union(refs.map(ref => {
        const resolved = evidenceMap.get(ref) ?? ref;
        assert(board.evidence.some(item => item.id === resolved), `Unknown evidence reference: ${ref}`); return resolved;
      }));
      for (const proposal of output.facts ?? []) {
        assert(!factMap.has(proposal.ref) && !board.facts.some(item => item.id === proposal.ref), "Duplicate or ambiguous fact ref.");
        const evidenceIds = resolveEvidence(proposal.evidenceRefs);
        assert(evidenceIds.length > 0, "Facts require original evidence references; unsupported claims belong in leads.");
        if (proposal.supersedes) assert(board.facts.some(item => item.id === proposal.supersedes), "Unknown superseded fact.");
        const existing = board.facts.find(item => normalize(item.description) === normalize(proposal.description) && JSON.stringify([...item.evidenceIds].sort()) === JSON.stringify([...evidenceIds].sort()) && item.supersedes === proposal.supersedes);
        const factId = existing?.id ?? id("F");
        if (!existing) board.facts.push({ id: factId, description: proposal.description, stepId: step.id, evidenceIds, ...(proposal.supersedes ? { supersedes: proposal.supersedes } : {}) });
        factMap.set(proposal.ref, factId);
      }
      for (const proposal of output.findings ?? []) {
        const key = normalize(proposal.key);
        const evidenceIds = resolveEvidence(proposal.evidenceRefs);
        const factIds = union(proposal.factRefs.map(ref => {
          const resolved = factMap.get(ref) ?? ref;
          assert(board.facts.some(item => item.id === resolved), `Unknown fact reference: ${ref}`); return resolved;
        }));
        if (proposal.status === "technical_hit") assert(evidenceIds.length > 0 && factIds.length > 0, "A technical hit requires evidence-backed facts.");
        const pocEvidenceId = proposal.pocEvidenceRef ? resolveEvidence([proposal.pocEvidenceRef])[0] : undefined;
        if (pocEvidenceId) assert(evidenceIds.includes(pocEvidenceId), "PoC evidence must be attached to this finding.");
        let finding = board.findings.find(item => item.key === key);
        const allEvidence = union(finding?.evidenceIds ?? [], evidenceIds);
        assert(factIds.every(ref => board.facts.find(item => item.id === ref)!.evidenceIds.every(evidenceId => allEvidence.includes(evidenceId))), "All evidence backing a finding's facts must be attached to that finding.");
        if (finding) {
          assert(normalize(finding.target) === normalize(proposal.target), "A finding key cannot be reused for a different target.");
          finding.evidenceIds = union(finding.evidenceIds, evidenceIds); finding.factIds = union(finding.factIds, factIds);
          finding.status = finding.status === "technical_hit" && proposal.status === "lead" ? "technical_hit" : proposal.status;
          finding.rating = "unrated"; finding.next = proposal.next; delete finding.review;
          if (proposal.impact) finding.impact = proposal.impact;
          if (pocEvidenceId) finding.pocEvidenceId = pocEvidenceId;
        } else {
          finding = { id: id("V"), key, target: proposal.target, title: proposal.title, status: proposal.status, rating: "unrated", evidenceIds, factIds, next: proposal.next,
            ...(proposal.impact ? { impact: proposal.impact } : {}), ...(pocEvidenceId ? { pocEvidenceId } : {}) };
          board.findings.push(finding);
        }
      }
      const after = progressKey(board);
      const progress = before !== after;
      step.status = output.result === "blocked" ? "blocked" : progress ? "done" : "no_progress";
      step.result = output.summary; step.leaseUntil = null;
      board.completedSteps++; board.noProgressCount = progress ? 0 : board.noProgressCount + 1;
      board.reason = output.summary;
    });
  }

  private ingestEvidence(runId: string, stepId: string, source: string, description: string): Evidence {
    const artifactDir = realpathSync(path.join(this.dataDir, "runs", runId, "artifacts"));
    const candidate = path.isAbsolute(source) ? source : path.resolve(artifactDir, source);
    const canonical = realpathSync(candidate);
    assert(inside(artifactDir, canonical), "Evidence must be a regular file inside this run's artifacts directory.");
    assert(statSync(canonical).isFile() && statSync(canonical).size <= 10 * 1024 * 1024, "Evidence must be a regular file at most 10 MiB.");
    const data = readFileSync(canonical);
    assert(data.length > 0 && data.length <= 10 * 1024 * 1024, "Evidence must contain 1 byte–10 MiB.");
    const sha256 = hash(data);
    const targetDir = path.join(this.dataDir, "evidence");
    mkdirSync(targetDir, { recursive: true });
    const destination = path.join(targetDir, `${sha256}.bin`);
    if (!existsSync(destination)) writeFileSync(destination, data, { flag: "wx" });
    else assert(hash(readFileSync(destination)) === sha256, "Evidence archive integrity failure.");
    const text = data.subarray(0, 4096).toString("utf8");
    const excerpt = text.includes("\u0000") ? "[binary artifact; inspect the referenced file]" : text + (data.length > 4096 ? "\n[truncated: inspect the referenced artifact]" : "");
    return { id: id("E"), path: path.relative(this.workspace, destination).replaceAll("\\", "/"), sha256, bytes: data.length, description, runId, stepId, excerpt };
  }

  verifyEvidence(evidence: Evidence): void {
    assert(evidence, "Evidence not found.");
    const file = realpathSync(path.resolve(this.workspace, evidence.path));
    assert(inside(realpathSync(path.join(this.dataDir, "evidence")), file), "Evidence escaped archive.");
    const data = readFileSync(file);
    assert(data.length === evidence.bytes && hash(data) === evidence.sha256, `Evidence changed: ${evidence.id}`);
  }

  private validateConclusion(board: BoardSnapshot, outcome: Outcome): void {
    const open = board.findings.filter(item => ["lead", "technical_hit"].includes(item.status));
    if (outcome === "NEED_INPUT") {
      assert(open.length > 0 && open.every(item => item.next.trim()), "NEED_INPUT requires an unresolved lead/hit and a specific missing input recorded in next.");
      return;
    }
    assert(!board.steps.some(step => ["ready", "claimed"].includes(step.status)), "Pending steps must be completed or explicitly abandoned before conclusion.");
    assert(board.completedSteps > 0, "Cannot conclude before execution.");
    const root = board.goals.find(goal => goal.id === "G0" && goal.parentId === null);
    assert(root?.status === "satisfied", "Final completion requires the root goal G0 to be satisfied, not just an individual finding.");
    assert(!board.goals.some(goal => goal.id !== "G0" && goal.status === "active"), "Resolve all active child goals before final completion.");
    assert(root.factIds.length > 0, "Root goal completion requires evidence-backed facts.");
    for (const factId of root.factIds) {
      const fact = board.facts.find(item => item.id === factId);
      assert(fact && fact.evidenceIds.length > 0, "Root goal completion requires valid evidence-backed facts.");
      for (const evidenceId of fact.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === evidenceId)!);
    }
    if (outcome === "VULN_FOUND") {
      const reportable = board.findings.filter(item => item.status === "impact_verified" && ["P1", "P2", "P3"].includes(item.rating));
      assert(reportable.length > 0, "VULN_FOUND requires verified impact and a reproducible PoC.");
      for (const finding of reportable) { assert(finding.pocEvidenceId && finding.review && finding.impact, "Finding review is incomplete."); for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!); }
    } else if (outcome === "NOT_REPRODUCED") {
      assert(board.findings.length > 0 && board.findings.every(item => item.status === "closed" && item.rating === "unrated"), "NOT_REPRODUCED requires reasonably validated, closed hypotheses.");
      for (const finding of board.findings) for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
    } else {
      assert(open.length === 0 && board.findings.some(item => item.status === "impact_verified" && item.rating === "info") && board.findings.every(item => item.status === "closed" || item.rating === "info"), "LOW_ROI requires validated info-only impact, with no unresolved findings.");
      for (const finding of board.findings) for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
    }
  }

  private project(): void {
    try {
      const stateDir = path.join(this.workspace, "state");
      mkdirSync(stateDir, { recursive: true });
      const file = path.join(stateDir, "blackboard.md");
      assert(!existsSync(file) || readFileSync(file, "utf8").startsWith(marker), "Preserving existing state/blackboard.md; not an xloom-generated view.");
      const board = this.snapshot();
      const rows = [marker, "# xloom blackboard", "", `Revision: ${board.revision} · ${board.status} · ${board.outcome ?? "unrated / in progress"}`, "", board.reason, "", "## Goals", "", ...board.goals.map(item => `- ${item.id} [${item.status}] ${item.description}`), "", "## Steps", "", ...board.steps.map(item => `- ${item.id} → ${item.goalId} [${item.status}] ${item.description}${item.result ? ` — ${item.result}` : ""}`), "", "## Facts", "", ...board.facts.map(item => `- ${item.id}: ${item.description} (evidence: ${item.evidenceIds.join(", ")})`), "", "## Tested hypotheses", "", "```yaml", "tested:"];
      for (const finding of board.findings) rows.push(`  - target: ${JSON.stringify(finding.target)}`, `    finding_status: ${finding.status}`, `    rating: ${finding.rating}`, `    evidence: ${JSON.stringify(finding.evidenceIds)}`, `    next: ${JSON.stringify(finding.next)}`);
      rows.push("```", "", "## Evidence", "", ...board.evidence.map(item => `- ${item.id}: ${item.path} (${item.bytes} bytes, SHA-256 ${item.sha256}) — ${item.description}`), "", "## User hints", "", ...board.hints.map(item => `- ${item.id}: ${item.content}`), "");
      const temporary = `${file}.${this.lockToken}.tmp`;
      writeFileSync(temporary, rows.join("\n"), "utf8");
      renameSync(temporary, file);
      this.projectionError = null;
    } catch (error) { this.projectionError = (error as Error).message; }
  }
}
