import { createEditTool } from "@earendil-works/pi-coding-agent";

/** Preserve Pi's matching and mutation semantics; explain how to repair stale input. */
export function createWorkspaceEditTool(workspace: string) {
  const tool = createEditTool(workspace);
  const execute = tool.execute;
  tool.execute = async (...args: Parameters<typeof execute>) => {
    try {
      return await execute(...args);
    } catch (error) {
      if (error instanceof Error && /^(?:Could not find (?:the exact text|edits\[\d+\]) in |Found \d+ occurrences of (?:the text|edits\[\d+\]) in )/.test(error.message)) {
        error.message += `\nRead current file ${JSON.stringify(args[1].path)}, then copy exact unique oldText from that read before editing again. Do not guess or retry unchanged oldText.`;
      }
      throw error;
    }
  };
  return tool;
}
