// Invoked in a separate Node process to exercise bridge persistence after its caller exits.
import { callPersistentChrome, controlChrome } from "../../src/runtime/chrome-daemon.ts";
const options = { workspace: process.argv[2], artifactsDirectory: process.argv[2] };
if (process.argv[3] === "call") {
  const result = await callPersistentChrome(options, "take_snapshot", { pageId: "offline-invalid-type" });
  if (!result.isError) throw new Error("Expected schema rejection before browser connection");
}
console.log(JSON.stringify(await controlChrome(options, "status")));
