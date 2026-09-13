import { constants } from "node:fs";
import { access, opendir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createReadTool, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";

const maxDirectoryEntries = 200;
const maxDirectoryBytes = 16 * 1024;

class DirectoryRead extends Error {
  constructor(readonly path: string) { super("Directory read"); }
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Operation aborted");
}

async function nearestExistingParent(path: string, signal?: AbortSignal): Promise<string | undefined> {
  let parent = dirname(path);
  while (true) {
    checkAbort(signal);
    try {
      const info = await stat(parent);
      checkAbort(signal);
      if (info.isDirectory()) return parent;
    } catch (error) {
      checkAbort(signal);
      // An inaccessible ancestor cannot establish which parent exists. Keep
      // the original read failure instead of replacing it with this diagnostic.
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String(error.code))) return;
    }
    const ancestor = dirname(parent);
    if (ancestor === parent) return;
    parent = ancestor;
  }
}

async function listDirectory(path: string, offset = 1, limit = maxDirectoryEntries, signal?: AbortSignal) {
  checkAbort(signal);
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Directory offset and limit must be positive integers (offset is 1-indexed).");
  }
  const pageSize = Math.min(limit, maxDirectoryEntries);
  const lines: string[] = [];
  let seen = 0;
  let bytes = 0;
  let hasMore = false;
  const directory = await opendir(path);
  try {
    while (true) {
      checkAbort(signal);
      const entry = await directory.read();
      checkAbort(signal);
      if (!entry) break;
      seen++;
      if (seen < offset) continue;
      // Dirent types require no stat of children, so linked directories are not followed.
      const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      const line = `[${kind}] ${JSON.stringify(entry.name)}`;
      const size = Buffer.byteLength(line, "utf8") + 1;
      // Reserve room for the header and continuation/evidence notices.
      if (lines.length >= pageSize || bytes + size > maxDirectoryBytes - 512) {
        if (lines.length === 0) throw new Error("Directory entry exceeds the listing byte limit.");
        hasMore = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
  } finally {
    await directory.close();
  }
  checkAbort(signal);
  if (seen > 0 && offset > seen) throw new Error(`Offset ${offset} is beyond end of directory (${seen} entries total).`);
  if (seen === 0 && offset > 1) throw new Error(`Offset ${offset} is beyond end of directory (0 entries total).`);
  const nextOffset = offset + lines.length;
  const notice = seen === 0 ? "(empty directory)"
    : hasMore ? `[Truncated: showing entries ${offset}-${nextOffset - 1}. Use offset=${nextOffset} to continue.]`
    : `[Showing entries ${offset}-${nextOffset - 1}; end of directory.]`;
  return {
    content: [{ type: "text" as const, text: [
      "Directory entries (non-recursive; filesystem order; names are JSON strings):",
      ...lines,
      notice,
      "This listing does not establish that planned artifacts were created; read the exact artifact files.",
    ].join("\n") }],
    details: { directory: true, offset, entries: lines.length, truncated: hasMore, ...(hasMore ? { nextOffset } : {}) },
  };
}

/** Keep Pi's path resolution and file/image handling; add discovery for read-only stages. */
export function createWorkspaceReadTool(workspace: string) {
  const tool = createReadTool(workspace, { operations: {
    readFile,
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
    async access(path) {
      await access(path, constants.R_OK);
      if ((await stat(path)).isDirectory()) throw new DirectoryRead(path);
    },
  } });
  const execute = tool.execute;
  tool.description = "Read text/images or list immediate directory entries. Files: 2000 lines/50KB. Directories: 200 entries/16KB; no recursion. Use 1-indexed offset/limit to page lines or entries. Verify exact paths; planned files may not exist.";
  tool.execute = async (id, params, signal, onUpdate) => {
    try {
      return await execute(id, params, signal, onUpdate);
    } catch (error) {
      if (error instanceof DirectoryRead) {
        try {
          return await listDirectory(error.path, params.offset, params.limit, signal);
        } catch (listingError) {
          error = listingError;
        }
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        checkAbort(signal);
        // Native filesystem errors retain the exact path Pi already resolved.
        // Use that call's error, not shared state or another path resolver.
        const failedPath = (error as NodeJS.ErrnoException).path;
        const parent = typeof failedPath === "string" && isAbsolute(failedPath) ? await nearestExistingParent(failedPath, signal) : undefined;
        error.message += parent
          ? `\nNearest existing parent directory: ${JSON.stringify(parent)}. Read this directory to discover exact names; do not guess or retry the same missing path.`
          : "\nRead an existing parent directory to discover exact names; a planned artifact may not have been written yet. Do not guess or retry the same missing path.";
      }
      throw error;
    }
  };
  return tool;
}
