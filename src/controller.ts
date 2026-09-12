import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BlackboardStore } from "./store.js";
import { decisionSchema, usageSchema } from "./schema.js";
import type { AgentRunner, BoardSnapshot, LoopEvent, Mode, RunResult, Step, Usage } from "./types.js";

/** Local sequential scheduler, not an Agent. It alone commits all Agent proposals. */
export class LoopController {
  private listeners = new Set<(event: LoopEvent) => void>();
  private active?: Promise<void>;
  private cancellation?: AbortController;
  private manualMeta = false;
  private interruptReason = "Interrupted by user";

  constructor(readonly store: BlackboardStore, private readonly runner: AgentRunner) {}
  snapshot(): BoardSnapshot { return this.store.snapshot(); }
  waitForIdle(): Promise<void> { return this.active ?? Promise.resolve(); }
  subscribe(listener: (event: LoopEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: LoopEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* A renderer cannot break a committed run. */ } } }
  private board(type: "board" | "state" = "board"): void {
    this.emit({ type, snapshot: this.snapshot() });
    if (this.store.projectionError) this.emit({ type: "notice", message: `Blackboard view could not be updated: ${this.store.projectionError}` });
  }
  private notice(message: string): void { this.emit({ type: "notice", message }); }
  hint(content: string): void { this.store.hint(content); this.board(); this.notice("Hint saved to blackboard; read at the next fresh planning boundary."); }
  requestMetacog(): void {
    this.manualMeta = true;
    this.notice("Metacognitive review queued on the Decide channel.");
    if (!this.active) void this.start().catch(error => this.notice(String(error)));
  }

  start(): Promise<void> {
    if (this.active) return this.active;
    if (this.snapshot().status === "completed") { this.notice("This task has concluded. Use a new workspace for a new task."); return Promise.resolve(); }
    this.active = Promise.resolve().then(() => this.loop()).catch(error => {
      this.store.setStatus("error", error instanceof Error ? error.message : String(error)); this.board("state");
    }).finally(() => { this.cancellation = undefined; this.active = undefined; });
    this.store.setStatus("running", "Starting a fresh planning context");
    this.board("state");
    return this.active;
  }
  pause(): void { this.interrupt("paused", "Paused by user; interrupted steps are not automatically replayed."); }
  stop(): void { this.interrupt("stopped", "Stopped by user; state and evidence retained."); }
  private interrupt(status: "paused" | "stopped", reason: string): void {
    if (this.snapshot().status === "completed") return;
    this.interruptReason = reason;
    this.cancellation?.abort(new Error(reason));
    this.store.setStatus(status, reason);
    this.board("state");
  }

  private budgetReason(board: BoardSnapshot): string | undefined {
    const { limits } = board.config;
    if (limits.maxTokens !== null && board.usage.input + board.usage.output >= limits.maxTokens) return "Token budget exhausted";
    if (limits.maxCost !== null && board.usage.cost >= limits.maxCost) return "Estimated cost budget exhausted";
    if (limits.maxMinutes !== null && (board.elapsedMs ?? 0) >= limits.maxMinutes * 60000) return "Time budget exhausted";
    return undefined;
  }

  private async loop(): Promise<void> {
    let mode: Mode = this.manualMeta ? "metacog" : "decide";
    this.manualMeta = false;
    while (this.snapshot().status === "running") {
      let snapshot = this.snapshot();
      if (this.manualMeta) { mode = "metacog"; this.manualMeta = false; }
      const exhausted = this.budgetReason(snapshot);
      if (exhausted) { this.store.setStatus("paused", `${exhausted}; explicit resource limit reached, not Goal completion. Review configured limits in xloom.json before resuming.`); this.board("state"); return; }
      const step: Step | undefined = mode === "execute" ? [...snapshot.steps].filter(item => item.status === "ready").sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0] : undefined;
      if (mode === "execute" && !step) { mode = "metacog"; continue; }
      const runId = `${mode}-${randomUUID()}`;
      const runDir = path.join(this.store.dataDir, "runs", runId);
      mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
      snapshot = this.store.beginRun(runId, mode, step?.id);
      const claimedStep = step ? snapshot.steps.find(item => item.id === step.id) : undefined;
      this.cancellation = new AbortController();
      const remainingMs = snapshot.config.limits.maxMinutes === null ? Infinity : snapshot.config.limits.maxMinutes * 60000 - (snapshot.elapsedMs ?? 0);
      const timeoutMs = Math.max(1, Math.min(snapshot.config.limits.stepTimeoutSeconds * 1000, remainingMs));
      const cancellation = this.cancellation;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; cancellation.abort(new Error("Run time limit reached")); }, timeoutMs);
      this.board();
      let result: RunResult | undefined;
      let needsCompletionReview = false;
      let hintsChanged = false;
      try {
        result = await this.runner.run({ id: runId, mode, snapshot, workspace: this.store.workspace, runDir, step: claimedStep,
          signal: cancellation.signal, onEvent: runtime => this.emit({ type: "runtime", runtime }) });
        if (cancellation.signal.aborted) throw new Error(timedOut ? "Run time limit reached" : this.interruptReason);
        hintsChanged = this.snapshot().hints.length !== snapshot.hints.length;
        if (mode === "execute") this.store.applyExecution(runId, result.output, result.usage);
        else {
          const decision = decisionSchema.parse(result.output);
          const rootIds = new Set(snapshot.goals.filter(goal => goal.parentId === null).map(goal => goal.id));
          const completesRoot = decision.updateGoals?.some(goal => rootIds.has(goal.id));
          if ((decision.conclusion || completesRoot) && (mode !== "metacog" || hintsChanged)) {
            needsCompletionReview = true;
            delete decision.conclusion;
            if (decision.updateGoals) decision.updateGoals = decision.updateGoals.filter(goal => !rootIds.has(goal.id));
            this.notice(hintsChanged ? "New hint arrived during planning; conclusion deferred for a fresh review." : "Completion proposed; starting a fresh metacognitive review before concluding.");
          }
          this.store.applyDecision(runId, decision, result.usage);
        }
        this.board();
      } catch (error) {
        const partial = usageSchema.safeParse(error && typeof error === "object" && "usage" in error ? error.usage : undefined);
        const completedUsage = usageSchema.safeParse(result?.usage);
        const usage: Usage = completedUsage.success ? completedUsage.data : partial.success ? partial.data : { input: 0, output: 0, cost: 0 };
        if (result && !completedUsage.success) this.notice("Runner returned invalid usage; this run's consumption is unknown and was not added to the estimated budget.");
        const reason = error instanceof Error ? error.message : String(error);
        this.store.failRun(runId, reason, usage, cancellation.signal.aborted);
        if (timedOut) this.store.setStatus("paused", "Run time limit reached; inspect interrupted step state before resuming.");
        this.board("state");
        return;
      } finally { clearTimeout(timeout); this.cancellation = undefined; }

      const current = this.snapshot();
      if (current.status !== "running" || current.outcome) return;
      if (hintsChanged) { mode = "metacog"; continue; }
      if (needsCompletionReview) { mode = "metacog"; continue; }
      if (mode === "execute") {
        const completed: Step | undefined = current.steps.find(item => item.id === step?.id);
        const due = current.completedSteps - current.lastMetaStep >= current.config.limits.metacogEvery;
        mode = due || current.noProgressCount >= current.config.limits.maxNoProgress || completed?.status === "blocked" ? "metacog" : "decide";
      } else if (mode === "metacog") {
        if (!current.steps.some(item => item.status === "ready")) {
          this.store.setStatus("paused", "Review produced no executable step or evidence-backed conclusion. Add a hint and resume."); this.board("state"); return;
        }
        mode = "execute";
      } else mode = current.steps.some(item => item.status === "ready") ? "execute" : "metacog";
    }
  }
}
