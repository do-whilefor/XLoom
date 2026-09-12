import { describe, expect, it } from "vitest";
import { EventFeed, plainText } from "../src/ui/model.js";
import { FeedView } from "../src/ui/feed-view.js";

describe("tool failure diagnostics in the real feed", () => {
  it("keeps a long PowerShell failure's tail and shows the exit status instead of the initial HTTP output", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "tool_start", mode: "execute", toolName: "powershell", toolCallId: "capture", text: JSON.stringify({ command: "fixture output collection ".repeat(500) }) });
    const output = `HTTP/1.1 200 OK\n${"synthetic response body\n".repeat(1500)}\nThe term '2>&1' is not recognized as a name of a cmdlet.\nCommand exited with code 1`;
    feed.runtime({ type: "tool_end", mode: "execute", toolName: "powershell", toolCallId: "capture", text: output, isError: true });
    const entry = feed.entries.find(item => item.kind === "tool")!;
    expect(entry.output!.length).toBeLessThanOrEqual(9000);
    expect(entry.output).toContain("[output omitted]");
    expect(entry.output).toContain("Command exited with code 1");
    const view = new FeedView(feed);
    const collapsed = view.render(160).map(plainText).join("\n");
    expect(collapsed).toContain("Command exited with code 1");
    expect(collapsed).toContain("The term '2>&1' is not recognized");
    expect(collapsed).not.toContain("HTTP/1.1 200 OK");
    view.detailsVisible = true;
    const expanded = view.render(100).map(plainText).join("\n");
    expect(expanded).toContain("Command exited with code 1");
  });

  it("does not classify successful tool output as a failure merely because it contains error-like text", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "tool_start", mode: "execute", toolName: "read", toolCallId: "fixture", text: '{"path":"fixture.txt"}' });
    feed.runtime({ type: "tool_end", mode: "execute", toolName: "read", toolCallId: "fixture", text: "Example: Command exited with code 1\nError: quoted documentation", isError: false });
    expect(feed.entries.find(item => item.kind === "tool")).toMatchObject({ error: false, state: "done" });
    expect(new FeedView(feed).render(100).map(plainText).join("\n")).not.toContain("✕");
  });
});
