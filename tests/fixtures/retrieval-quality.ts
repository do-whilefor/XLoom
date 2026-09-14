import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.js";
import type { BoardSnapshot } from "../../src/types.js";
import { wikiBasis } from "../../src/wiki/model.js";
import { retrieveWiki } from "../../src/wiki/retrieval.js";
import { searchOriginals, readOriginal } from "../../src/wiki/originals.js";

export interface QualityGroup { id: string; alternatives: string[] }
export interface QualityCase {
  id: string; split: "development" | "acceptance"; mode: "wiki" | "originals";
  query: string; expected: string[]; requiredRefs?: string[]; retainedText?: string[];
  groups?: QualityGroup[];
}

/** Fixed synthetic cases, authored before ranking changes. Separate topic families
 * are reported independently; neither partition is a real-world accuracy claim. */
export function retrievalQualityFixture(root: string) {
  mkdirSync(join(root, "evidence"), { recursive: true });
  const board: BoardSnapshot = { revision: 1, config: defaultConfig("Synthetic retrieval quality"), status: "paused", outcome: null, reason: "Fixture",
    goals: [{ id: "G0", parentId: null, description: "Synthetic retrieval quality", status: "active", factIds: [] }],
    facts: [], evidence: [], steps: [{ id: "S-quality", goalId: "G0", from: [], description: "Record synthetic corpus", successSignal: "Fixture saved", evidencePlan: "Local files", priority: 1, status: "done", attempts: 1, runId: null, leaseUntil: null }], findings: [], wikiPages: [], hints: [], usage: { input: 0, output: 0, cost: 0 },
    completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 1 };
  const cases: QualityCase[] = [];
  const source = (id: string, description: string, body: string, supersedes?: string) => {
    const path = `evidence/${id}.txt`; writeFileSync(join(root, path), body);
    board.evidence.push({ id: `E-${id}`, path, pathBase: "task", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), description: "Synthetic archive", runId: "fixture", stepId: "S-quality" });
    board.facts.push({ id: `F-${id}`, stepId: null, description, evidenceIds: [`E-${id}`], ...(supersedes ? { supersedes } : {}) });
  };
  for (const [split, tag, label, grant, grantAliases, handle, handleAliases] of [
    ["development", "export", "报表下载", "downloadGrant", ["exportPermit", "reportTicket"], "objectHandle", ["reportKey", "resultRef"]],
    ["acceptance", "attachment", "附件读取", "attachmentLease", ["fetchVoucher", "blobPass"], "resourcePointer", ["attachmentKey", "assetRef"]],
  ] as const) {
    const conditions = `${label}仅限 alice/v1；bob/v2 不适用。最终内容 NOT verified。`;
    source(`${tag}-grant`, `${grant} ${conditions}`, `SYNTHETIC ${grant}=LOCAL_ONLY; ${conditions}`);
    source(`${tag}-handle`, `${handleAliases[0]} ${conditions}`, "unrelated padding\n".repeat(5000) + `SYNTHETIC ${handleAliases[0]}=LOCAL_OBJECT; ${conditions}`);
    source(`${tag}-old`, `${label}旧判断：可以使用旧授权。`, `SYNTHETIC old ${tag} claim; alice/v1 only.`);
    source(`${tag}-correction`, `${label}更正：旧授权已撤销，必须重新核对。`, `SYNTHETIC ${tag} correction: REVOKED; bob/v2 denied.`, `F-${tag}-old`);
    const sources = [{ kind: "fact" as const, id: `F-${tag}-old` }];
    board.wikiPages!.push({ id: `WK-${tag}`, title: `${label}条件与反证`, aliases: [`${tag}BoundaryNote`], questions: [`${label}为什么不能直接继续？`],
      revision: 1, boardRevision: 1, history: [], blocks: [{ id: "B-limit", title: "适用边界", text: conditions, sources, basis: wikiBasis(board, sources) }] });
    // Many superficially relevant records for the first need must not hide the second.
    for (let i = 0; i < 7; i++) source(`${tag}-noise-${i}`, `${grant} ${grantAliases.join(" ")} ${tag} catalogue ${i}; NOT an observed input.`,
      `SYNTHETIC ${grant} ${grantAliases.join(" ")} catalogue ${i}; NOT an observed input.`);
    const groups = [{ id: "need:0", alternatives: [grant, ...grantAliases] }, { id: "need:1", alternatives: [handle, ...handleAliases] }];
    const query = groups.flatMap(group => group.alternatives).join(" ");
    cases.push(
      { id: `${tag}-id`, split, mode: "wiki", query: `F-${tag}-grant`, expected: [`F-${tag}-grant`], requiredRefs: [`E-${tag}-grant`], retainedText: ["NOT verified", "bob/v2"] },
      { id: `${tag}-alias`, split, mode: "wiki", query: `${tag}BoundaryNote`, expected: [`WK-${tag}/B-limit`], requiredRefs: [`F-${tag}-old`, `F-${tag}-correction`, `E-${tag}-correction`], retainedText: ["NOT verified", "撤销"] },
      { id: `${tag}-chinese`, split, mode: "wiki", query: label, expected: [`WK-${tag}/B-limit`], retainedText: ["bob/v2"] },
      { id: `${tag}-correction`, split, mode: "wiki", query: `F-${tag}-old`, expected: [`F-${tag}-old`], requiredRefs: [`F-${tag}-correction`, `E-${tag}-correction`], retainedText: ["撤销"] },
      { id: `${tag}-no-match`, split, mode: "wiki", query: `unrecordedZ9${tag}`, expected: [] },
      { id: `${tag}-multi-wiki`, split, mode: "wiki", query, groups, expected: [`F-${tag}-handle`] },
      { id: `${tag}-multi-original`, split, mode: "originals", query, groups, expected: [`E-${tag}-handle`] },
      { id: `${tag}-deep`, split, mode: "originals", query: handleAliases[0], expected: [`E-${tag}-handle`], retainedText: ["NOT verified", "bob/v2"] },
      { id: `${tag}-negative`, split, mode: "originals", query: `${tag} REVOKED`, expected: [`E-${tag}-correction`], retainedText: ["REVOKED"] },
      { id: `${tag}-original-absent`, split, mode: "originals", query: `unrecordedZ9${tag}`, expected: [] },
    );
  }
  return { board, cases };
}

const refId = (ref: { id: string; pageId?: string }) => ref.pageId ? `${ref.pageId}/${ref.id}` : ref.id;
export function evaluateRetrievalQuality(root: string) {
  const { board, cases } = retrievalQualityFixture(root), before = JSON.stringify(board);
  const rows = cases.map(item => {
    const start = performance.now();
    let ids: string[], sourceIds: string[] = [], text: string, chars: number, locatorsValid = true;
    if (item.mode === "wiki") {
      // Extra options are ignored by the pre-optimization API, giving the same
      // frozen cases a reproducible baseline without maintaining a second ranker.
      const options = { limit: 5, budgetChars: 64000, queryGroups: item.groups };
      const result = retrieveWiki(board, root, root, item.query, options);
      ids = result.hits.map(hit => refId(hit.ref)); sourceIds = result.records.map(record => refId((record as { ref: { id: string; pageId?: string } }).ref));
      text = JSON.stringify(result.records); chars = JSON.stringify(result).length;
    } else {
      const search: (board: BoardSnapshot, dataDir: string, workspace: string, query: string, limit?: number, refresh?: boolean, groups?: QualityGroup[]) => ReturnType<typeof searchOriginals> = searchOriginals;
      const result = search(board, root, root, item.query, 5, false, item.groups);
      ids = [...new Set(result.hits.map(hit => hit.locator.evidenceId))];
      text = result.hits.map(hit => hit.snippet).join("\n"); chars = JSON.stringify(result).length;
      for (const hit of result.hits) {
        const read = readOriginal(board, root, root, hit.locator), evidence = board.evidence.find(row => row.id === hit.locator.evidenceId)!;
        const bytes = readFileSync(join(root, evidence.path)).subarray(hit.locator.byteOffset, hit.locator.byteOffset + hit.locator.byteLength);
        locatorsValid &&= read.text === hit.snippet && read.text === bytes.toString("utf8") && read.integrity === "verified";
      }
    }
    return { id: item.id, split: item.split, mode: item.mode, top5: ids, expected: item.expected,
      recalled: item.expected.filter(id => ids.includes(id)).length, absentCorrect: item.expected.length ? null : ids.length === 0,
      sourcesComplete: (item.requiredRefs ?? []).every(id => sourceIds.includes(id)),
      conditionsRetained: (item.retainedText ?? []).every(value => text.includes(value)), locatorsValid, chars, elapsedMs: +(performance.now() - start).toFixed(2) };
  });
  const splits = (["development", "acceptance"] as const).map(split => {
    const selected = rows.filter(row => row.split === split), expected = selected.reduce((n, row) => n + row.expected.length, 0);
    return { split, cases: selected.length, recallAt5: selected.reduce((n, row) => n + row.recalled, 0) / expected,
      absentQueriesCorrect: selected.filter(row => row.absentCorrect !== null).every(row => row.absentCorrect),
      sourceAndConditionChecks: selected.every(row => row.sourcesComplete && row.conditionsRetained),
      locatorsValid: selected.every(row => row.locatorsValid), deliveredChars: selected.reduce((n, row) => n + row.chars, 0) };
  });
  return { scope: "20 fixed synthetic queries; two topic partitions. Retrieval relevance and delivery checks, not answer accuracy or real-world vulnerability recall.",
    unchangedBoard: before === JSON.stringify(board), splits, rows };
}
