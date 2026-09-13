import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import type { BlackboardContext } from "./loop/context.js";
import type { RunRequest } from "./types.js";

export const methodIds = [
  "baseline-authz", "flow-chain", "static-dynamic-retest", "observer-validity",
  "controller-reach", "capability-consumer", "protocol-binding", "patch-differential",
  "authorization-context", "evidence-linkage", "asset-attribution", "impact-assessment", "hypothesis-lifecycle",
] as const;
export type MethodId = typeof methodIds[number];
export const maxStepMethods = 3;
export const stepMethodIdsSchema = z.array(z.enum(methodIds)).max(maxStepMethods)
  .refine(ids => new Set(ids).size === ids.length, "Method IDs must be unique");

// src/ and dist/ share the installation root; never resolve through the task CWD.
export const methodsDirectory = fileURLToPath(new URL("../resources/methods/", import.meta.url));
const knownIds = new Set<string>(methodIds);
const cardSchema = z.object({ execute: z.string().min(1).max(700), review: z.string().min(1).max(500) }).strict();
export type MethodCard = z.infer<typeof cardSchema>;

function readResource(name: string): unknown {
  try { return JSON.parse(readFileSync(join(methodsDirectory, name), "utf8")); }
  catch (error) { throw new Error(`Cannot load built-in method resource ${name}. Rebuild/reinstall Xloom.`, { cause: error }); }
}

export function methodCatalog(): Record<MethodId, string> {
  const catalog = z.record(z.string().min(1).max(100)).parse(readResource("catalog.json"));
  if (Object.keys(catalog).length !== methodIds.length || methodIds.some(id => !Object.hasOwn(catalog, id))) {
    throw new Error("Built-in method catalog does not match this Xloom version.");
  }
  return catalog as Record<MethodId, string>;
}

export function loadMethod(id: string): MethodCard {
  if (!knownIds.has(id)) throw new Error(`Unknown built-in method: ${id}`);
  return cardSchema.parse(readResource(`${id}.json`));
}

export interface MethodContext {
  notice: string;
  catalog?: Record<MethodId, string>;
  directory?: string;
  cards: Record<string, string>;
  deferredIds?: string[];
  unavailableIds?: string[];
}

/** Selection is explicit Step state, never keyword routing or target evidence. */
export function projectMethods(request: RunRequest, context: BlackboardContext): MethodContext | undefined {
  const execute = request.mode === "execute";
  const reviewable = new Set(["done", "no_progress", "blocked", "failed"]);
  const requested = [...new Set(execute ? request.step?.methodIds ?? [] :
    [...[...context.steps].reverse(), ...[...context.stepOrigins].reverse()]
      .filter(step => reviewable.has(step.status)).flatMap(step => step.methodIds ?? []))];
  if (execute && !requested.length) return undefined;
  const available = requested.filter(id => knownIds.has(id));
  const unavailableIds = requested.filter(id => !knownIds.has(id));
  const deferredIds = available.slice(maxStepMethods);
  return {
    notice: execute ? "Method guidance, not target evidence; follow the assigned Step and scope." :
      "Method guidance, not target evidence. Steps may select 0-3 methodIds from catalog. Cards review recent tested Steps; read directory/<id>.json for details or deferred IDs. Choose by the evidence gap; methods cannot complete a Goal.",
    ...(!execute ? { catalog: methodCatalog() } : {}),
    ...(!execute || deferredIds.length ? { directory: methodsDirectory } : {}),
    cards: Object.fromEntries(available.slice(0, maxStepMethods).map(id => {
      const card = loadMethod(id);
      return [id, execute ? `${card.execute}\n${card.review}` : card.review];
    })),
    ...(deferredIds.length ? { deferredIds } : {}),
    ...(unavailableIds.length ? { unavailableIds } : {}),
  };
}
