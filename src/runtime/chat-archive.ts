import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson } from "../paths.js";
import { checkpointSchema } from "./continuity.js";

const pointerSchema = z.object({ version: z.literal(1), id: z.string().regex(/^chat-[a-f0-9-]{36}$/), binding: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
type Pointer = z.infer<typeof pointerSchema>;
const regular = (file: string) => {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("Chat storage cannot use symbolic links.");
};

/** The application workspace lock is the single-writer boundary. Old chats are retained. */
export class ChatArchive {
  constructor(readonly directory: string) {}
  private current(): Pointer | undefined {
    regular(this.directory);
    const file = join(this.directory, "current.json"); regular(file);
    return existsSync(file) ? pointerSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
  }
  private publish(pointer: Pointer): Pointer {
    regular(this.directory); regular(join(this.directory, "current.json"));
    atomicJson(join(this.directory, "current.json"), pointer);
    return pointer;
  }
  reset(): void { this.publish({ version: 1, id: `chat-${randomUUID()}`, binding: null }); }
  select(identity: string): { id: string; file: string } {
    const binding = createHash("sha256").update(identity).digest("hex");
    const prior = this.current();
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
    const pointer = this.current();
    if (!pointer) return undefined;
    const file = this.file(pointer.id);
    const checkpoint = existsSync(file) ? checkpointSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
    if (checkpoint && (checkpoint.identity.role !== "chat" || checkpoint.identity.taskId !== pointer.id)) throw new Error("Chat archive identity mismatch.");
    return { id: pointer.id, file, checkpoint };
  }
}
