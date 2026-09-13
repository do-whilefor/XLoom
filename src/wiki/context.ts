import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRequest } from "../types.js";

export function wikiContext(request: RunRequest) {
  if (!request.blackboardPath) return undefined;
  return { indexFile: join(dirname(request.blackboardPath), "wiki", "index.md"),
    ...(request.wikiProjectionError ? { status: "unavailable", reason: request.wikiProjectionError }
      : { status: "projected", notice: "Sourced explanations; not original evidence. Read the index for current source-change warnings." }),
    ...(request.mode === "execute" ? { authoringGuide: fileURLToPath(new URL("../../resources/wiki/authoring.md", import.meta.url)),
      submission: "Optional wikiPages in existing execution/checkpoint output; read the guide only when recording a useful explanation." } : {}),
  };
}
