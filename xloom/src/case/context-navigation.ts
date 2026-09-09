import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyEvent } from './store.js';
import { emptyBoard, hasToolSource, toolCallRef, type BoardEvent, type BoardState, type Evidence } from './types.js';
import { ensureContextIndex, type ContextIndexSnapshot } from './context-index.js';

// One append-only replay checkpoint per Session. Pure derived reads keep exactly
// the same prefix and therefore do not replay the growing board on each request.
const checkpoints = new Map<string, { prefix: string; board: BoardState }>();

/** A complete historical index for navigation. Its anchor excludes only known
 * successful derived reads and their exact call records, plus delivery cursors.
 * The current Capsule remains authoritative for status, inputs and unknown acts.
 * This does not change knowledgeRevision or remove any authoritative event. */
export function navigationContextIndex(board: BoardState, sessionDir: string): ContextIndexSnapshot | undefined {
  const path = join(sessionDir, 'blackboard', 'events.jsonl');
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split('\n').slice(0, board.revision);
  if (lines.length !== board.revision || lines.some(line => !line.trim())) throw new Error('导航索引的当前事件前缀不完整');
  const events = lines.map(line => JSON.parse(line) as BoardEvent);
  const callKey = (call: { runId: string; toolCallId: string; responseRef?: string }) => `${call.runId}:${toolCallRef(call)}`;
  const successfulDerivedRead = (e: Evidence) => e.tool === 'read' && e.kind === 'derived' && e.status === 'observed'
    && e.outcomeKnown !== false && (!e.execution || e.execution.outcome === 'completed');
  const startedReads = new Map<string, number>(), sourceCounts = new Map<string, number>(), resultCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'tool_started') {
      const key = callKey(event.payload); sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
      if (event.payload.tool === 'read') startedReads.set(key, event.revision);
    }
    if (event.type === 'evidence_recorded') {
      const key = callKey(event.payload.evidence); resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1);
    }
  }
  const derivedCalls = new Set<string>();
  for (const event of events) if (event.type === 'evidence_recorded') {
    const e = event.payload.evidence, key = callKey(e), run = board.runs[e.runId], current = board.evidence[e.id];
    if (successfulDerivedRead(e) && current && successfulDerivedRead(current) && callKey(current) === key
      && e.agent === run?.agent && hasToolSource(run, e) && run.evidenceIds.includes(e.id)
      && sourceCounts.get(key) === 1 && resultCounts.get(key) === 1 && (startedReads.get(key) ?? Infinity) < event.revision) derivedCalls.add(key);
  }
  const transient = (event: BoardEvent) => {
    if (event.type === 'inputs_delivered' || event.type === 'cursor_restored') return true;
    if (event.type === 'tool_started') return event.payload.tool === 'read' && derivedCalls.has(callKey(event.payload));
    if (event.type === 'evidence_recorded') return successfulDerivedRead(event.payload.evidence) && derivedCalls.has(callKey(event.payload.evidence));
    return false;
  };
  const last = events.findLastIndex(event => !transient(event));
  if (last < 0) return undefined;
  const prefix = lines.slice(0, last + 1).join('\n') + '\n', key = resolve(sessionDir);
  const previous = checkpoints.get(key);
  let snapshot: BoardState;
  if (previous?.prefix === prefix) snapshot = previous.board;
  else {
    const appendOnly = previous && prefix.startsWith(previous.prefix);
    snapshot = appendOnly ? previous.board : emptyBoard();
    try {
      for (const event of events.slice(appendOnly ? snapshot.revision : 0, last + 1)) applyEvent(snapshot, event);
    } catch (error) {
      // applyEvent mutates in place. A later invalid event must not leave an
      // advanced board paired with the earlier cached prefix; after an explicit
      // log repair the next projection must replay the authoritative bytes.
      checkpoints.delete(key);
      throw error;
    }
    checkpoints.set(key, { prefix, board: snapshot });
  }
  // ensureContextIndex still verifies all published bytes and rebuilds missing
  // pages; current evidence integrity is checked by renderCapsule before here.
  return ensureContextIndex(snapshot, sessionDir);
}
