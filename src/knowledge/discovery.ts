import type { BoardSnapshot } from "../types.js";
import { capabilityIssues } from "./model.js";
import { compareConditions, typeNames, type Capability, type Conditions } from "./schema.js";
import { wikiGenerator } from "../wiki/format.js";

export interface Edge { producerId: string; consumerId: string; provideIndex: number; needIndex: number }
interface Plan { capabilityIds: string[]; links: Edge[]; conditions: Conditions[] }
export interface DiscoveryOptions { limit?: number; maxStates?: number; maxAlternatives?: number; consumerIds?: string[] }

/** Exact declared types/aliases only. Whole-plan search keeps AND prerequisites
 * and OR alternatives, including their shared conditions, separate from proof. */
export function discoverKnowledge(board: BoardSnapshot, options: DiscoveryOptions = {}) {
  const limit = options.limit ?? Infinity, maxStates = options.maxStates ?? 2000;
  const maxAlternatives = options.maxAlternatives ?? Infinity;
  if (!(limit === Infinity || Number.isSafeInteger(limit) && limit > 0) || !(maxAlternatives === Infinity || Number.isSafeInteger(maxAlternatives) && maxAlternatives > 0) || !Number.isSafeInteger(maxStates) || maxStates < 1) throw new Error("Discovery limits must be positive integers.");
  const capabilities = board.capabilities ?? [], byId = new Map(capabilities.map(item => [item.id, item]));
  const reviews = new Map(capabilities.map(item => [item.id, capabilityIssues(board, item)]));
  const providers = new Map<string, { capability: Capability; provideIndex: number }[]>();
  for (const capability of capabilities) capability.provides.forEach((port, provideIndex) => {
    for (const type of typeNames(port)) { const entries = providers.get(type) ?? []; entries.push({ capability, provideIndex }); providers.set(type, entries); }
  });
  const suppliers = (consumer: Capability, needIndex: number) => [...new Map(typeNames(consumer.needs[needIndex]!).flatMap(type => providers.get(type) ?? [])
    .filter(item => item.capability.id !== consumer.id).map(item => [`${item.capability.id}:${item.provideIndex}`, item])).values()]
    .sort((a, b) => Number(b.capability.status === "available") - Number(a.capability.status === "available") || a.capability.id.localeCompare(b.capability.id) || a.provideIndex - b.provideIndex);
  let searchedStates = 0, searchTruncated = false;
  const spend = () => { if (searchedStates >= maxStates) { searchTruncated = true; return false; } searchedStates++; return true; };
  function* expand(id: string, ancestors: Set<string>, plan: Plan): Generator<Plan> {
    if (!spend() || ancestors.has(id) || ancestors.size >= 64) { if (ancestors.size >= 64) searchTruncated = true; return; }
    if (plan.capabilityIds.includes(id)) { yield plan; return; }
    const capability = byId.get(id)!;
    if (capability.status === "unavailable" || reviews.get(id)!.length) return;
    const conditions = [...plan.conditions, capability.conditions];
    if (compareConditions(conditions).status === "conflict") return;
    const next: Plan = { ...plan, capabilityIds: [...plan.capabilityIds, id], conditions };
    const seen = new Set([...ancestors, id]);
    function* fill(index: number, current: Plan): Generator<Plan> {
      if (!spend()) return;
      if (index === capability.needs.length) { yield current; return; }
      for (const supplier of suppliers(capability, index)) {
        if (searchTruncated) return;
        for (const provided of expand(supplier.capability.id, seen, current)) {
          yield* fill(index + 1, { ...provided, links: [...provided.links, { producerId: supplier.capability.id, consumerId: id, provideIndex: supplier.provideIndex, needIndex: index }] });
        }
      }
    }
    yield* fill(0, next);
  }
  const consumers = capabilities.filter(item => item.needs.length).slice().reverse();
  if (options.consumerIds?.length) consumers.sort((a, b) => {
    const rank = (id: string) => { const index = options.consumerIds!.indexOf(id); return index < 0 ? Infinity : index; };
    return rank(a.id) - rank(b.id);
  });
  const items = consumers.slice(0, limit).map(consumer => {
    const inputs = consumer.needs.map((need, needIndex) => {
      const all = suppliers(consumer, needIndex);
      return { needIndex, type: need.type, alternatives: all.slice(0, maxAlternatives).map(({ capability, provideIndex }) => ({ producerId: capability.id, provideIndex,
        declaredStatus: capability.status, reviewIssues: reviews.get(capability.id)!, conditions: compareConditions([capability.conditions, consumer.conditions]) })), omittedAlternatives: Math.max(0, all.length - maxAlternatives) };
    });
    const plan = expand(consumer.id, new Set(), { capabilityIds: [], links: [], conditions: [] }).next().value as Plan | undefined;
    // Postorder produces a topological capability list, including shared prerequisites once.
    const ordered: string[] = [];
    const visit = (id: string) => { if (ordered.includes(id)) return; plan?.links.filter(link => link.consumerId === id).forEach(link => visit(link.producerId)); ordered.push(id); };
    if (plan) visit(consumer.id);
    return { consumerId: consumer.id, inputs, reviewIssues: reviews.get(consumer.id)!,
      plan: plan ? { capabilityIds: ordered, links: plan.links, conditions: compareConditions(plan.conditions), requirementsCovered: true,
        unverifiedCapabilityIds: ordered.filter(id => byId.get(id)!.status !== "available"), actualConsumption: "not_assessed" } : null,
      searchTruncated, notice: "A representative candidate plan is not evidence. No plan may mean missing, conflicting, stale or cyclic prerequisites, or a search limit; inspect alternatives and originals." };
  });
  return { generator: wikiGenerator, type: "capability_discovery", evidence: false, boardRevision: board.revision,
    items, omittedConsumerIds: consumers.slice(limit).map(item => item.id), searchedStates, searchTruncated,
    notice: "All required inputs are AND; providers are OR alternatives. Null conditions are unknown, never wildcards. Types/aliases are explicit declarations; no semantic inference, tool execution, or status upgrade occurs." };
}
