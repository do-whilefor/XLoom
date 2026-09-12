import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, LoopEvent, ProjectConfig, RunRequest, RunResult, Usage } from "../src/types.js";

const roots: string[] = [];
const stores: BlackboardStore[] = [];
const controllers: LoopController[] = [];
const standardUsage: Usage = { input: 10, output: 5, cost: 0.001 };
const result = (output: unknown, usage = standardUsage): RunResult => ({ output, usage });
const plan = (description = "Compare synthetic fixture identities"): Decision => ({
  summary: "Plan synthetic protocol exercise, not a live security test",
  steps: [{ goalId: "G0", from: [], description, successSignal: "Fixture artifact saved", evidencePlan: "Save synthetic response fixture", priority: 50 }],
});

function setup(handler: (request: RunRequest) => Promise<RunResult> | RunResult, limits: Partial<ProjectConfig["limits"]> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-controller-test-"));
  roots.push(root);
  const config = defaultConfig("Exercise local loop protocol with synthetic fixtures only");
  Object.assign(config.limits, limits);
  const store = new BlackboardStore(root, config);
  stores.push(store);
  const requests: RunRequest[] = [];
  const run = vi.fn(async (request: RunRequest) => { requests.push(request); return handler(request); });
  const controller = new LoopController(store, { run });
  controllers.push(controller);
  const events: LoopEvent[] = [];
  controller.subscribe((event) => { events.push(event); });
  return { root, store, controller, requests, run, events };
}

function fixtureExecution(request: RunRequest): Execution {
  writeFileSync(path.join(request.runDir, "artifacts", "fixture.txt"), "SYNTHETIC TEST FIXTURE ONLY\nidentity=A: expected allowed\nidentity=B: expected denied\n");
  return {
    summary: "Saved synthetic fixture for testing state transitions; not real target evidence",
    result: "done",
    evidence: [{ ref: "fixture-e", path: "fixture.txt", description: "Synthetic unit-test artifact" }],
    facts: [{ ref: "fixture-f", description: "Synthetic fixture contains expected allow/deny labels", evidenceRefs: ["fixture-e"] }],
    findings: [{ key: "synthetic-ownership", title: "Synthetic hypothesis", target: "local fixture", status: "lead", factRefs: ["fixture-f"], evidenceRefs: ["fixture-e"], next: "Close protocol-test hypothesis after synthetic review" }],
  };
}

function closure(request: RunRequest): Decision {
  return {
    summary: "Synthetic terminal-state validation, not a real vulnerability conclusion",
    reviews: [{ findingId: request.snapshot.findings[0]!.id, status: "closed", rating: "unrated", reason: "Fixture only: expected labels match; reopen this synthetic case when fixture expectations change" }],
    conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic protocol test completed; no live target was tested" },
  };
}

function abortable(request: RunRequest, usage: Usage = { input: 7, output: 2, cost: 0.0004 }): Promise<RunResult> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Mock provider interrupted"), { usage }));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith("xloom-controller-test-")) throw new Error("Unexpected test cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("LoopController synthetic protocol flow", () => {
  it("commits FGS/evidence and requires a fresh metacognitive run before a terminal state", async () => {
    const test = setup((request) => {
      request.onEvent({ type: "text", mode: request.mode, text: `PRIVATE-STREAM-${request.mode}` });
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "decide") return result({ summary: "Propose synthetic completion", conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic completion proposal" } });
      expect(request.snapshot.findings[0]!.status).toBe("lead");
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, noProgressCount: 0, usage: { input: 40, output: 20, cost: 0.004 } });
    expect(board.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(board.lastMetaStep).toBe(1);
    expect(readFileSync(path.resolve(test.root, board.evidence[0]!.path), "utf8")).toContain("SYNTHETIC TEST FIXTURE ONLY");
    expect(new Set(test.requests.map((r) => r.id)).size).toBe(4);
    expect(new Set(test.requests.map((r) => r.snapshot)).size).toBe(4);
    for (const request of test.requests) {
      expect(request).not.toHaveProperty("messages");
      expect(request).not.toHaveProperty("history");
      expect(JSON.stringify(request.snapshot)).not.toContain("PRIVATE-STREAM");
    }
    expect(test.requests[1]!.step?.status).toBe("claimed");
    expect(test.requests[2]!.snapshot.facts).toHaveLength(1);
    expect(test.events.some((e) => e.type === "runtime")).toBe(true);
    await test.controller.start();
    test.controller.stop();
    expect(test.run).toHaveBeenCalledTimes(4);
    expect(test.controller.snapshot().status).toBe("completed");
  });

  it("allows completion review at the exact Step budget without executing an extra step", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "metacog") return result(closure(request));
      return result({ summary: "Propose fixture conclusion", conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic only" } });
    }, { maxSteps: 1 });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1 });
    expect(test.requests.filter((r) => r.mode === "execute")).toHaveLength(1);
    expect(test.requests.at(-1)?.mode).toBe("metacog");
  });

  it("runs metacognition after repeated no-progress outputs then pauses without NEED_INPUT", async () => {
    const test = setup((request) => {
      if (request.mode === "decide") return result(plan(`Synthetic attempt ${request.snapshot.completedSteps + 1}`));
      if (request.mode === "execute") return result({ summary: "No synthetic state change", result: "done" });
      return result({ summary: "No new evidence; record stagnation and inspect plan" });
    }, { maxNoProgress: 2, metacogEvery: 9 });
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "execute", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, noProgressCount: 2, completedSteps: 2, lastMetaStep: 2 });
    expect(test.controller.snapshot().steps.every((step) => step.status === "no_progress")).toBe(true);
    expect(test.controller.snapshot().reason).toContain("No-progress");
  });

  it("reviews an empty plan once then pauses without inventing missing inputs", async () => {
    const test = setup(() => result({ summary: "No executable proposal" }));
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, findings: [] });
    expect(test.controller.snapshot().reason).toContain("no executable step");
  });

  it("uses the Decide metacog mode at the configured periodic boundary", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.mode === "metacog") return result(closure(request));
      return result(plan());
    }, { metacogEvery: 1 });
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "metacog"]);
    expect(test.controller.snapshot().status).toBe("completed");
  });
});

describe("LoopController interruption and fresh boundaries", () => {
  it("returns the same active promise during synchronous state-listener reentry", async () => {
    const test = setup(() => result({ summary: "Empty synthetic review" }));
    let reentered = false;
    let nested: Promise<void> | undefined;
    test.controller.subscribe((event) => {
      if (event.type === "state" && event.snapshot?.status === "running" && !reentered) {
        reentered = true;
        nested = test.controller.start();
      }
    });
    const active = test.controller.start();
    expect(nested).toBe(active);
    expect(test.controller.waitForIdle()).toBe(active);
    await active;
    expect(test.requests.map((request) => request.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot().status).toBe("paused");
    expect(test.store.events().filter((event) => event.kind === "status" && JSON.parse(event.payload).status === "running")).toHaveLength(1);
  });

  it("aborts a user-paused Execute, accounts partial usage and never blindly replays it", async () => {
    let markExecuting!: () => void;
    const executing = new Promise<void>((resolve) => { markExecuting = resolve; });
    const test = setup((request) => {
      if (request.mode === "execute") { markExecuting(); return abortable(request); }
      return result(request.snapshot.steps.length ? { summary: "Review failed step before creating another action" } : plan());
    });
    const active = test.controller.start();
    expect(test.controller.start()).toBe(active);
    await executing;
    test.controller.pause();
    await active;
    expect(test.requests[1]!.signal.aborted).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, usage: { input: 17, output: 7, cost: 0.0014 } });
    expect(test.controller.snapshot().steps[0]).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(test.store.runs().at(-1)?.status).toBe("cancelled");
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.controller.snapshot().steps[0]!.attempts).toBe(1);
  });

  it("pauses on a run timeout and preserves the provider's partial usage", async () => {
    const test = setup((request) => request.mode === "execute" ? abortable(request, { input: 23, output: 4, cost: 0.002 }) : result(plan()), { stepTimeoutSeconds: 0.03 });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, usage: { input: 33, output: 9, cost: 0.003 } });
    expect(test.controller.snapshot().reason).toContain("time limit");
    expect(test.controller.snapshot().steps[0]!.status).toBe("failed");
    expect(test.store.runs().at(-1)?.status).toBe("cancelled");
  });

  it("defers a conclusion when hints arrive during Decide and gives the next review a fresh snapshot", async () => {
    let controller!: LoopController;
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "decide") {
        controller.hint("New synthetic fixture expectation arrived during Decide");
        expect(request.snapshot.hints).toHaveLength(0);
        return result({ summary: "Propose fixture completion", conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic completion" } });
      }
      expect(request.snapshot.hints[0]!.content).toContain("New synthetic");
      return result(closure(request));
    });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.events.some((event) => event.message?.includes("New hint arrived"))).toBe(true);
    expect(controller.snapshot().status).toBe("completed");
  });

  it("repeats fresh metacognition when a hint invalidates an in-flight completion review", async () => {
    let controller!: LoopController;
    let reviews = 0;
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.mode === "decide") return result(plan());
      if (++reviews === 1) controller.hint("Fixture changed while metacognition was in flight");
      else expect(request.snapshot.hints).toHaveLength(1);
      return result(closure(request));
    }, { metacogEvery: 1 });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "metacog", "metacog"]);
    expect(controller.snapshot().status).toBe("completed");
  });

  it("starts an idle manual meta request on the Decide review channel", async () => {
    const test = setup(() => result({ summary: "Manual review, no actionable proposal" }));
    test.controller.requestMetacog();
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null });
  });

  it("queues a manual meta request until the current run's committed boundary", async () => {
    let controller!: LoopController;
    const test = setup((request) => {
      if (request.mode === "decide") { controller.requestMetacog(); return result(plan()); }
      if (request.mode === "execute") return result({ summary: "No fixture change", result: "no_progress" });
      return result({ summary: "Manual/threshold review" });
    }, { maxNoProgress: 1 });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "metacog", "execute", "metacog"]);
    expect(new Set(test.requests.map((r) => r.snapshot.revision)).size).toBe(4);
  });

  it("honors a queued manual meta review even when the Step budget blocks more execution", async () => {
    let controller!: LoopController;
    const test = setup((request) => {
      if (request.mode === "execute") return result({ summary: "No fixture change", result: "no_progress" });
      if (request.mode === "metacog") return result({ summary: "Review Step budget boundary" });
      if (request.snapshot.completedSteps) controller.requestMetacog();
      return result(plan(`Synthetic attempt ${request.snapshot.completedSteps + 1}`));
    }, { maxSteps: 1, maxNoProgress: 5, metacogEvery: 9 });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(controller.snapshot().reason).toContain("Step budget");
  });
});

describe("LoopController budgets and errors", () => {
  it.each(["decide", "execute"] as const)("cleans up malformed usage from %s without committing proposals and can resume in-process", async (invalidMode) => {
    let invalidSent = false;
    const invalidUsage = { input: 4, output: 1, cost: "unknown" } as unknown as Usage;
    const test = setup((request) => {
      if (invalidSent) return result({ summary: "Fresh review after the malformed provider result" });
      if (request.mode !== invalidMode) return result(plan());
      invalidSent = true;
      return result(request.mode === "execute" ? fixtureExecution(request) : plan("This proposal must not commit"), invalidUsage);
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "error", outcome: null, completedSteps: 0, facts: [], findings: [], evidence: [] });
    expect(board.usage).toEqual(invalidMode === "decide" ? { input: 0, output: 0, cost: 0 } : standardUsage);
    if (invalidMode === "decide") expect(board.steps).toEqual([]);
    else expect(board.steps[0]).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(test.store.runs().at(-1)?.status).toBe("failed");
    expect(test.store.runs().some((run) => run.status === "running")).toBe(false);
    expect(test.events.some((event) => event.type === "notice" && /usage/i.test(event.message ?? ""))).toBe(true);
    const beforeResume = test.requests.length;
    await test.controller.start();
    expect(test.requests.slice(beforeResume).map((request) => request.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, facts: [], findings: [], evidence: [] });
    expect(test.store.runs().some((run) => run.status === "running")).toBe(false);
  });

  it.each([
    [{ maxTokens: 15 }, "Token budget"],
    [{ maxCost: 0.001 }, "cost budget"],
  ] as const)("halts before another call when accumulated budget is exhausted (%j)", async (limits, reason) => {
    const test = setup(() => result(plan()), limits);
    await test.controller.start();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0 });
    expect(test.controller.snapshot().reason).toContain(reason);
    expect(test.controller.snapshot().steps[0]!.attempts).toBe(0);
  });

  it("enforces the remaining wall-time budget during an in-flight call", async () => {
    const test = setup((request) => abortable(request), { maxMinutes: 0.0005, stepTimeoutSeconds: 100 });
    await test.controller.start();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.requests[0]!.signal.aborted).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, usage: { input: 7, output: 2, cost: 0.0004 } });
  });

  it("records schema failures without leaking partial proposals or fabricating a result", async () => {
    const test = setup(() => result({ summary: "Invalid proposal", steps: [{ ...plan().steps![0], from: ["nonexistent-fact"] }] }));
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null, steps: [], usage: standardUsage });
    expect(test.store.runs()[0]!.status).toBe("failed");
    expect(test.run).toHaveBeenCalledOnce();
  });

  it("isolates renderer exceptions and lets unsubscribed listeners stay silent", async () => {
    const test = setup(() => result({ summary: "Empty synthetic review" }));
    const listener = vi.fn();
    test.controller.subscribe(() => { throw new Error("Broken renderer"); });
    const unsubscribe = test.controller.subscribe(listener);
    unsubscribe();
    await test.controller.start();
    expect(test.controller.snapshot().status).toBe("paused");
    expect(listener).not.toHaveBeenCalled();
  });
});
