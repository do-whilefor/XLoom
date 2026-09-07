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
import { toolScopeDenial } from '../case/tool-scope.js';
import { isHttpCommand, type HttpObservation } from './http.js';
import { remoteHttpRequest, REMOTE_HTTP_OUTPUT_LIMIT } from './http-remote.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

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
      const denial = toolScopeDenial(store.current(), run.agent, name);
      let files: ToolArtifacts;
      try {
        files = new ToolArtifacts(store.sessionDir, run.id, toolCallRef({ toolCallId: callId, responseRef }), secrets);
        store.toolStarted(run.id, callId, name, files.relativeDir, responseRef);
        files.save('execution.json', { sessionId: store.sessionDir.split('/').at(-1), agent: run.agent, agentSessionId: run.agentSessionId,
          runId: run.id, toolCallId: callId, ...origin, tool: name, backend: name, args,
          ...(denial ? { attemptedAt: new Date().toISOString(), actionStatus: 'not_executed' } : { startedAt: new Date().toISOString() }) });
      } catch (e) { options.stop(`原始资料保存失败，动作未开始：${redact(String(e))}`); throw e; }
      if (denial) {
        try {
          files.save('result.json', { content: [{ type: 'text', text: denial.text }], details: denial.details, isError: true, endedAt: new Date().toISOString() });
          files.save('result.txt', denial.text);
        } catch (error) { options.stop(`范围拒绝回执保存失败：${redact(String(error))}`); throw error; }
        throw Object.assign(new Error(denial.text), { details: { ...denial.details, artifactPaths: files.paths } });
      }
      let details: ExternalDetails = { backend: name, status: 'error', outcome: 'not_started' };
      let text = '', localHelp = false;
      let http: HttpObservation | undefined;
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
            const native = isHttpCommand(args.command) ? remoteHttpRequest(args.command) : undefined;
            if (native) {
              http = native.incomplete();
              // The generated command is audit material; the model's requested
              // command remains intact in execution.json.
              files.save('native-http-execution.json', { command: native.command, runtime: 'python3 -I / standard-library HTTP', automaticRetries: 0 });
            }
            try { stdout = files.stream('stdout.txt'); stderr = files.stream('stderr.txt'); }
            catch (e) { throw new BackendError(`输出保存失败，远程动作未开始：${String(e)}`, { ...details, fatal: true }); }
            const wire: Buffer[] = []; let wireLength = 0;
            details = await backends.kali.execute(native ? { ...args, command: native.command } : args, scope.signal, (stream, data) => {
              (stream === 'stdout' ? stdout! : stderr!).write(data);
              if (native && stream === 'stdout') {
                wireLength += data.length;
                if (wireLength > REMOTE_HTTP_OUTPUT_LIMIT) throw new Error('原生 HTTP 执行记录超过上限');
                wire.push(Buffer.from(data));
              }
              if (!native) update?.({ content: [{ type: 'text', text: `Kali · ${backends.kali.target?.host ?? '远程'}\nstdout:\n${stdout!.preview}\nstderr:\n${stderr!.preview}` }], details: { backend: 'kali', status: 'running' } });
            });
            if (native) {
              details.operation = 'http';
              if (details.status === 'observed' && details.outcome === 'completed') {
                http = native.decode(Buffer.concat(wire, wireLength));
                if (!http.exchange.complete) details = { ...details, status: 'error', outcome: http.exchange.outcome, error: '远端 HTTP 未完成；不代表业务反证，未自动重试' };
              }
              text = http!.text;
            }
          }
        }
      } catch (e) {
        details = e instanceof BackendError ? e.details : { ...details, status: parent?.aborted ? 'interrupted' : 'error' };
        text = e instanceof Error ? e.message : String(e);
        if (http && !http.exchange.complete) {
          const outcome = details.outcome === 'not_started' ? 'not_started' : 'unknown';
          http.exchange.outcome = outcome;
          details = { ...details, operation: 'http', outcome };
        }
      } finally {
        scope?.dispose();
        try { stdout?.close(); stderr?.close(); }
        catch (e) { details = { ...details, fatal: true, status: 'error', error: `输出保存失败：${redact(String(e))}` }; }
      }
      if (name === 'kali' && stdout && !http) text = `stdout:\n${stdout.preview}\nstderr:\n${stderr?.preview ?? ''}\n${details.error ?? text}`;
      details = redactStructured(details, redact, true);
      text = redact(preview(text));
      const result: AgentToolResult<any> = { content: [{ type:'text', text }], details };
      try {
        if (http) {
          // Binary materials retain exact bytes; redacted previews are never
          // substituted for the response used by the verification preparation.
          writeFileSync(files.path('http-request.bin'), http.requestBody, { flag: 'wx', mode: 0o600 }); files.register('http-request.bin');
          writeFileSync(files.path('http-response.bin'), http.responseBody, { flag: 'wx', mode: 0o600 }); files.register('http-response.bin');
        }
        for (const file of ['snapshot.txt','evaluation.json','screenshot.png','request-body.network-request','response-body.network-response']) files.available(file);
        files.save('result.json', { ...result, isError: details.status !== 'observed', endedAt: new Date().toISOString() }); files.save('result.txt', text);
        if (localHelp) return result;
        const operation = details.operation;
        const freshObservation = !(name === 'chrome' && ['pages','network','request','screenshot'].includes(operation ?? ''));
        const kind: Evidence['kind'] = name === 'chrome' && ['open','select','click','fill'].includes(operation ?? '') ? 'mutation' : 'observation';
        const evidence = store.recordEvidence({ runId: run.id, agent: run.agent, toolCallId: callId, ...origin, tool: name, backend: name,
          status: details.status, kind, freshObservation, artifactPaths: files.paths, execution: details, outcomeKnown: details.outcome === 'completed',
          artifactSha256: Object.fromEntries(files.paths.map(path => [path, createHash('sha256').update(readFileSync(join(store.sessionDir, path))).digest('hex')])),
          ...(http ? { http: { ...http.exchange, requestArtifact: `${files.relativeDir}/http-request.bin`, responseArtifact: `${files.relativeDir}/http-response.bin` } } : {}),
          ...(typeof details.exitCode === 'number' ? { exitCode: details.exitCode } : {}),
          summary: `${name} ${operation ?? 'exec'} · ${http?.exchange.url ?? details.pageUrl ?? details.host ?? ''} — ${details.status} / ${details.outcome}` });
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
