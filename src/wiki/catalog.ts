import type { BoardSnapshot } from "../types.js";
import { wikiDigest, wikiIssues, wikiRecord, type WikiSource } from "./model.js";
import { wikiFilename, wikiGenerator } from "./format.js";

export interface RetrievalRef { kind: WikiSource["kind"] | "block"; id: string; pageId?: string }
export const refKey = (ref: RetrievalRef): string => JSON.stringify([ref.kind, ref.pageId ?? "", ref.id]);
export interface RetrievalDocument {
  ref: RetrievalRef;
  title: string;
  text: string;
  path: string;
  sources: WikiSource[];
  issues: { code: string; source: WikiSource }[];
}
export interface RetrievalIndex {
  generator: typeof wikiGenerator;
  type: "retrieval_index";
  version: 1;
  evidence: false;
  boardRevision: number;
  signature: string;
  documents: RetrievalDocument[];
  lengths: number[];
  postings: Record<string, [number, number][]>;
}

/** Unicode width, identifier components and Chinese bigrams; no embedding/model call. */
export function terms(text: string): string[] {
  const found: string[] = [];
  for (const match of text.normalize("NFKC").matchAll(/[a-z0-9_]+(?:[-/.][a-z0-9_]+)*|[\u3400-\u9fff]+/gi)) {
    const original = match[0], token = original.toLowerCase();
    if (/^[\u3400-\u9fff]/.test(token)) {
      if (token.length === 1) found.push(token);
      else for (let i = 0; i < token.length - 1; i++) found.push(token.slice(i, i + 2));
    } else {
      found.push(token);
      if (/[-/._]/.test(token)) found.push(...token.match(/[a-z0-9]+/g) ?? []);
      const components = original.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
      if (components.length > 1) found.push(...components.flatMap(part => part.toLowerCase().match(/[a-z0-9]+/g) ?? []));
    }
  }
  return found;
}

const metadata = new Set(["id", "key", "stepId", "goalId", "parentId", "path", "pathBase", "sha256", "bytes", "status", "rating", "evidenceIds", "factIds", "from", "requires", "counterEvidence", "supersedes", "replacedBy", "attempts"]);
function searchable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(searchable).join(" ");
  if (value && typeof value === "object") return Object.entries(value).filter(([key]) => !metadata.has(key)).map(([, item]) => searchable(item)).join(" ");
  return "";
}

/** Only explicit public state is projected. Author history and raw files are read on demand. */
export function buildRetrievalIndex(board: BoardSnapshot): RetrievalIndex {
  const documents: RetrievalDocument[] = [], fields: { title: string; body: string }[] = [];
  const collections = { goal: board.goals, step: board.steps, fact: board.facts, finding: board.findings, evidence: board.evidence, attempt: board.attempts ?? [] };
  for (const kind of Object.keys(collections) as WikiSource["kind"][]) for (const item of collections[kind]) {
    const ref = { kind, id: item.id }, record = wikiRecord(board, ref)!;
    const title = "title" in item ? String(item.title) : "description" in item ? String(item.description) : "hypothesis" in item ? String(item.hypothesis) : ref.id;
    const sources = [...record.dependencies];
    if ("goalId" in item) sources.push({ kind: "goal", id: item.goalId });
    if ("parentId" in item && item.parentId) sources.push({ kind: "goal", id: item.parentId });
    if ("stepId" in item && item.stepId) sources.push({ kind: "step", id: item.stepId });
    const unique = [...new Map(sources.map(source => [refKey(source), source])).values()];
    documents.push({ ref, title, text: JSON.stringify(record.value), path: `pages/${wikiFilename(kind, item.id)}`, sources: unique,
      issues: unique.filter(source => !wikiRecord(board, source)).map(source => ({ code: "source_missing", source })) });
    fields.push({ title, body: searchable(record.value) });
  }
  for (const page of board.wikiPages ?? []) {
    const issues = wikiIssues(board, page);
    for (const block of page.blocks) {
      const sources = block.sources.map(({ kind, id }) => ({ kind, id }));
      documents.push({ ref: { kind: "block", pageId: page.id, id: block.id }, title: `${page.title} / ${block.title}`, text: block.text,
        path: `pages/${wikiFilename("note", page.id)}`, sources,
        issues: [
          ...issues.filter(issue => issue.blockId === block.id).map(issue => ({ code: issue.reason, source: { kind: issue.kind, id: issue.id } })),
          ...sources.filter(source => !wikiRecord(board, source)).map(source => ({ code: "source_missing", source })),
        ] });
      fields.push({ title: `${page.title} ${block.title}`, body: block.text });
    }
  }
  const postings: RetrievalIndex["postings"] = Object.create(null), lengths: number[] = [];
  fields.forEach((field, index) => {
    const counts = new Map<string, number>();
    for (const [text, weight] of [[field.title, 3], [field.body, 1]] as const) for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + weight);
    lengths.push([...counts.values()].reduce((sum, value) => sum + value, 0));
    for (const [term, count] of counts) (postings[term] ??= []).push([index, count]);
  });
  return { generator: wikiGenerator, type: "retrieval_index", version: 1, evidence: false, boardRevision: board.revision,
    signature: wikiDigest(documents), documents, lengths, postings };
}

/** Organization is a reference view, never a merge, deletion or author acknowledgement. */
export function organizeWiki(board: BoardSnapshot, index = buildRetrievalIndex(board)) {
  const blocks = index.documents.filter(doc => doc.ref.kind === "block");
  const duplicateGroups = new Map<string, RetrievalRef[]>();
  for (const block of blocks) {
    // Exact full judgments only: negation, conditions and whitespace are preserved.
    const signature = wikiDigest(block.text);
    const group = duplicateGroups.get(signature) ?? [];
    group.push(block.ref); duplicateGroups.set(signature, group);
  }
  const usedEvidence = new Set(index.documents.flatMap(doc => doc.sources.filter(ref => ref.kind === "evidence").map(ref => ref.id)));
  return { generator: wikiGenerator, type: "organization", evidence: false, boardRevision: board.revision,
    notice: "Derived navigation and review suggestions, not evidence or a verdict. Source equality does not verify original files. No records were merged, deleted or marked reviewed.",
    counts: { records: index.documents.length - blocks.length, pages: board.wikiPages?.length ?? 0, blocks: blocks.length },
    reviewRequired: blocks.filter(doc => doc.issues.length).map(doc => ({ ref: doc.ref, path: doc.path, issues: doc.issues })),
    missingSources: index.documents.flatMap(doc => doc.issues.filter(issue => issue.code === "source_missing").map(issue => ({ ref: doc.ref, source: issue.source }))),
    supersededFacts: board.facts.filter(fact => board.facts.some(other => other.supersedes === fact.id)).map(fact => ({ id: fact.id,
      replacedBy: board.facts.filter(other => other.supersedes === fact.id).map(other => other.id) })),
    duplicateText: [...duplicateGroups.values()].filter(group => group.length > 1).map(refs => ({ refs, action: "Review source and condition differences; identical text does not establish identical applicability." })),
    unreferencedEvidenceIds: board.evidence.filter(item => !usedEvidence.has(item.id)).map(item => item.id),
    topics: board.wikiPages?.map(page => ({ id: page.id, title: page.title, path: `pages/${wikiFilename("note", page.id)}`,
      blocks: page.blocks.map(block => ({ id: block.id, title: block.title, sources: block.sources.map(({ kind, id }) => ({ kind, id })) })) })) ?? [],
  };
}
