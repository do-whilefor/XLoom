import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { contextLabel, HeaderView, XLOOM_VERSION } from "../src/ui/header.js";
import { plainText, type SessionInfo } from "../src/ui/model.js";

vi.mock("chalk", async importOriginal => {
  const { Chalk } = await importOriginal<typeof import("chalk")>();
  return { default: new Chalk({ level: 3 }) };
});

const workspace = "D:\\工作区\\Xloom";
const info = { model: "fixture/deepseek-flash", modelName: "deepseek-flash", contextWindow: 1_048_576, authLabel: "API Key", workspace };

describe("dot-matrix X session header", () => {
  it("aligns information beside the three-row dotted X with two blank rows below", () => {
    const header = new HeaderView(() => info, "ignored");
    expect(header.render(90).map(plainText)).toEqual([
      `⠙⢿⣦⣀⣴⡿⠋   Xloom v${XLOOM_VERSION}`,
      "  ⠙⣿⣄     deepseek-flash[1M] · API Key",
      "⣠⣾⠟⠉⠻⣷⣄   D:\\工作区\\Xloom",
      "",
      "",
    ]);
    expect(header.render(90).map(plainText).join("\n")).not.toMatch(/Claude|Usage Billing|[\u2580-\u259f]/);
  });

  it("shows changed model metadata and uses the explicit workspace fallback when unavailable", () => {
    let current: Pick<SessionInfo, "model" | "modelName" | "contextWindow" | "authLabel" | "workspace"> = { model: "fixture/first" };
    const header = new HeaderView(() => current, workspace);
    expect(header.render(90).map(plainText).join("\n")).toContain("fixture/first");
    expect(header.render(90).map(plainText).join("\n")).toContain(workspace);
    current = { model: "fixture/second", contextWindow: 200_000, authLabel: "OAuth" };
    const screen = header.render(90).map(plainText).join("\n");
    expect(screen).toContain("fixture/second[200K] · OAuth");
    expect(screen).not.toContain("first");
  });

  it("uses coral Braille dots in all three logo rows", () => {
    const rows = new HeaderView(() => info, workspace).render(90);
    for (const row of rows.slice(0, 3)) expect(row).toMatch(/^\x1b\[38;2;217;139;115m[ \u2800-\u28ff]{7}\x1b\[39m/);
  });

  it.each([0, 1, 3, 8, 20, 31, 32, 90])("keeps every row within a %i-column terminal", width => {
    const rows = new HeaderView(() => ({ ...info, modelName: "测试模型".repeat(100), workspace: workspace.repeat(100) }), workspace).render(width);
    expect(rows).toHaveLength(5);
    expect(rows.slice(-2)).toEqual(["", ""]);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    if (width < 32) expect(rows.map(plainText).join("\n")).not.toMatch(/[\u2800-\u28ff]/);
  });

  it("sanitizes display values before adding renderer-owned styling", () => {
    const rows = new HeaderView(() => ({ model: "evil\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07", authLabel: "\x1b[2Jauth", workspace: "path\x1b[31m" }), workspace).render(90);
    const stripped = rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).not.toContain("\x1b");
    expect(stripped).not.toContain("https://");
  });

  it.each([[undefined, ""], [0, ""], [-1, ""], [NaN, ""], [Infinity, ""], [1.5, ""], [1_000_000, "[1M]"], [1_048_576, "[1M]"], [128_000, "[128K]"], [131_072, "[128K]"], [123_456, "[123,456]"]] as const)("formats known capacity %s without inventing a limit", (capacity, expected) => {
    expect(contextLabel(capacity)).toBe(expected);
  });
});
