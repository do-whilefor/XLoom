import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
import { ActivityLinkFilter, PlainActivityTerminal } from "../src/ui/plain-activity-terminal.js";

const ST = "\x1b\\";
const close = (end = ST): string => `\x1b]8;;${end}`;
const open = (url = "xloom-thinking:12", end = ST, params = ""): string => `\x1b]8;${params};${url}${end}`;
const filtered = (chunks: string[]): string => {
  const filter = new ActivityLinkFilter();
  return chunks.map(chunk => filter.write(chunk)).join("") + filter.finish();
};

describe("activity link output filtering", () => {
  it.each([ST, "\x07"])("removes internal activity links with terminator %j while preserving text and SGR", end => {
    const source = `\x1b[?2026h${open(undefined, end)}\x1b[90m▸ Thought for 12s\x1b[39m${close(end)}\r\n`
      + `${open(undefined, end, "id=thought")}  读取结果 🧪${close(end)}\x1b[?2026l`;
    expect(filtered([source])).toBe("\x1b[?2026h\x1b[90m▸ Thought for 12s\x1b[39m\r\n  读取结果 🧪\x1b[?2026l");
  });

  it("handles every write boundary and one-code-unit chunks without leaking internal markers", () => {
    const source = `before ${open()}summary${close()} ${open("xloom-thinking:3", "\x07")}body 🧪${close("\x07")} after`;
    const expected = "before summary body 🧪 after";
    for (let split = 0; split <= source.length; split++) expect(filtered([source.slice(0, split), source.slice(split)])).toBe(expected);
    expect(filtered(source.split(""))).toBe(expected);
  });

  it("preserves external and lookalike URLs plus unrelated terminal controls exactly", () => {
    const source = ["https://example.test/path", "xloom-thinking:abc", "xloom-thinking:12/evil", "other:xloom-thinking:12"]
      .map(url => `${open(url)}label${close()}`).join(" ")
      + "\x1b]0;window title\x07\x1b]52;c;dGV4dA==\x07\x1b[2J\x1b[4;5H\x1b[?25h\x1b[?2026l";
    expect(filtered(source.split(""))).toBe(source);
  });

  it("replaces a preceding external link with plain internal text without swallowing subsequent external links", () => {
    const first = open("https://first.test");
    const next = open("https://next.test");
    const source = `${first}first${open()}plain${next}next${close()}${open()}plain again${close()}`;
    expect(filtered(source.split(""))).toBe(`${first}first${close()}plain${next}next${close()}plain again`);
  });

  it.each(["P", "X", "^", "_"])("preserves opaque ESC %s strings containing OSC-looking payloads", kind => {
    const opaque = `\x1b${kind}payload ${open(undefined, "\x07")}unchanged${close("\x07")}${ST}`;
    const source = `${opaque}${open()}plain${close()}`;
    expect(filtered(source.split(""))).toBe(`${opaque}plain`);
  });

  it("does not interpret embedded link text inside unrelated OSC payloads", () => {
    const opaque = `\x1b]0;title with ${open(undefined, "\x07")}`;
    expect(filtered(opaque.split(""))).toBe(opaque);
  });

  it("streams large unrelated OSC payloads with bounded carry and retains their opaque state across chunks", () => {
    const filter = new ActivityLinkFilter();
    const head = "\x1b]1337;File=" + "a".repeat(32_768);
    const first = filter.write(head);
    expect(first.length).toBeGreaterThanOrEqual(head.length - 1024);
    // The oversized OSC stays opaque until BEL/ST; an embedded open is still payload.
    const tail = "nested \x1b]8;;xloom-thinking:12" + ST;
    expect(first + filter.write(tail) + filter.write(`${open()}plain${close()}`) + filter.finish()).toBe(head + tail + "plain");
  });

  it("preserves unfinished unrelated escape strings at shutdown and can start a fresh stream", () => {
    for (const source of ["\x1b", "\x1b]", "\x1b]52;c;unfinished", "\x1b\x1b[2J"]) expect(filtered(source.split(""))).toBe(source);
    const filter = new ActivityLinkFilter();
    expect(filter.write("\x1b]0;unfinished")).toBe("");
    expect(filter.finish()).toBe("\x1b]0;unfinished");
    expect(filter.write(`${open()}fresh${close()}`)).toBe("fresh");
  });
});

describe("plain activity Terminal adapter", () => {
  it("preserves live geometry, input, resize, method receivers, lifecycle and non-render output", async () => {
    const calls: string[] = [];
    let onInput: (data: string) => void = () => {};
    let onResize: () => void = () => {};
    const terminal: Terminal = {
      columns: 80, rows: 24, kittyProtocolActive: false,
      start(input, resize) { expect(this).toBe(terminal); onInput = input; onResize = resize; calls.push("start"); },
      stop() { expect(this).toBe(terminal); calls.push("stop"); },
      async drainInput(maxMs, idleMs) { expect(this).toBe(terminal); calls.push(`drain:${maxMs}:${idleMs}`); },
      write(data) { expect(this).toBe(terminal); calls.push(data); },
      moveBy(lines) { expect(this).toBe(terminal); calls.push(`move:${lines}`); },
      hideCursor() { expect(this).toBe(terminal); calls.push("hide"); },
      showCursor() { expect(this).toBe(terminal); calls.push("show"); },
      clearLine() { expect(this).toBe(terminal); calls.push("line"); },
      clearFromCursor() { expect(this).toBe(terminal); calls.push("from"); },
      clearScreen() { expect(this).toBe(terminal); calls.push("screen"); },
      setTitle(title) { expect(this).toBe(terminal); calls.push(`title:${title}`); },
      setProgress(active) { expect(this).toBe(terminal); calls.push(`progress:${active}`); },
    };
    const adapter = new PlainActivityTerminal(terminal);
    const input = vi.fn();
    const resize = vi.fn();
    adapter.start(input, resize);
    onInput("\x1b[<0;5;4M");
    onResize();
    expect(input).toHaveBeenCalledWith("\x1b[<0;5;4M");
    expect(resize).toHaveBeenCalledOnce();
    expect([adapter.columns, adapter.rows, adapter.kittyProtocolActive]).toEqual([80, 24, false]);
    Object.assign(terminal, { columns: 20, rows: 6, kittyProtocolActive: true });
    expect([adapter.columns, adapter.rows, adapter.kittyProtocolActive]).toEqual([20, 6, true]);
    adapter.write(`${open()}plain${close()}`);
    adapter.moveBy(-2); adapter.hideCursor(); adapter.showCursor(); adapter.clearLine(); adapter.clearFromCursor(); adapter.clearScreen();
    adapter.setTitle("Xloom"); adapter.setProgress(true);
    await adapter.drainInput(300, 30);
    adapter.write("\x1b]0;incomplete");
    adapter.stop();
    expect(calls).toEqual(["start", "plain", "move:-2", "hide", "show", "line", "from", "screen", "title:Xloom", "progress:true", "drain:300:30", "\x1b]0;incomplete", "stop"]);
  });
});
