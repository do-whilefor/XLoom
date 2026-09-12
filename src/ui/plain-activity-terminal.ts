import type { Terminal } from "@earendil-works/pi-tui";

const MAX_OSC_LENGTH = 1024;
const INTERNAL_ACTIVITY_URL = /^xloom-thinking:\d+$/;

/** Keep Pi's click targets in its layout, without asking the terminal to style them as links. */
export class ActivityLinkFilter {
  private state: "text" | "escape" | "osc" | "string" = "text";
  private pending = "";
  private stringEscape = false;
  private stringAllowsBell = false;
  private internalLink = false;
  private externalLink = false;

  write(data: string): string {
    let output = "";
    for (const char of data) {
      if (this.state === "text") {
        if (char === "\x1b") { this.state = "escape"; this.pending = char; }
        else output += char;
      } else if (this.state === "escape") {
        if (char === "]") { this.state = "osc"; this.pending += char; }
        else {
          output += this.pending;
          this.pending = "";
          if (char === "\x1b") this.pending = char;
          else {
            output += char;
            // DCS, SOS, PM and APC payloads are opaque, including embedded OSC-looking text.
            this.state = "PX^_".includes(char) ? "string" : "text";
            this.stringAllowsBell = false;
            this.stringEscape = false;
          }
        }
      } else if (this.state === "string") {
        output += char;
        if ((this.stringAllowsBell && char === "\x07") || (this.stringEscape && char === "\\")) this.state = "text";
        this.stringEscape = char === "\x1b";
      } else {
        this.pending += char;
        const terminatorLength = char === "\x07" ? 1 : this.pending.endsWith("\x1b\\") ? 2 : 0;
        if (terminatorLength) {
          const body = this.pending.slice(2, -terminatorLength);
          const link = /^8;[^;]*;([\s\S]*)$/.exec(body);
          let omit = false;
          if (link) {
            const url = link[1];
            const internal = INTERNAL_ACTIVITY_URL.test(url);
            // OSC 8 opens replace the previous link. A hidden internal open must still
            // end a preceding visible external link, or its styling leaks into the body.
            if (internal && this.externalLink) output += `\x1b]8;;${this.pending.slice(-terminatorLength)}`;
            omit = internal || (url === "" && this.internalLink);
            this.internalLink = internal;
            this.externalLink = !internal && url !== "";
          }
          if (!omit) output += this.pending;
          this.pending = "";
          this.state = "text";
        } else if (this.pending.length >= MAX_OSC_LENGTH) {
          // Long unrelated OSC payloads (e.g. images/clipboard) never accumulate unboundedly.
          output += this.pending;
          if (this.pending.startsWith("\x1b]8;")) { this.internalLink = false; this.externalLink = true; }
          this.stringEscape = char === "\x1b";
          this.stringAllowsBell = true;
          this.pending = "";
          this.state = "string";
        }
      }
    }
    return output;
  }

  /** Preserve an incomplete unrelated sequence when the terminal session ends. */
  finish(): string {
    const pending = this.pending;
    this.pending = "";
    this.state = "text";
    this.internalLink = false;
    this.externalLink = false;
    return pending;
  }
}

/** Public Terminal adapter; input, geometry and terminal lifecycle still belong to Pi. */
export class PlainActivityTerminal implements Terminal {
  private readonly filter = new ActivityLinkFilter();
  constructor(private readonly terminal: Terminal) {}
  get columns(): number { return this.terminal.columns; }
  get rows(): number { return this.terminal.rows; }
  get kittyProtocolActive(): boolean { return this.terminal.kittyProtocolActive; }
  start(onInput: (data: string) => void, onResize: () => void): void { this.terminal.start(onInput, onResize); }
  stop(): void {
    const pending = this.filter.finish();
    if (pending) this.terminal.write(pending);
    this.terminal.stop();
  }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.terminal.drainInput(maxMs, idleMs); }
  write(data: string): void {
    const output = this.filter.write(data);
    if (output) this.terminal.write(output);
  }
  moveBy(lines: number): void { this.terminal.moveBy(lines); }
  hideCursor(): void { this.terminal.hideCursor(); }
  showCursor(): void { this.terminal.showCursor(); }
  clearLine(): void { this.terminal.clearLine(); }
  clearFromCursor(): void { this.terminal.clearFromCursor(); }
  clearScreen(): void { this.terminal.clearScreen(); }
  setTitle(title: string): void { this.terminal.setTitle(title); }
  setProgress(active: boolean): void { this.terminal.setProgress(active); }
}
