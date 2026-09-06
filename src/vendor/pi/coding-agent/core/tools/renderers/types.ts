import type { Component } from "../../../../tui/index.js";
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
}

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	state: TState;
	/** Working directory for this tool execution. */
	cwd: string;
	/** Whether the tool execution has started. */
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	isPartial: boolean;
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether inline images are currently shown in the TUI. */
	showImages: boolean;
	/** Whether the current result is an error. */
	isError: boolean;
}


// Fixed renderer signatures; no extension registration surface.
import type { AgentToolResult } from "../../../../agent/types.js";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
export interface BuiltinToolRenderers {
    renderShell?: "default" | "self";
    renderCall?: (args: any, theme: Theme, context: ToolRenderContext) => Component;
    renderResult?: (result: AgentToolResult<any>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) => Component;
}
