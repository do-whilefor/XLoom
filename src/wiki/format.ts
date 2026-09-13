import { createHash } from "node:crypto";

export const wikiMarker = "<!-- xloom generated wiki; SQLite and archived evidence are authoritative -->";
export const wikiGenerator = "xloom-wiki-v1";
export const wikiFilename = (kind: string, id: string) => `${kind}-${createHash("sha256").update(id).digest("hex")}.md`;

/** Recognizable derived copies only; this cannot detect deliberately rewritten prose. */
export function isWikiDerived(text: string): boolean {
  if (text.trimStart().startsWith(wikiMarker)) return true;
  try { return JSON.parse(text)?.generator === wikiGenerator; }
  catch { return false; }
}
