/** Presentation only: add breathing room to dense, unstructured prose.
 * Never rewrite words, classify results, or touch Markdown/code/quoted payloads. */
export function readableProse(text: string): string {
  if (/^\s*(?:`{3,}|~{3,})/m.test(text)) return text;
  return text.split(/(\n\s*\n)/).map(block => {
    // Inline parameter placeholders such as <name> are ordinary prose. Preserve
    // authored HTML/links/emphasis and code blocks, but protect inline code spans.
    if (block.length < 320 || block.includes("\n") || /[\[\]*]|<\/[a-z]|^\s|^<[a-z]|^(?:[-+>#]|\d+[.)])\s/i.test(block)) return block;
    const boundaries: number[] = [];
    let depth = 0, quote = "", ticks = 0, angle = false;
    for (let index = 0; index < block.length; index++) {
      const char = block[index]!;
      if (char === "`" && block[index - 1] !== "\\") {
        const count = /^`+/.exec(block.slice(index))![0].length;
        if (!ticks) ticks = count; else if (count === ticks) ticks = 0;
        index += count - 1; continue;
      }
      if (ticks) continue;
      if (quote) { if (char === quote && block[index - 1] !== "\\") quote = ""; continue; }
      if (char === '"' || char === "“" || char === "'" && (index === 0 || /[\s:(]/.test(block[index - 1]!))) { quote = char === "“" ? "”" : char; continue; }
      if (char === "<" && /[a-z!/]/i.test(block[index + 1] ?? "")) angle = true;
      if (angle) { if (char === ">") angle = false; continue; }
      if ("(（{".includes(char)) depth++;
      if (")）}".includes(char)) depth = Math.max(0, depth - 1);
      if (!depth && (/[;.!?]/.test(char) && /\s/.test(block[index + 1] ?? "") || /[。；！？]/.test(char))) boundaries.push(index + 1);
    }
    // Unfinished inline code/quotes are not safe formatting boundaries.
    if (ticks || quote || angle) return block;
    let start = 0;
    const paragraphs: string[] = [];
    for (const end of boundaries) {
      if (end - start < 100 || end === block.length) continue;
      paragraphs.push(block.slice(start, end).trim());
      start = end;
    }
    if (!paragraphs.length) return block;
    paragraphs.push(block.slice(start).trim());
    return paragraphs.filter(Boolean).join("\n\n");
  }).join("");
}
