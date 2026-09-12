import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { createWorkspaceReadTool } from "../src/runtime/read.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "xloom-read-test-"));
  directories.push(directory);
  return directory;
}
const output = (result: Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>) => result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
const entryLines = (text: string) => text.split("\n").filter(line => /^\[(file|directory|symlink|other)\]/.test(line));

describe("workspace read tool", () => {
  it("keeps Pi's tool name and input schema", async () => {
    const directory = await workspace();
    const tool = createWorkspaceReadTool(directory);
    const original = createReadTool(directory);
    expect(tool.name).toBe(original.name);
    expect(tool.parameters).toEqual(original.parameters);
  });

  it("lists real immediate entries, including dotfiles, without claiming planned files exist", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "hidden-child.txt"), "child");
    await writeFile(join(directory, ".actual file.txt"), "present");
    const result = await createWorkspaceReadTool(directory).execute("directory", { path: "." });
    const text = output(result);
    expect(text).toContain('[directory] "nested"');
    expect(text).toContain('[file] ".actual file.txt"');
    expect(text).not.toContain("hidden-child.txt");
    expect(text).not.toContain("plan.json");
    expect(text).toContain("does not establish that planned artifacts were created");
    expect(result.details).toMatchObject({ directory: true, entries: 2, truncated: false });
  });

  it("distinguishes an empty directory from a missing file", async () => {
    const directory = await workspace();
    const tool = createWorkspaceReadTool(directory);
    expect(output(await tool.execute("empty", { path: directory }))).toContain("(empty directory)");
    await expect(tool.execute("missing", { path: "missing-plan.json" })).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining("Read an existing parent directory to discover exact names"),
    });
    await expect(readFile(join(directory, "missing-plan.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not silently correct Markdown-escaped or guessed file names", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "task_plan.json"), "real");
    await expect(createWorkspaceReadTool(directory).execute("escaped", { path: String.raw`task\_plan.json` })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pages directory entries with existing offset/limit and rejects offsets beyond the end", async () => {
    const directory = await workspace();
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, name), name);
    const tool = createWorkspaceReadTool(directory);
    const all = entryLines(output(await tool.execute("all", { path: "." })));
    const first = await tool.execute("first", { path: ".", limit: 2 });
    expect(entryLines(output(first))).toEqual(all.slice(0, 2));
    expect(output(first)).toContain("Use offset=3 to continue");
    const last = await tool.execute("last", { path: ".", offset: 3, limit: 2 });
    expect(entryLines(output(last))).toEqual(all.slice(2));
    expect(last.details.truncated).toBe(false);
    await expect(tool.execute("beyond", { path: ".", offset: 4 })).rejects.toThrow("beyond end of directory (3 entries total)");
  });

  it("bounds directory pages even when the requested limit is enormous", async () => {
    const directory = await workspace();
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(directory, `${index}.txt`), "")));
    const result = await createWorkspaceReadTool(directory).execute("bounded", { path: ".", limit: 1000000 });
    expect(entryLines(output(result))).toHaveLength(200);
    expect(result.details).toMatchObject({ truncated: true, nextOffset: 201 });
  });

  it("bounds directory output by bytes without cutting a name or skipping it on the next page", async () => {
    const directory = await workspace();
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(directory, `${index}-${"x".repeat(190)}.txt`), "")));
    const tool = createWorkspaceReadTool(directory);
    const first = await tool.execute("bytes", { path: "." });
    expect(first.details.truncated).toBe(true);
    expect(first.details.entries).toBeLessThan(100);
    expect(Buffer.byteLength(output(first))).toBeLessThanOrEqual(16 * 1024);
    const last = await tool.execute("rest", { path: ".", offset: first.details.nextOffset });
    expect(first.details.entries + last.details.entries).toBe(100);
    expect(new Set([...entryLines(output(first)), ...entryLines(output(last))]).size).toBe(100);
  });

  it("reports directory symlinks without following their contents", async () => {
    const directory = await workspace();
    const target = await workspace();
    await writeFile(join(target, "target-secret.txt"), "not listed");
    await symlink(target, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    const text = output(await createWorkspaceReadTool(directory).execute("links", { path: "." }));
    expect(text).toContain('[symlink] "linked"');
    expect(text).not.toContain("target-secret.txt");
  });

  it("preserves Pi's relative, absolute, tilde, file URL, and space path semantics", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "space name"));
    const file = join(directory, "space name", "text.txt");
    await writeFile(file, "first\nsecond\nthird\nfourth");
    const original = createReadTool(directory);
    const tool = createWorkspaceReadTool(directory);
    const paths = ["space name/text.txt", file, pathToFileURL(file).href, `~/${relative(homedir(), file).replaceAll("\\", "/")}`];
    for (const path of paths) {
      const params = { path, offset: 2, limit: 2 };
      expect(await tool.execute("file", params)).toEqual(await original.execute("original", params));
      const directoryPath = path === file ? join(directory, "space name") : path.replace(/[/\\]text\.txt$/, "");
      expect(output(await tool.execute("dir-path", { path: directoryPath }))).toContain('[file] "text.txt"');
    }
  });

  it("preserves image attachments from Pi's native reader", async () => {
    const directory = await workspace();
    const path = join(directory, "pixel.gif");
    await writeFile(path, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    const result = await createWorkspaceReadTool(directory).execute("image", { path });
    expect(result).toEqual(await createReadTool(directory).execute("original", { path }));
    expect(result.content.some(part => part.type === "image")).toBe(true);
  });

  it("honors cancellation before any directory/file read", async () => {
    const directory = await workspace();
    const controller = new AbortController();
    controller.abort();
    const tool = createWorkspaceReadTool(directory);
    await expect(tool.execute("aborted", { path: "." }, controller.signal)).rejects.toThrow("Operation aborted");
    await expect(tool.execute("aborted-missing", { path: "absent" }, controller.signal)).rejects.toThrow("Operation aborted");
  });

  it.each([{ offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: -1 }])("rejects invalid directory pagination %j", async params => {
    const directory = await workspace();
    await expect(createWorkspaceReadTool(directory).execute("invalid", { path: ".", ...params })).rejects.toThrow("positive integers");
  });
});
