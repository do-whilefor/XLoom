import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { evidencePath } from "../paths.js";
import type { BoardSnapshot } from "../types.js";
import { organizeWiki } from "./catalog.js";
import { wikiGenerator } from "./format.js";
import { renderWiki } from "./projection.js";

const fingerprint = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const inside = (root: string, file: string) => { const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/** Read-only full integrity audit. Hashing is streamed; reports never rewrite a source. */
export function auditWiki(board: BoardSnapshot, dataDir: string, workspace: string) {
  const issues: { code: string; path?: string; id?: string; detail?: string }[] = [];
  const observed = new Map<string, string>();
  const inspected = new Map<string, { sha256: string; bytes: number }>();
  function inspect(file: string, root: string) {
    if (!inside(realpathSync(root), realpathSync(file))) throw new Error("Path escaped its registered archive/projection directory");
    if (lstatSync(file).isSymbolicLink()) throw new Error("Registered file must not be a symlink");
    const cached = inspected.get(file);
    if (cached) return cached;
    const fd = openSync(file, "r");
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) throw new Error("Registered path must be a regular file");
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0, count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, count)); bytes += count; }
      const after = fstatSync(fd);
      if (fingerprint(before) !== fingerprint(after)) throw new Error("File changed during audit");
      observed.set(file, fingerprint(after));
      const result = { sha256: hash.digest("hex"), bytes }; inspected.set(file, result); return result;
    } finally { closeSync(fd); }
  }
  function directory(file: string) {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Projection directory must not be a symlink or a file");
    if (!observed.has(file)) observed.set(file, fingerprint(info));
  }
  const wiki = join(dataDir, "wiki");
  let checkedProjectionFiles = 0, checkedEvidence = 0;
  try {
    directory(wiki); directory(join(wiki, "pages"));
    for (const [path, body] of renderWiki(board, dataDir, workspace)) {
      const file = join(wiki, path);
      try {
        const actual = inspect(file, wiki); checkedProjectionFiles++;
        if (actual.sha256 !== createHash("sha256").update(body).digest("hex")) issues.push({ code: "projection_mismatch", path: file });
      } catch (error) { issues.push({ code: "projection_unavailable", path: file, detail: (error as Error).message }); }
    }
  } catch (error) { issues.push({ code: "projection_unavailable", path: wiki, detail: (error as Error).message }); }
  for (const evidence of board.evidence) {
    const file = evidencePath(evidence, dataDir, workspace);
    try {
      directory(join(dataDir, "evidence"));
      const actual = inspect(file, join(dataDir, "evidence")); checkedEvidence++;
      if (actual.sha256 !== evidence.sha256 || actual.bytes !== evidence.bytes) issues.push({ code: "evidence_mismatch", id: evidence.id, path: file });
    } catch (error) { issues.push({ code: "evidence_unavailable", id: evidence.id, path: file, detail: (error as Error).message }); }
  }
  for (const [file, before] of observed) {
    try { if (fingerprint(lstatSync(file)) !== before) issues.push({ code: "changed_during_audit", path: file }); }
    catch { issues.push({ code: "changed_during_audit", path: file }); }
  }
  const organization = organizeWiki(board);
  return { generator: wikiGenerator, type: "audit", evidence: false, boardRevision: board.revision,
    status: issues.length || organization.missingSources.length ? "unavailable" : organization.reviewRequired.length ? "review_required" : "consistent",
    notice: "Point-in-time file/reference consistency, not vulnerability validation. Files may change after this audit. No research state or author review baseline was changed.",
    checkedProjectionFiles, checkedEvidence, issues, organization };
}
