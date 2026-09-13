import { createEditTool } from "@earendil-works/pi-coding-agent";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Preserve Pi's matching and mutation semantics; explain how to repair stale input. */
export function createWorkspaceEditTool(workspace: string, checkpointFile?: string) {
  const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const tool = createEditTool(workspace, checkpointFile ? { operations: { readFile, writeFile, async access(path) {
    if (canonical(path) === canonical(checkpointFile)) throw Object.assign(new Error("Checkpoint write required"), { code: "XLOOM_CHECKPOINT_WRITE_REQUIRED" });
    await access(path);
  } } } : undefined);
  const execute = tool.execute;
  tool.execute = async (...args: Parameters<typeof execute>) => {
    try {
      return await execute(...args);
    } catch (error) {
      if (error instanceof Error && error.message.includes("XLOOM_CHECKPOINT_WRITE_REQUIRED"))
        throw new Error("Checkpoint must be submitted with write. No file was edited or committed. Send the complete corrected JSON in write.content to checkpointFile; a rejected write may not have created a file. Preserve previously accepted records and submit only new records.");
      if (error instanceof Error && /^(?:Could not find (?:the exact text|edits\[\d+\]) in |Found \d+ occurrences of (?:the text|edits\[\d+\]) in )/.test(error.message)) {
        error.message += `\nRead current file ${JSON.stringify(args[1].path)}, then copy exact unique oldText from that read before editing again. Do not guess or retry unchanged oldText.`;
      }
      throw error;
    }
  };
  return tool;
}
