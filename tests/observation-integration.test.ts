import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { LoopController } from "../src/controller.js";
import { createTaskReader } from "../src/wiki/read.js";
import { applyWikiPages, wikiIssues, wikiRecord } from "../src/wiki/model.js";
import { incrementalRetrievalIndex } from "../src/wiki/incremental.js";
import { renderReport } from "../src/report.js";
import { projectContext } from "../src/loop/context.js";
import { beginFixtureStep, zero } from "./fixtures/native-retrieval.js";
import type { AttemptProposal, Execution, RunRequest } from "../src/types.js";

const roots: string[] = [], stores: BlackboardStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-observation-")) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
const attempt = (patch: Partial<AttemptProposal> = {}): AttemptProposal => ({ hypothesis: "fixture-object", scope: "object-A", identity: "alice", stateVersion: "v1",
  baseline: "owner allowed", changedVariable: "requester", observation: "accepted", outcome: "supports", evidenceRefs: ["e"], ...patch });
function output(directory: string, patch: Partial<AttemptProposal> = {}, body = "accepted"): Execution {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "response.json"), JSON.stringify({ actor_ref: "alice", environment: "synthetic", session_generation: "1",
    request: { method: "GET", object: "object-A" }, response: { status: 200, body: { result: body } } }));
  return { summary: "Synthetic local observation", result: "done", evidence: [{ ref: "e", path: "response.json", description: "Synthetic original" }], attempts: [attempt(patch)] };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "xloom-observation-")); roots.push(root);
  const store = new BlackboardStore(root, defaultConfig("Inspect synthetic observations")); stores.push(store);
  const commit = (run: string, patch: Partial<AttemptProposal> = {}, body = "accepted", seed = false) => {
    beginFixtureStep(store, run);
    const data = output(join(store.dataDir, "runs", run, "artifacts"), patch, body);
    if (seed) {
      data.facts = [{ ref: "f", description: "Fixture result accepted under alice/v1", evidenceRefs: ["e"] }];
      data.findings = [{ key: "fixture-object", title: "Fixture boundary", target: "object-A", status: "technical_hit", factRefs: ["f"], evidenceRefs: ["e"], next: "Review fixture" }];
      data.wikiPages = [{ id: "WK-observation", title: "Fixture observations", blocks: [{ id: "B-result", title: "Boundary",
        text: "Recorded acceptance applies only to alice/v1; impact is not established.", sources: [{ kind: "fact", id: "f" }] }] }];
    }
    return store.applyExecution(run, data, zero);
  };
  const first = commit("first", {}, "accepted", true);
  store.beginRun("review", "decide");
  store.applyDecision("review", { summary: "Close synthetic hypothesis", reviews: [{ findingId: first.findings[0]!.id, status: "closed", rating: "unrated",
    reason: "Expected fixture behavior; reopen for a changed observation" }] }, zero);
  return { root, store, commit, first };
}

describe("observations through Store, Wiki and native RAG", () => {
  it("keeps old closed Findings needing review and their candidate sources outside the history tail", () => {
    const { root, store, commit } = setup(); const snapshot = commit("source-update", {}, "another acceptance");
    const pending = snapshot.findings[0]!, newSource = snapshot.evidence.at(-1)!;
    for (let i = 0; i < 20; i++) {
      snapshot.findings.push({ ...pending, id: `V-history-${i}`, observationReview: undefined });
      snapshot.evidence.push({ ...newSource, id: `E-history-${i}` });
    }
    const context = projectContext({ id: "review", mode: "metacog", snapshot, workspace: root, runDir: root, blackboardPath: store.projectionPath,
      signal: new AbortController().signal, onEvent() {} });
    expect(context.findings.find(item => item.id === pending.id)!.observationReview).toBeDefined();
    expect(context.evidence.map(item => item.id)).toContain(newSource.id);
    expect(context.findings.find(item => item.id === pending.id)!.evidenceIds).not.toContain(newSource.id);
  });
  it("preserves conflicting originals, marks a prior review stale, and retrieves both conditions and sources", () => {
    const { root, store, commit, first } = setup();
    const after = commit("contrary", { outcome: "refutes", observation: "denied" }, "denied");
    const finding = after.findings[0]!;
    expect(finding).toMatchObject({ status: "closed", rating: "unrated", observationReview: { kinds: ["new_observation", "observation_conflict"] } });
    expect(finding.evidenceIds).toEqual(first.findings[0]!.evidenceIds); // Candidate evidence is not silently relinked.
    expect(after.attempts).toHaveLength(2);
    expect(wikiIssues(after, after.wikiPages![0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "source_changed" }), expect.objectContaining({ reason: "source_review_required" })]));
    expect(renderReport(after)).toContain("Status/rating above are historical");
    const read = createTaskReader(root, { dataDir: store.dataDir, snapshot: () => store.snapshot() }) as (path: string) => any;
    const result = read(`xloom://record?kind=fact&id=${first.facts.at(-1)!.id}&budgetChars=64000`);
    expect(result.complete).toBe(true); expect(JSON.stringify(result)).toContain("observation_conflict");
    expect(result.records.filter((item: any) => item.ref.kind === "attempt")).toHaveLength(2);
    expect(result.records.filter((item: any) => item.ref.kind === "evidence")).toHaveLength(2);
    expect(JSON.stringify(result)).toContain("alice"); expect(JSON.stringify(result)).toContain("v1");
    const compared = read(`xloom://compare?left=${after.evidence[0]!.id}&right=${after.evidence[1]!.id}&fields=${encodeURIComponent('["response.body.result"]')}`);
    expect(compared).toMatchObject({ status: "ready", selectedFields: [{ equal: false, right: { value: "denied" } }] });
    expect(store.snapshot()).toEqual(after);
    const tiny = read(`xloom://record?kind=fact&id=${first.facts.at(-1)!.id}&budgetChars=1024`);
    expect(tiny.complete).toBe(false); expect(tiny.records).toEqual([]);
    // Re-authoring does not settle the mutually contrary declarations.
    const reauthored = structuredClone(after);
    applyWikiPages(reauthored, [{ id: "WK-observation", title: "Conflicting results", blocks: [{ id: "B-result", title: "Recheck",
      text: "Both results need experiment review", sources: [{ kind: "fact", id: first.facts.at(-1)!.id }] }] }], ref => ref, () => {});
    expect(wikiIssues(reauthored, reauthored.wikiPages![0]!).some(issue => issue.reason === "source_review_required")).toBe(true);
  });
  it("persists review requirements across restart and clears them only after an explicit verified-source review", () => {
    const { root, store, commit, first } = setup();
    const after = commit("source-update", {}, "another captured acceptance");
    expect(after.attempts).toHaveLength(1); expect(after.noProgressCount).toBe(1);
    expect(after.findings[0]!.observationReview?.kinds).toEqual(["source_changed"]);
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new BlackboardStore(root, after.config); stores.push(reopened);
    expect(reopened.snapshot().findings[0]!.observationReview).toEqual(after.findings[0]!.observationReview);
    reopened.setStatus("running", "Resume fixture review");
    reopened.beginRun("finish", "metacog"); const before = reopened.snapshot();
    const conclusion = { summary: "Synthetic completion", updateGoals: [{ id: "G0", status: "satisfied" as const, factIds: [first.facts.at(-1)!.id], reason: "Fixture reviewed" }],
      conclusion: { outcome: "NOT_REPRODUCED" as const, reason: "Synthetic task complete" } };
    expect(() => reopened.applyDecision("finish", conclusion, zero)).toThrow("fresh Finding review"); expect(reopened.snapshot()).toEqual(before);
    const done = reopened.applyDecision("finish", { ...conclusion, reviews: [{ findingId: after.findings[0]!.id, status: "closed", rating: "unrated",
      reason: "Reviewed both source captures; expected fixture behavior, reopen if conditions change" }] }, zero);
    expect(done.findings[0]!.observationReview).toBeUndefined(); expect(done.status).toBe("completed");
  });
  it("rejects a review with damaged newly associated evidence and rolls back all state", () => {
    const { store, commit } = setup(), after = commit("source-update", {}, "new source");
    writeFileSync(join(store.dataDir, after.evidence.at(-1)!.path), "tampered");
    store.beginRun("review-again", "decide"); const before = store.snapshot();
    expect(() => store.applyDecision("review-again", { summary: "Review", reviews: [{ findingId: after.findings[0]!.id,
      status: "closed", rating: "unrated", reason: "Attempt to clear without intact originals" }] }, zero)).toThrow("Evidence changed");
    expect(store.snapshot()).toEqual(before);
  });
  it("does not invalidate an unrelated Finding or turn a rewording into progress", () => {
    const { store, commit } = setup(); const before = store.snapshot();
    const unrelated = commit("other", { hypothesis: "other", scope: "object-B" }, "unrelated");
    expect(unrelated.findings).toEqual(before.findings);
    const reworded = commit("reworded", { observation: "Acceptance was observed" });
    expect(reworded.noProgressCount).toBe(1); expect(reworded.attempts!.map(item => item.observation)).toContain("Acceptance was observed");
    expect(reworded.findings[0]!.observationReview?.kinds).toEqual(["new_observation"]);
  });
  it("recomputes source relationships on in-place edits even with the same revision and warm cache", () => {
    const { root, store, first } = setup(); const snapshot = store.snapshot();
    incrementalRetrievalIndex(snapshot, store.dataDir, root);
    expect(incrementalRetrievalIndex(snapshot, store.dataDir, root).stats.indexedBytes).toBe(0);
    snapshot.facts.push({ ...first.facts.at(-1)!, id: "F-replacement", description: "Correction does not establish impact", supersedes: first.facts.at(-1)!.id });
    const updated = incrementalRetrievalIndex(snapshot, store.dataDir, root);
    expect(updated.stats.updated).toBeGreaterThan(0);
    expect(JSON.stringify(wikiRecord(snapshot, { kind: "fact", id: first.facts.at(-1)!.id }))).toContain("F-replacement");
    expect(updated.index.documents.find(doc => doc.ref.kind === "block")!.issues.some(issue => issue.code === "source_changed")).toBe(true);
    const unchanged = incrementalRetrievalIndex(snapshot, store.dataDir, root);
    expect(unchanged.stats).toMatchObject({ added: 0, updated: 0, indexedBytes: 0 });
  });
});

describe("observation scheduling in the existing two-role controller", () => {
  it.each([false, true])("reviews committed conflicting observations at the next boundary (checkpoint yield=%s)", async yielded => {
    const { root, store } = setup(); const requests: RunRequest[] = [];
    const controller = new LoopController(store, { async run(request) {
      requests.push(request);
      if (requests.length === 1) return { output: { summary: "New fixture sample", steps: [{ goalId: "G0", from: [], description: "Capture contrary sample",
        successSignal: "Saved result", evidencePlan: "Local original", priority: 1 }] }, usage: zero };
      if (request.mode === "execute") {
        const data = output(join(request.runDir, "artifacts"), { outcome: "refutes", observation: "denied" }, "denied");
        if (yielded) {
          await request.onCheckpoint!("contrary", data, zero);
          return { output: { summary: "Committed partial result", result: "no_progress" }, yielded: true, usage: zero };
        }
        return { output: data, usage: zero };
      }
      expect(request.mode).toBe("metacog"); expect(request.trigger?.kind).toBe("observation_change");
      expect(request.trigger?.reason).toContain("observation_conflict");
      expect(request.context!.findings[0]!.observationReview).toBeDefined();
      controller.pause(); return { output: { summary: "Pause local fixture after observing handoff" }, usage: zero };
    } });
    await controller.start();
    expect(requests.map(request => request.mode)).toEqual(["decide", "execute", "metacog"]);
    expect(store.snapshot().attempts).toHaveLength(2); expect(store.snapshot().findings[0]!.observationReview).toBeDefined();
    expect(readFileSync(store.projectionPath, "utf8")).toContain("observation_conflict");
    expect(root).toBeDefined();
  });
});
