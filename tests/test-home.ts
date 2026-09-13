import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Every test file and its child processes use disposable storage, never real credentials/tasks.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xloom-test-home-")));
process.env.XLOOM_HOME = path.join(root, ".xloom");
process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi", "agent");
mkdirSync(process.env.XLOOM_HOME, { recursive: true });
afterAll(() => {
  if (path.dirname(root) !== realpathSync(tmpdir()) || !path.basename(root).startsWith("xloom-test-home-")) throw new Error("Unsafe test home cleanup.");
  rmSync(root, { recursive: true, force: true });
});
