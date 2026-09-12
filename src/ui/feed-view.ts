import chalk from "chalk";
import { Markdown, truncateToWidth, visibleWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { compact, EventFeed, fitLines, plainText, type FeedEntry } from "./model.js";

const coral = chalk.hex("#D98B73");
const muted = chalk.gray;
const MAX_DETAIL_CHARS = 6000;
const MAX_DETAIL_LINES = 40;
const theme: MarkdownTheme = {
  heading: text => chalk.bold(text), link: text => chalk.cyan(text), linkUrl: muted,
  code: text => coral(text), codeBlock: text => text, codeBlockBorder: muted,
  quote: muted, quoteBorder: muted, hr: muted, listBullet: coral,
  bold: text => chalk.bold(text), italic: text => chalk.italic(text),
  strikethrough: text => chalk.strikethrough(text), underline: text => chalk.underline(text),
  codeBlockIndent: "  ",
};

/** Markdown may generate OSC links; the feed permits only renderer-owned SGR styling. */
function safeStyledLine(line: string): string {
  return line.split(/(\x1b\[[0-9;]*m)/g).map(part => /^\x1b\[[0-9;]*m$/.test(part) ? part : plainText(part)).join("");
}

function boundedDetails(values: (string | undefined)[], width: number): string[] {
  const source = values.filter(value => Boolean(value?.trim())).map(value => plainText(value!)).join("\n\n");
  if (!source) return [];
  const clipped = source.slice(0, MAX_DETAIL_CHARS);
  const lines = fitLines(clipped, width);
  const truncated = clipped.length < source.length || lines.length > MAX_DETAIL_LINES;
  return [...lines.slice(0, MAX_DETAIL_LINES), ...(truncated ? ["… 详情已截断"] : [])];
}

/** Avoid table column redistribution reducing a CJK cell to one terminal column. */
function narrowTable(text: string, width: number): boolean {
  let columns: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("|")) { columns = []; continue; }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
    if (cells.length < 2) { columns = []; continue; }
    for (const [index, cell] of cells.entries()) {
      const longestWord = Math.max(1, ...cell.trim().split(/\s+/).map(word => Math.min(30, visibleWidth(word))));
      columns[index] = Math.max(columns[index] ?? 1, longestWord);
    }
    if (columns.reduce((total, value) => total + value, 0) + 3 * columns.length + 1 > width) return true;
  }
  return false;
}

/** Compact presentation only. Neither this renderer nor its detail toggle changes Agent context. */
export class FeedView implements Component {
  detailsVisible = false;
  private markdown = new WeakMap<FeedEntry, { text: string; component: Markdown }>();
  constructor(private readonly feed: EventFeed) {}
  invalidate(): void { this.markdown = new WeakMap(); }
  toggleDetails(): boolean { this.detailsVisible = !this.detailsVisible; return this.detailsVisible; }

  private body(entry: FeedEntry, width: number, user: boolean): string[] {
    const text = plainText(entry.text);
    // Deep lists/quotes can also reduce Pi's inner wrapping width to one cell.
    const deepLayout = text.split("\n").some(line => {
      const prefix = /^(\s*(?:>\s*)*(?:\d+[.)]\s+)?)/.exec(line)?.[1] ?? "";
      return prefix.length > width - 8;
    });
    if (user || width < 24 || deepLayout || narrowTable(text, width)) return fitLines(text, width);
    let cached = this.markdown.get(entry);
    if (!cached) {
      cached = { text, component: new Markdown(text, 0, 0, theme, undefined, { renderLatex: false }) };
      this.markdown.set(entry, cached);
    } else if (cached.text !== text) { cached.text = text; cached.component.setText(text); }
    try { return cached.component.render(width).map(safeStyledLine); }
    catch { return fitLines(text, width); }
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    const margin = width >= 8 ? "  " : "";
    const prefixWidth = width >= 4 ? 2 : 0;
    const available = Math.max(1, width - margin.length - prefixWidth);
    const rows: string[] = [];
    const line = (text: string): void => { rows.push(truncateToWidth(text, width, width > 3 ? "…" : "")); };
    const detail = (values: (string | undefined)[]): void => {
      for (const text of boundedDetails(values, available)) line(margin + " ".repeat(prefixWidth) + muted(text));
    };
    for (const entry of this.feed.entries) {
      const label = compact(entry.label, 100);
      const kind = entry.kind ?? (entry.key?.startsWith("tool:") ? "tool" : /^(?:You|Assistant|Decide|Execute)(?:\b|\s)/.test(label) ? "message" : "notice");
      if (kind === "protocol") {
        if (this.detailsVisible) detail([entry.text, entry.details, entry.output]);
        continue;
      }
      if (kind === "activity") {
        if (rows.length && plainText(rows.at(-1) ?? "").trim()) rows.push("");
        line(margin + coral("● ") + muted(`${label}${entry.text ? ` · ${compact(entry.text, 240)}` : ""}`));
        if (this.detailsVisible) detail([entry.details, entry.output]);
      } else if (kind === "tool") {
        const state = entry.error ? "error" : entry.state ?? "running";
        const color = state === "error" ? chalk.red : state === "done" ? chalk.green : coral;
        const icon = state === "error" ? "✕" : state === "done" ? "✓" : "●";
        line(margin + color(`${icon} ${label}`) + (entry.text ? ` ${muted(compact(entry.text, 240))}` : ""));
        if (state === "error" && entry.output && !this.detailsVisible) line(margin + " ".repeat(prefixWidth) + chalk.red(compact(entry.output, 180)));
        if (this.detailsVisible) detail([entry.details, entry.output]);
      } else if (kind === "notice") {
        const summary = compact(entry.text, 500);
        line(margin + (entry.error ? chalk.red : muted)(summary));
        const fullTextNeeded = plainText(entry.text) !== summary || visibleWidth(summary) > width - margin.length;
        if (this.detailsVisible) detail([fullTextNeeded ? entry.text : undefined, entry.details, entry.output]);
      } else {
        const user = /^You(?:\b|\s)/.test(label);
        const prefix = prefixWidth ? (entry.error ? chalk.red : user ? coral : chalk.white)(user ? "❯ " : "● ") : "";
        if (rows.length && plainText(rows.at(-1) ?? "").trim()) rows.push("");
        const body = this.body(entry, available, user);
        for (const [index, text] of (body.length ? body : [""]).entries()) line(margin + (index === 0 ? prefix : " ".repeat(prefixWidth)) + (entry.error ? chalk.red(text) : text));
        if (this.detailsVisible) detail([entry.details, entry.output]);
      }
    }
    return rows.length ? rows : [""];
  }
}
