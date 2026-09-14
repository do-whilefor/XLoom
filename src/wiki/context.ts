import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRequest } from "../types.js";

export function wikiContext(request: RunRequest) {
  if (!request.blackboardPath) return undefined;
  return { indexFile: join(dirname(request.blackboardPath), "wiki", "index.md"),
    observationsGuide: fileURLToPath(new URL("../../resources/observations.md", import.meta.url)),
    ...(request.wikiProjectionError ? { status: "unavailable", reason: request.wikiProjectionError }
      : { status: "projected", notice: "Sourced explanations; not original evidence. Native source packages include current source-change warnings. Use the index only for missing navigation/history; a complete package needs no index reread." }),
    ...(request.mode === "execute" ? { authoringGuide: fileURLToPath(new URL("../../resources/wiki/authoring.md", import.meta.url)),
      submission: "Optional wikiPages in execution/checkpoint output; read the guide when authoring. Metadata-only maintenance needs no new Evidence/Fact: cite existing IDs in summary; inspection/audit logs are not new observations." } : {}),
  };
}
