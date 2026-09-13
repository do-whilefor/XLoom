import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { createWorkspaceEditTool } from "../src/runtime/edit.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^xloom-edit-test-/);
    await rm(directory, { recursive: true, force: true });
  }
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "xloom-edit-test-"));
  directories.push(directory);
  return directory;
}

describe("workspace edit diagnostics", () => {
  it.each([false, true])("directs checkpoint edits to complete write submissions without touching files (exists: %s)", async exists => {
    const directory = await workspace(), path = join(directory, "checkpoint.json");
    if (exists) await writeFile(path, "accepted checkpoint");
    for (const requested of [path, "checkpoint.json", pathToFileURL(path).href, `~/${relative(homedir(), path).replaceAll("\\", "/")}`]) {
      await expect(createWorkspaceEditTool(directory, path).execute("checkpoint", { path: requested, edits: [{ oldText: "accepted", newText: "changed" }] }))
        .rejects.toThrow("Checkpoint must be submitted with write");
      if (exists) expect(await readFile(path, "utf8")).toBe("accepted checkpoint");
      else await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const other = join(directory, "ordinary.json"); await writeFile(other, "before");
    await createWorkspaceEditTool(directory, path).execute("ordinary", { path: other, edits: [{ oldText: "before", newText: "after" }] });
    expect(await readFile(other, "utf8")).toBe("after");
  });
  it("retains Pi's tool name, description and schema without adding normal-request prompt overhead", async () => {
    const directory = await workspace();
    const original = createEditTool(directory);
    const tool = createWorkspaceEditTool(directory);
    expect(tool.name).toBe(original.name);
    expect(tool.description).toBe(original.description);
    expect(tool.parameters).toEqual(original.parameters);
  });

  it.each(["missing", "ambiguous"] as const)("adds a current-file read instruction for %s oldText without modifying the file", async failure => {
    const directory = await workspace();
    const path = join(directory, "fixture.js");
    const content = "const result = select(value);\nrepeat();\nrepeat();\n";
    await writeFile(path, content);
    const params = { path, edits: [{ oldText: failure === "missing" ? "const result = select(value));" : "repeat();", newText: "must not be written" }] };
    const original = await createEditTool(directory).execute("original", params).catch(error => error);
    const error = await createWorkspaceEditTool(directory).execute("diagnostic", params).catch(error => error);
    expect(error.message.startsWith(original.message)).toBe(true);
    expect(error.message).toContain(`Read current file ${JSON.stringify(path)}, then copy exact unique oldText`);
    expect(error.message).toContain("Do not guess or retry unchanged oldText");
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it.each(["missing", "ambiguous"] as const)("diagnoses a %s indexed edit and leaves preceding valid edits uncommitted", async failure => {
    const directory = await workspace();
    const path = join(directory, "fixture.txt");
    const content = "first\nrepeated\nrepeated\n";
    await writeFile(path, content);
    const edits = [{ oldText: "first", newText: "changed" }, { oldText: failure === "missing" ? "absent" : "repeated", newText: "second" }];
    const error = await createWorkspaceEditTool(directory).execute("multi", { path, edits }).catch(error => error);
    expect(error.message).toContain("edits[1]");
    expect(error.message).toContain("then copy exact unique oldText");
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("does not append text-match advice to missing-file, overlap, invalid-input or cancelled errors", async () => {
    const directory = await workspace();
    const path = join(directory, "fixture.txt");
    const content = "first block\nsecond block\n";
    await writeFile(path, content);
    const calls = [
      { params: { path: join(directory, "absent.txt"), edits: [{ oldText: "first", newText: "next" }] } },
      { params: { path, edits: [{ oldText: "first block", newText: "one" }, { oldText: "first", newText: "two" }] } },
      { params: { path, edits: [] } },
      { params: { path, edits: [{ oldText: "first", newText: "next" }] }, signal: AbortSignal.abort() },
    ];
    for (const { params, signal } of calls) {
      const original = await createEditTool(directory).execute("original", params, signal).catch(error => error);
      const error = await createWorkspaceEditTool(directory).execute("unchanged", params, signal).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(original.message);
    }
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("preserves Pi's successful edits, BOM, line endings and relative/absolute/tilde/file URL paths", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "space name"));
    const path = join(directory, "space name", "fixture.txt");
    const before = "\uFEFFfirst\r\nsecond\r\nthird\r\n";
    const paths = ["space name/fixture.txt", path, `~/${relative(homedir(), path).replaceAll("\\", "/")}`, pathToFileURL(path).href];
    for (const requestedPath of paths) {
      const params = { path: requestedPath, edits: [{ oldText: "second", newText: "changed" }] };
      await writeFile(path, before);
      const original = await createEditTool(directory).execute("original", params);
      const expected = await readFile(path);
      await writeFile(path, before);
      const result = await createWorkspaceEditTool(directory).execute("wrapped", params);
      expect(result).toEqual(original);
      expect(await readFile(path)).toEqual(expected);
      expect(await readFile(path, "utf8")).toBe("\uFEFFfirst\r\nchanged\r\nthird\r\n");
    }
  });

  it("retains Pi's legacy oldText/newText argument preparation", async () => {
    const directory = await workspace();
    const path = join(directory, "legacy.txt");
    await writeFile(path, "old content");
    const params = { path, oldText: "old", newText: "new" };
    const tool = createWorkspaceEditTool(directory);
    const prepared = tool.prepareArguments!(params);
    expect(prepared).toEqual(createEditTool(directory).prepareArguments!({ ...params }));
    await tool.execute("legacy", prepared);
    expect(await readFile(path, "utf8")).toBe("new content");
  });
});
