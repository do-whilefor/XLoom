import type { AgentRole, BoardState, ToolName, ToolScopeInput, ToolScopeState } from './types.js';

export const scopeTools: readonly ToolName[] = ['read', 'write', 'edit', 'bash', 'chrome', 'kali'];
const roles: readonly AgentRole[] = ['probe', 'proof'];
type Changes = Partial<Record<AgentRole, ToolName[]>>;
export type ParsedToolScope = { kind: 'none' } | { kind: 'valid' | 'invalid'; changes: Changes; roles: AgentRole[]; lines: string[]; error?: string; errorRoles: AgentRole[] };

/** First-version input grammar: standalone role-only lines or a labelled list.
 * Role/tool ASCII names ignore case. Space around tokens, / and comma lists,
 * Chinese punctuation, [] and [nonempty,list] have fixed equivalent meanings.
 * Whitespace alone is not a list separator. This is not a prose permission parser.
 */
export function parseToolScopeInput(text: string): ParsedToolScope {
  const changes: Changes = {}, lines: string[] = [], errors: string[] = [];
  const mentioned = new Set<AgentRole>(), affected = new Set<AgentRole>();
  let globalError = false;
  const fail = (reason: string, role?: AgentRole) => { errors.push(reason); if (role) affected.add(role); else globalError = true; };
  const declaration = (rawRole: string, rawList: string) => {
    const role = rawRole.trim().toLowerCase() as AgentRole;
    if (!roles.includes(role)) { fail(`未知角色 ${rawRole.trim() || '（空）'}`); return; }
    mentioned.add(role);
    let list = rawList.trim();
    if (list.startsWith('[') || list.endsWith(']')) {
      if (!list.startsWith('[') || !list.endsWith(']')) { fail(`${rawRole} 列表括号不完整`, role); return; }
      list = list.slice(1, -1).trim();
      if (!list) { assign(role, []); return; }
    } else if (!list) { fail(`${rawRole} 工具列表为空；禁止所有工具须明确写 []`, role); return; }
    const parts = list.split(/[,，/]/).map((part) => part.trim().toLowerCase());
    if (parts.some((part) => !part || !scopeTools.includes(part as ToolName))) { fail(`${rawRole} 有未知工具或非法分隔：${rawList}`, role); return; }
    assign(role, scopeTools.filter((tool) => parts.includes(tool)));
  };
  const assign = (role: AgentRole, tools: ToolName[]) => {
    if (changes[role] && JSON.stringify(changes[role]) !== JSON.stringify(tools)) fail(`${role} 在同一消息中的工具集合冲突`, role);
    else changes[role] = tools;
  };
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    const labelled = /^(?:工具范围|tool\s+scope)\s*[:：]\s*(.*)$/i.exec(line);
    if (labelled) {
      lines.push(original);
      for (const segment of labelled[1].split(/[;；]/)) {
        const pair = /^\s*([^=＝;；]+?)\s*[=＝]\s*(.*?)\s*$/.exec(segment);
        if (pair) declaration(pair[1], pair[2]);
        else { const known = /^\s*(probe|proof)\b/i.exec(segment); fail(`工具范围声明格式无效：${segment || '（空）'}`, known?.[1].toLowerCase() as AgentRole | undefined); }
      }
      continue;
    }
    const standalone = /^([A-Za-z][A-Za-z0-9_-]*|[^\s仅]+\s+)\s*仅(?:限)?\s*(.*)$/i.exec(line)
      ?? /^(probe|proof)\s+only\b\s*(.*)$/i.exec(line);
    if (standalone) { lines.push(original); declaration(standalone[1], standalone[2]); continue; }
    // Recognized declaration prefixes must not silently revert to unrestricted.
    if (/^(?:工具范围|tool\s+scope\b)/i.test(line) || /^(?:probe|proof)\s*[=＝:：]/i.test(line)) {
      lines.push(original); const known = /^(probe|proof)\b/i.exec(line);
      fail(`工具范围声明格式无效：${line}`, known?.[1].toLowerCase() as AgentRole | undefined);
    }
  }
  return !lines.length ? { kind: 'none' } : { kind: errors.length ? 'invalid' : 'valid', changes,
    roles: [...mentioned], lines, ...(errors.length ? { error: errors.join('；') } : {}), errorRoles: globalError ? [] : [...affected] };
}

/** Pure replay from original user events. A Hint/Goal change can share one ID. */
export function applyToolScopeInput(board: BoardState, text: string, messageId: string, revision: number): void {
  if (board.toolScope?.inputs.some((input) => input.messageId === messageId)) return;
  const parsed = parseToolScopeInput(text); if (parsed.kind === 'none') return;
  const state = board.toolScope ??= { rules: {}, inputs: [] };
  const input: ToolScopeInput = { messageId, revision, status: parsed.kind === 'valid' ? 'applied' : 'invalid', roles: parsed.roles, lines: parsed.lines,
    ...(parsed.error ? { error: parsed.error } : {}) };
  state.inputs.push(input);
  if (parsed.kind === 'invalid') {
    const previous = state.error;
    const pendingRoles = previous ? (!previous.roles.length || !parsed.errorRoles.length ? [] : [...new Set([...previous.roles, ...parsed.errorRoles])]) : parsed.errorRoles;
    state.error = { messageId, roles: pendingRoles, reason: `工具范围未更新：${parsed.error}；保留原限制，等待明确修正。${previous ? ` 此前未修正：${previous.reason}` : ''}` };
    board.execution = 'paused'; board.reason = state.error.reason;
    if (board.outcome === 'satisfied') board.outcome = 'in_progress';
    return;
  }
  for (const role of parsed.roles) state.rules[role] = { tools: parsed.changes[role]!, messageId, revision };
  if (state.error) {
    const remaining = state.error.roles.filter((role) => !parsed.roles.includes(role));
    if (!remaining.length) delete state.error;
    else state.error = { ...state.error, roles: remaining };
  }
}

export function toolScopeDecision(board: BoardState, role: AgentRole, tool: ToolName) {
  const rule = board.toolScope?.rules[role], pending = board.toolScope?.error;
  const allowedTools = rule ? [...rule.tools] : [...scopeTools];
  const error = pending && (!pending.roles.length || pending.roles.includes(role)) ? pending : undefined;
  return { allowed: !error && allowedTools.includes(tool), allowedTools,
    sourceMessageId: error?.messageId ?? rule?.messageId,
    reason: error?.reason ?? `${role === 'probe' ? 'Probe' : 'Proof'} 当前允许工具：${allowedTools.join('/') || '[]'}` };
}

/** Recorder callers persist this result and consume the usual call budget, but
 * do not mint Evidence or connect to any backend for a denied operation.
 */
export function toolScopeDenial(board: BoardState, role: AgentRole, tool: ToolName) {
  const decision = toolScopeDecision(board, role, tool); if (decision.allowed) return undefined;
  const text = `未执行：用户工具范围禁止 ${role}/${tool}。${decision.reason}；未启动目标文件、shell 或后端动作，未生成 Evidence。`;
  return { text, details: { status: 'not_executed' as const, outcome: 'not_started' as const, reasonCode: 'tool_scope' as const,
    role, tool, allowedTools: decision.allowedTools, ...(decision.sourceMessageId ? { sourceMessageId: decision.sourceMessageId } : {}), reason: decision.reason } };
}

export function toolScopeSummary(board: BoardState, role?: AgentRole): string[] {
  const state: ToolScopeState | undefined = board.toolScope;
  if (!state) return [];
  const result = (role ? [role] : [...roles]).map((name) => {
    const rule = state.rules[name];
    return `${name === 'probe' ? 'Probe' : 'Proof'} 允许工具：${rule ? rule.tools.join('/') || '[]（全部禁止）' : '沿用六工具'}${rule ? `；来源 ${rule.messageId} / r${rule.revision}` : ''}`;
  });
  if (state.error) result.push(state.error.reason, ...(state.inputs.findLast((i) => i.messageId === state.error!.messageId)?.lines ?? []));
  return result;
}
