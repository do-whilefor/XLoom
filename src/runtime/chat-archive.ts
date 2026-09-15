import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../paths.js";
import { checkpointSchema } from "./continuity.js";

interface Pointer { version: 1; id: string; binding: string | null }
const regular = (file: string) => {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("Chat storage cannot use symbolic links.");
};

/** The application workspace lock is the single-writer boundary. Old chats are retained. */
export class ChatArchive {
  // Selection belongs to this session. The disk pointer is archival metadata,
  // never an instruction to import another session's messages or usage.
  private pointer?: Pointer;
  constructor(readonly directory: string) {}
  private publish(pointer: Pointer): Pointer {
    regular(this.directory); regular(join(this.directory, "current.json"));
    atomicJson(join(this.directory, "current.json"), pointer);
    return this.pointer = pointer;
  }
  reset(): void { this.publish({ version: 1, id: `chat-${randomUUID()}`, binding: null }); }
  release(): void { this.pointer = undefined; }
  select(identity: string): { id: string; file: string } {
    const binding = createHash("sha256").update(identity).digest("hex");
    const prior = this.pointer;
    const pointer = prior?.binding === binding ? prior : this.publish({ version: 1,
      id: prior?.binding === null ? prior.id : `chat-${randomUUID()}`, binding });
    return { id: pointer.id, file: this.file(pointer.id) };
  }
  private file(id: string): string {
    const directory = join(this.directory, id); regular(directory);
    const file = join(directory, "continuation.json"); regular(file);
    return file;
  }
  inspect() {
    regular(this.directory);
    const pointer = this.pointer;
    if (!pointer) return undefined;
    const file = this.file(pointer.id);
    const checkpoint = existsSync(file) ? checkpointSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
    if (checkpoint && (checkpoint.identity.role !== "chat" || checkpoint.identity.taskId !== pointer.id)) throw new Error("Chat archive identity mismatch.");
    return { id: pointer.id, file, checkpoint };
  }
}
