import type { AgentTool, AgentToolResult } from '../vendor/pi/agent/types.js';
import type { BlackboardStore } from '../case/store.js';
import type { Evidence, ExternalDetails, RunRecord } from '../case/types.js';
import { toolCallRef } from '../case/types.js';
import type { SessionBackends } from '../backends/session.js';
import { BackendError, deadline } from '../backends/common.js';
import { validateKaliInput } from '../backends/kali.js';
import { redactor, redactStructured } from '../log.js';
import { ToolArtifacts, preview, type ArtifactStream } from './artifacts.js';
import { CHROME_HELP, createChromeTool, parseChromeCommand } from './chrome.js';
import { createKaliTool } from './kali.js';

export interface RecordingOptions {
  store: BlackboardStore; run: RunRecord; maxToolCalls: number;
  stop: (reason: string) => void; notice?: (text: string) => void; backends?: SessionBackends;
  responseRef?: () => string | undefined;
  supportsImages?: boolean;
}
export function recordedExternalTools(options: RecordingOptions): AgentTool<any>[] {
  const { store, run, backends } = options;
  return (['chrome','kali'] as const).map((name) => {
    const execute: AgentTool<any>['execute'] = async (callId, rawArgs, parent, update) => {
      const args = rawArgs as { command: string; cwd?: string; timeoutMs?: number };
      const responseRef = options.responseRef?.();
      const origin = responseRef ? { responseRef } : {};
      parent?.throwIfAborted();
      if (store.current().runs[run.id].toolCallIds.length >= options.maxToolCalls) {
        const reason = `达到每 Run 工具调用上限 ${options.maxToolCalls}；后续工具未执行`; options.stop(reason); throw new Error(reason);
      }
      const secrets = backends?.secrets ?? [], redact = redactor(...secrets);
      let files: ToolArtifacts;
      try {
        files = new ToolArtifacts(store.sessionDir, run.id, toolCallRef({ toolCallId: callId, responseRef }), secrets);
        store.toolStarted(run.id, callId, name, files.relativeDir, responseRef);
        files.save('execution.json', { sessionId: store.sessionDir.split('/').at(-1), agent: run.agent, agentSessionId: run.agentSessionId,
          runId: run.id, toolCallId: callId, ...origin, tool: name, backend: name, args, startedAt: new Date().toISOString() });
      } catch (e) { options.stop(`原始资料保存失败，动作未开始：${redact(String(e))}`); throw e; }
      let details: ExternalDetails = { backend: name, status: 'error', outcome: 'not_started' };
      let text = '', localHelp = false;
      let stdout: ArtifactStream | undefined, stderr: ArtifactStream | undefined;
      let scope: ReturnType<typeof deadline> | undefined;
      try {
        const command = name === 'chrome' ? parseChromeCommand(args.command) : undefined;
        if (command) details.operation = command.operation;
        localHelp = command?.operation === 'help';
        if (localHelp) { text = CHROME_HELP; details = { backend: name, operation: 'help', status: 'observed', outcome: 'not_started' }; }
        else {
          if (name === 'kali') validateKaliInput(args);
          if (!backends) throw new BackendError('后端尚未绑定活动用户会话', { ...details, fatal: true });
          scope = deadline(parent, name === 'kali' ? args.timeoutMs : undefined);
          if (name === 'chrome') ({ details, text } = await backends.chrome.execute(command!, files, scope.signal));
          else {
            try { stdout = files.stream('stdout.txt'); stderr = files.stream('stderr.txt'); }
            catch (e) { throw new BackendError(`输出保存失败，远程动作未开始：${String(e)}`, { ...details, fatal: true }); }
            details = await backends.kali.execute(args, scope.signal, (stream, data) => {
              (stream === 'stdout' ? stdout! : stderr!).write(data);
              update?.({ content: [{ type: 'text', text: `Kali · ${backends.kali.target?.host ?? '远程'}\nstdout:\n${stdout!.preview}\nstderr:\n${stderr!.preview}` }], details: { backend: 'kali', status: 'running' } });
            });
          }
        }
      } catch (e) {
        details = e instanceof BackendError ? e.details : { ...details, status: parent?.aborted ? 'interrupted' : 'error' };
        text = e instanceof Error ? e.message : String(e);
      } finally {
        scope?.dispose();
        try { stdout?.close(); stderr?.close(); }
        catch (e) { details = { ...details, fatal: true, status: 'error', error: `输出保存失败：${redact(String(e))}` }; }
      }
      if (name === 'kali' && stdout) text = `stdout:\n${stdout.preview}\nstderr:\n${stderr?.preview ?? ''}\n${details.error ?? text}`;
      details = redactStructured(details, redact, true);
      text = redact(preview(text));
      const result: AgentToolResult<any> = { content: [{ type:'text', text }], details };
      try {
        for (const file of ['snapshot.txt','evaluation.json','screenshot.png','request-body.network-request','response-body.network-response']) files.available(file);
        files.save('result.json', { ...result, isError: details.status !== 'observed', endedAt: new Date().toISOString() }); files.save('result.txt', text);
        if (localHelp) return result;
        const operation = details.operation;
        const freshObservation = !(name === 'chrome' && ['pages','network','request','screenshot'].includes(operation ?? ''));
        const kind: Evidence['kind'] = name === 'chrome' && ['open','select','click','fill'].includes(operation ?? '') ? 'mutation' : 'observation';
        const evidence = store.recordEvidence({ runId: run.id, agent: run.agent, toolCallId: callId, ...origin, tool: name, backend: name,
          status: details.status, kind, freshObservation, artifactPaths: files.paths, execution: details, outcomeKnown: details.outcome === 'completed',
          ...(typeof details.exitCode === 'number' ? { exitCode: details.exitCode } : {}),
          summary: `${name} ${operation ?? 'exec'} · ${details.pageUrl ?? details.host ?? ''} — ${details.status} / ${details.outcome}` });
        // Protocol adapters send content, not local result.details. Expose the
        // native SSH exit separately from stdout so the model need not run an
        // extra shell command or mistake a missing exit code for zero.
        const exit = name === 'kali' ? `\nExit code: ${details.exitCode ?? 'unknown'} · Signal: ${details.signal ?? 'none reported'}` : '';
        const receipt = `Agent: ${run.agent} · Session: ${run.agentSessionId} · Run: ${run.id}\nEvidence: ${evidence.id}\nTool: ${name} · Backend: ${name}\nStatus: ${details.status} · Outcome: ${details.outcome}${exit}\nKind: ${kind}\nAbsolute paths:\n${files.paths.map((p) => `${files.sessionDir}/${p}`).join('\n')}`;
        options.notice?.(receipt);
        const resultDetails = { ...details, evidenceId: evidence.id, artifactPaths: files.paths };
        if (details.fatal) {
          options.stop(redact(`${name} 暂停：${details.error ?? text}；结果 ${details.outcome}，等待用户处理后显式继续`));
          if (name === 'kali') { const message = backends?.kali.error; await backends?.kali.close(); if (backends) { backends.kali.state = 'error'; backends.kali.error = message ?? details.error; } }
        }
        if (details.status !== 'observed') throw Object.assign(new Error(`${text}\n\n${receipt}`), { details: resultDetails });
        return { content: [...result.content, { type: 'text', text: receipt }], details: resultDetails };
      } catch (e) {
        if (!(e instanceof Error && 'details' in e && (e.details as any)?.evidenceId)) options.stop(`证据保存失败：${redact(String(e))}；外部动作不会回滚`);
        throw e;
      }
    };
    return name === 'chrome' ? createChromeTool(execute) : createKaliTool(execute);
  });
}
