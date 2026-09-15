import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { ProjectConfig, Usage } from "../types.js";

/** No turn cap by default. Explicit caps reserve a final reporting turn;
 * resource/time cancellation always takes precedence. */
export function createRunBudget(limits: ProjectConfig["limits"], usage: Usage, spent: Usage,
  protocol: "chat" | "agent", signal: AbortSignal) {
  let turns = 0;
  let stoppedBy: string | undefined;
  const maxTurns = limits.maxTurnsPerRun;
  const finalInstruction = protocol === "chat"
    ? "This is the final allowed model turn; tools are unavailable. Report observed results and unfinished work honestly. Ending is not success."
    : "This is the final allowed model turn; tools are unavailable. Return the required JSON using observed results and existing artifacts. Unfinished Execute: no_progress/blocked; Decide: plan the next Step. Ending is not Goal completion.";
  const instruction = maxTurns === null
    ? ""
    : `maxTurnsPerRun=${maxTurns}: at most ${maxTurns} model requests including summaries, retries and repairs; reserve the last for a tool-free final report. Save artifacts first. This limit does not mean the Goal is complete.`;
  const shouldStopAfterTurn: NonNullable<AgentOptions["shouldStopAfterTurn"]> = ({ message }) => {
    turns++;
    const tokens = spent.input + spent.output + usage.input + usage.output;
    const cost = spent.cost + usage.cost;
    const reason = limits.maxTokens !== null && tokens >= limits.maxTokens ? `maxTokens=${limits.maxTokens}, tokens=${tokens}`
      : limits.maxCost !== null && cost >= limits.maxCost ? `maxCost=${limits.maxCost}, cost=${cost}`
      : maxTurns !== null && turns >= maxTurns ? `maxTurnsPerRun=${maxTurns}, turns=${turns}` : undefined;
    if (reason && message.content.some(part => part.type === "toolCall")) stoppedBy = reason;
    return reason !== undefined;
  };
  const prepareNextTurnWithContext: NonNullable<AgentOptions["prepareNextTurnWithContext"]> = ({ context }) => {
    signal.throwIfAborted();
    if (maxTurns === null || turns !== maxTurns - 1) return;
    // Pi captures tools when starting the loop: replacing the NEXT context is
    // required. Changing Agent.state.tools mid-loop would leave tools enabled.
    return { context: { ...context, tools: [], systemPrompt: `${context.systemPrompt}\n\n${finalInstruction}` } };
  };
  return {
    get canRequest(): boolean {
      return !signal.aborted && (maxTurns === null || turns < maxTurns)
        && (limits.maxTokens === null || spent.input + spent.output + usage.input + usage.output < limits.maxTokens)
        && (limits.maxCost === null || spent.cost + usage.cost < limits.maxCost);
    },
    instruction: `${instruction}${maxTurns === 1 ? `\n${finalInstruction}` : ""}`,
    toolsAllowed: maxTurns === null || maxTurns > 1,
    shouldStopAfterTurn,
    prepareNextTurnWithContext,
    get error(): string | undefined {
      if (!stoppedBy) return;
      return protocol === "chat"
        ? `Chat response budget reached before a final reply (${stoppedBy}); tool side effects may remain. Inspect results before retrying.`
        : `Agent budget reached before a final result (${stoppedBy}); the Step may have partial side effects. Inspect artifacts before retrying.`;
    },
  };
}
