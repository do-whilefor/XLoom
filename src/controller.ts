import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BlackboardStore } from "./store.js";
import { decisionSchema, usageSchema } from "./schema.js";
import { pendingStepReviews, projectContext, type ContextProjector } from "./loop/context.js";
import { defaultLoopPolicy, type LoopPolicy } from "./loop/policy.js";
import { normalizeDecisionInput } from "./loop/decision-input.js";
import { planningMaterials } from "./wiki/materials.js";
import type { AgentRunner, BoardSnapshot, LoopEvent, Mode, OuterLoopTrigger, RunRequest, RunResult, Step, Usage } from "./types.js";

/** Code-level extension seams, not dynamically loaded plugins or Agent tools. */
export interface LoopControllerOptions { policy?: LoopPolicy; projectContext?: ContextProjector }

/** Local sequential scheduler, not an Agent. It alone commits all Agent proposals. */
export class LoopController {
  private listeners = new Set<(event: LoopEvent) => void>();
  private active?: Promise<void>;
  private cancellation?: AbortController;
  private manualMeta = false;
  private interruptReason = "Interrupted by user";
  private readonly policy: LoopPolicy;
  private readonly projectContext: ContextProjector;

  constructor(readonly store: BlackboardStore, private readonly runner: AgentRunner, options: LoopControllerOptions = {}) {
    this.policy = options.policy ?? defaultLoopPolicy;
    this.projectContext = options.projectContext ?? projectContext;
  }
  snapshot(): BoardSnapshot { return this.store.snapshot(); }
  waitForIdle(): Promise<void> { return this.active ?? Promise.resolve(); }
  subscribe(listener: (event: LoopEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: LoopEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* A renderer cannot break a committed run. */ } } }
  private board(type: "board" | "state" = "board"): void {
    this.emit({ type, snapshot: this.snapshot() });
    if (this.store.projectionError) this.emit({ type: "notice", message: `Blackboard view could not be updated: ${this.store.projectionError}` });
    if (this.store.wikiProjectionError) this.emit({ type: "notice", message: `Wiki view could not be updated; committed state was retained: ${this.store.wikiProjectionError}` });
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
    let trigger: OuterLoopTrigger = this.manualMeta ? { kind: "manual", reason: "User requested a fresh metacognitive review." }
      : this.snapshot().steps.length ? { kind: "resume", reason: "Resume from saved facts and inspect interrupted work; do not replay Steps blindly." }
      : { kind: "start", reason: "Interpret the user-supplied origin and Goal, identify observable completion conditions, and choose a useful first Step." };
    this.manualMeta = false;
    while (this.snapshot().status === "running") {
      let snapshot = this.snapshot();
      if (this.manualMeta) { mode = "metacog"; trigger = { kind: "manual", reason: "User requested a fresh metacognitive review." }; this.manualMeta = false; }
      const exhausted = this.budgetReason(snapshot);
      if (exhausted) { this.store.setStatus("paused", `${exhausted}; explicit resource limit reached, not Goal completion. Review configured workspace limits before resuming.`); this.board("state"); return; }
      const step: Step | undefined = mode === "execute" ? this.policy.selectStep(snapshot) : undefined;
      if (step && pendingStepReviews(snapshot).some(review => review.stepId === step.id)) {
        this.store.setStatus("paused", `Scheduling policy selected Step ${step.id} with superseded dependencies. Review and replace this plan before resuming.`);
        this.board("state"); return;
      }
      if (mode === "execute" && !step) { mode = "metacog"; trigger = { kind: "empty_plan", reason: "No ready Step; identify missing work or justify Goal completion from evidence." }; continue; }
      const runId = `${mode}-${randomUUID()}`;
      const runDir = path.join(this.store.dataDir, "runs", runId);
      mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
      snapshot = this.store.beginRun(runId, mode, step?.id, trigger);
      const claimedStep = step ? snapshot.steps.find(item => item.id === step.id) : undefined;
      this.cancellation = new AbortController();
      const remainingMs = snapshot.config.limits.maxMinutes === null ? Infinity : snapshot.config.limits.maxMinutes * 60000 - (snapshot.elapsedMs ?? 0);
      const stepTimeoutMs = snapshot.config.limits.stepTimeoutSeconds === null ? Infinity : snapshot.config.limits.stepTimeoutSeconds * 1000;
      const timeoutMs = Math.max(1, Math.min(stepTimeoutMs, remainingMs));
      const timeoutReason = remainingMs <= stepTimeoutMs ? "Time budget exhausted" : "Run time limit reached";
      const cancellation = this.cancellation;
      let timedOut = false;
      const timeout = Number.isFinite(timeoutMs)
        ? setTimeout(() => { timedOut = true; cancellation.abort(new Error(timeoutReason)); }, timeoutMs)
        : undefined;
      this.board();
      let result: RunResult | undefined;
      let needsCompletionReview = false;
      let hintsChanged = false;
      const publishedCheckpoints = new Set<string>();
      let lastCheckpointSummary: string | undefined;
      try {
        const request: RunRequest = { id: runId, mode, snapshot, workspace: this.store.workspace, runDir, step: claimedStep, trigger, blackboardPath: this.store.projectionPath,
          wikiProjectionError: this.store.wikiProjectionError ?? undefined,
          signal: cancellation.signal, onEvent: runtime => this.emit({ type: "runtime", runtime }) };
        if (mode === "execute") request.onCheckpoint = (checkpointId, output, cumulativeUsage) => {
          cancellation.signal.throwIfAborted();
          const committed = this.store.applyExecutionCheckpoint(runId, checkpointId, output, cumulativeUsage);
          request.wikiProjectionError = this.store.wikiProjectionError ?? undefined;
          this.board();
          if (!publishedCheckpoints.has(checkpointId)) {
            publishedCheckpoints.add(checkpointId);
            lastCheckpointSummary = committed.reason;
            this.emit({ type: "result", result: { mode: "execute", summary: committed.reason, kind: "checkpoint", runId, checkpointId } });
          }
          return committed;
        };
        request.context = this.projectContext(request);
        if (mode !== "execute") {
          request.materialBaseline = this.store.materialReceipts();
          request.materials = planningMaterials(snapshot, request.materialBaseline, this.store.dataDir, this.store.workspace);
        }
        this.emit({ type: "handoff", handoff: { role: mode === "execute" ? "execute" : "decide", mode, runId, revision: snapshot.revision, stepId: claimedStep?.id, trigger } });
        if (request.materials && (request.materials.items.length || request.materials.deferredCount)) this.emit({ type: "materials", materials: request.materials });
        cancellation.signal.throwIfAborted();
        result = await this.runner.run(request);
        if (cancellation.signal.aborted) throw new Error(timedOut ? timeoutReason : this.interruptReason);
        hintsChanged = this.snapshot().hints.length !== snapshot.hints.length;
        let committed: BoardSnapshot;
        if (mode === "execute") committed = this.store.applyExecution(runId, result.output, result.usage);
        else {
          const decision = decisionSchema.parse(normalizeDecisionInput(result.output, snapshot).value);
          if (decision.updateSteps) {
            // Finished attempts are history, not pending work to clean up. Keep
            // valid planning operations without rewriting or replaying them.
            const statuses = new Map(snapshot.steps.map(step => [step.id, step.status]));
            decision.updateSteps = decision.updateSteps.filter(update => {
              const status = statuses.get(update.id);
              if (status && ["done", "no_progress", "blocked", "failed", "abandoned"].includes(status)) {
                this.notice(`Ignored Step ${update.id} ${update.action}: status is ${status}; history retained.`);
                return false;
              }
              if (status === "ready" && update.action === "abandon") statuses.set(update.id, "abandoned");
              return true; // Unknown IDs and claimed Steps still fail Store validation.
            });
          }
          if (decision.conclusion?.outcome === "NEED_INPUT") {
            // A planner can mistake the absent output of an unexecuted Step for
            // missing external input. Keep its plan, but do not let an unsupported
            // pause proposal bypass Execute or fail the whole run at commit.
            const reviewed = new Set(decision.reviews?.map(review => review.findingId));
            const unresolved = snapshot.findings.filter(finding => ["lead", "technical_hit"].includes(finding.status) && !reviewed.has(finding.id));
            if (!unresolved.length || unresolved.some(finding => !finding.next.trim())) {
              delete decision.conclusion;
              this.notice("NEED_INPUT lacks an unresolved lead/hit with a recorded input requirement; continuing planning.");
            }
          }
          const rootIds = new Set(snapshot.goals.filter(goal => goal.parentId === null).map(goal => goal.id));
          const completesRoot = decision.updateGoals?.some(goal => rootIds.has(goal.id));
          if ((decision.conclusion || completesRoot) && (mode !== "metacog" || hintsChanged)) {
            needsCompletionReview = true;
            delete decision.conclusion;
            if (decision.updateGoals) decision.updateGoals = decision.updateGoals.filter(goal => !rootIds.has(goal.id));
            this.notice(hintsChanged ? "New hint arrived during planning; conclusion deferred for a fresh review." : "Completion proposed; starting a fresh metacognitive review before concluding.");
          }
          committed = this.store.applyDecision(runId, decision, result.usage, request.materials ? { ...request.materials,
            items: [...new Map([...request.materials.items, ...request.materialReads ?? []].map(item => [item.key, item])).values()] } : undefined);
        }
        this.board();
        const repeatedCheckpoint = !committed.outcome && committed.reason === lastCheckpointSummary;
        this.emit({ type: "result", result: { mode, summary: result.yielded && publishedCheckpoints.size
          ? "阶段结果已保存。\n交给 Decide 继续规划；当前步骤尚未验证完成。"
          : repeatedCheckpoint ? "本轮执行已结束，阶段结果见上方。"
          : committed.reason, ...((result.yielded || repeatedCheckpoint) ? { kind: "transition" as const } : {}),
          ...(committed.outcome ? { outcome: committed.outcome } : {}) } });
      } catch (error) {
        const partial = usageSchema.safeParse(error && typeof error === "object" && "usage" in error ? error.usage : undefined);
        const completedUsage = usageSchema.safeParse(result?.usage);
        const usage: Usage = completedUsage.success ? completedUsage.data : partial.success ? partial.data : { input: 0, output: 0, cost: 0 };
        if (result && !completedUsage.success) this.notice("Runner returned invalid usage; this run's consumption is unknown and was not added to the estimated budget.");
        const reason = error instanceof Error ? error.message : String(error);
        this.store.failRun(runId, reason, usage, cancellation.signal.aborted);
        if (timedOut) this.store.setStatus("paused", `${timeoutReason}; inspect interrupted step state before resuming.`);
        this.board("state");
        return;
      } finally { if (timeout !== undefined) clearTimeout(timeout); this.cancellation = undefined; }

      const current = this.snapshot();
      if (current.status !== "running" || current.outcome) return;
      if (hintsChanged) { mode = "metacog"; trigger = { kind: "hint", reason: "A new Hint arrived; reassess the plan and Goal against the latest blackboard." }; continue; }
      if (needsCompletionReview) { mode = "metacog"; trigger = { kind: "completion", reason: "Independently check the whole Goal, evidence, pending work and blind spots before accepting completion." }; continue; }
      if (result?.yielded) {
        mode = "decide";
        trigger = { kind: "execution_result", reason: "Execute committed a partial checkpoint and returned control. Review new evidence and replan unfinished work; the Step success signal has not been fully verified." };
        continue;
      }
      if (mode === "execute") {
        const review = this.policy.reviewAfterExecution(snapshot, current, step!.id);
        mode = review ? "metacog" : "decide";
        trigger = review ?? { kind: "execution_result", reason: "A Step result was committed. Compare it with the Goal and choose the next useful action." };
      } else if (mode === "metacog") {
        const stale = new Set(pendingStepReviews(current).map(review => review.stepId));
        if (!current.steps.some(item => item.status === "ready" && !stale.has(item.id))) {
          this.store.setStatus("paused", current.steps.some(item => item.status === "ready" && stale.has(item.id))
            ? "Review left only Steps with superseded dependencies and no executable step. Recheck the replacement Facts, abandon stale plans and create a current plan before resuming."
            : "Review produced no executable step or evidence-backed conclusion. Add a hint and resume.");
          this.board("state"); return;
        }
        mode = "execute";
        trigger = { kind: "planned", reason: "Execute the next ready Step from the reviewed blackboard plan." };
      } else {
        const stale = new Set(pendingStepReviews(current).map(review => review.stepId));
        mode = current.steps.some(item => item.status === "ready" && !stale.has(item.id)) ? "execute" : "metacog";
        trigger = mode === "execute" ? { kind: "planned", reason: "Execute the next ready Step; report observations and evidence, not a task-level conclusion." }
          : current.steps.some(item => item.status === "ready" && stale.has(item.id))
            ? { kind: "fact_revision", reason: "All ready Steps depend on superseded Facts. Review their causal assumptions, abandon stale plans and create Steps supported by current conditions." }
            : { kind: "empty_plan", reason: "Planning produced no ready Step. Repair the plan or justify an evidence-backed conclusion." };
      }
    }
  }
}
