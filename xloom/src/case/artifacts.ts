import { createHash } from 'node:crypto';
import { appendFileSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadTool, createWriteTool, createEditTool } from '../vendor/pi/coding-agent/core/tools/index.js';
import { createBashTool } from '../tools/bash.js';
import { executeHttp, isHttpCommand, HttpExecutionError } from '../tools/http.js';
import { createLocalBashOperations } from '../vendor/pi/coding-agent/core/tools/bash.js';
import { detectSupportedImageMimeTypeFromFile } from '../vendor/pi/coding-agent/utils/mime.js';
import type { AgentTool, AgentToolResult } from '../vendor/pi/agent/types.js';
import { BlackboardStore } from './store.js';
import type { Evidence, RunRecord, ToolName } from './types.js';
import { toolCallRef } from './types.js';
import { recordedExternalTools, type RecordingOptions } from '../tools/recorded-external.js';
import { toolScopeDenial } from './tool-scope.js';
import { assertContextIndexRead, checkEvidenceMaterials } from './context-index.js';

const actualPath = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const safeSegment = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');

// Retain visible file operands of an operation on already-derived material.
// This follows ordinary copies/redirections across calls; it does not interpret
// arbitrary shell programs or decide independence by comparing output hashes.
function materialFiles(command: string, cwd: string): string[] {
  const files = [...command.matchAll(/'([^']*)'|"([^"]*)"|([^\s<>|;&()]+)/g)].flatMap((match) => {
    const value = match[1] ?? match[2] ?? match[3];
    if (!value || value.startsWith('-')) return [];
    const path = actualPath(resolve(cwd, value.replace(/^~(?=\/)/, process.env.HOME ?? '~')));
    try { return statSync(path).isFile() ? [path] : []; } catch { return []; }
  });
  return [...new Set(files)];
}

/** Fixed recording in the four actual tools, with no hook registry or new model tool. */
export function recordedTools(options: RecordingOptions & { cwd: string }): AgentTool<any>[] {
  const { cwd, store, run } = options;
  const localBash = createLocalBashOperations();
  const local = (['read', 'write', 'edit', 'bash'] as const).map((name) => {
    const base = name === 'read' ? createReadTool(cwd) : name === 'write' ? createWriteTool(cwd) : name === 'edit' ? createEditTool(cwd) : createBashTool(cwd);
    return { ...base, execute: async (callId: string, rawArgs: unknown, signal?: AbortSignal, update?: (value: AgentToolResult<any>) => void) => {
      const args = rawArgs as Record<string, unknown>; // Pi validated the schema before this fixed recorder.
      const responseRef = options.responseRef?.();
      const origin = responseRef ? { responseRef } : {};
      signal?.throwIfAborted();
      if (store.current().runs[run.id].toolCallIds.length >= options.maxToolCalls) {
        const reason = `达到每 Run 工具调用上限 ${options.maxToolCalls}；后续工具未执行`;
        options.stop(reason); throw new Error(reason);
      }
      const artifactPath = `artifacts/${run.id}/${safeSegment(toolCallRef({ toolCallId: callId, responseRef }))}`;
      const dir = join(store.sessionDir, artifactPath);
      const paths: string[] = [];
      const save = (file: string, content: string | Buffer) => {
        writeFileSync(join(dir, file), content, { flag: 'wx', mode: 0o600 }); paths.push(`${artifactPath}/${file}`);
      };
      // Read the current rule for every call, before resolving or touching its
      // target. Only the program-owned attempt/result audit is written here.
      const denial = toolScopeDenial(store.current(), run.agent, name);
      if (denial) {
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          store.toolStarted(run.id, callId, name, artifactPath, responseRef);
          save('execution.json', JSON.stringify({ runId: run.id, agent: run.agent, agentSessionId: run.agentSessionId,
            toolCallId: callId, ...origin, tool: name, args, attemptedAt: new Date().toISOString(), actionStatus: 'not_executed' }, null, 2));
          save('result.json', JSON.stringify({ content: [{ type: 'text', text: denial.text }], details: denial.details,
            isError: true, status: 'not_executed', endedAt: new Date().toISOString() }, null, 2));
          save('result.txt', denial.text);
        } catch (error) { options.stop(`工具范围拒绝记录保存失败：${String(error)}`); throw error; }
        options.notice?.(denial.text);
        throw Object.assign(new Error(denial.text), { details: { ...denial.details, artifactPaths: paths } });
      }
      const requestedPath = typeof args.path === 'string' ? resolve(cwd, args.path.replace(/^~(?=\/)/, process.env.HOME ?? '~')) : undefined;
      const targetPath = requestedPath === undefined ? undefined : actualPath(requestedPath);
      const sessionsRoot = actualPath(resolve(store.sessionDir, '..'));
      const promptsRoot = actualPath(fileURLToPath(new URL('../prompts/', import.meta.url)));
      const internal = (path: string) => [sessionsRoot, promptsRoot].some((root) => path === root || path.startsWith(root + sep));
      const generated = Object.values(store.current().evidence).flatMap((e) => [...(e.generatedPath ? [e.generatedPath] : []), ...(e.derivedPaths ?? [])]);
      const command = String(args.command ?? '');
      const derived = name === 'read' ? !!targetPath && (internal(targetPath) || !!requestedPath && internal(requestedPath) || generated.includes(targetPath)) : name === 'bash' &&
        (command.includes(sessionsRoot) || command.includes(promptsRoot) || /(?:blackboard\/(?:view\.md|events\.jsonl)|agents\/(?:probe|proof)\.jsonl)/.test(command) || materialFiles(command, cwd).some(internal) || generated.some((p) => command.includes(p) || command.includes(basename(p))));
      // Mutation receipts are not content validation. Prose reports produced by the model stay derived on read-back.
      const generatedConclusion = name === 'write' && typeof args.content === 'string' &&
        (/\.(?:md|markdown|rst)$/i.test(targetPath ?? '') || /(?:结论|漏洞确认|审计报告|已确认漏洞|conclusion|finding|vulnerability confirmed)/i.test(args.content));
      let failure: unknown; let result: AgentToolResult<any>;
      let http: Evidence['http'];
      let recordError: unknown;
      const pendingReads: Promise<Buffer>[] = [];
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        store.toolStarted(run.id, callId, name, artifactPath, responseRef);
        save('execution.json', JSON.stringify({ runId: run.id, agent: run.agent, agentSessionId: run.agentSessionId, toolCallId: callId, ...origin, tool: name, args, startedAt: new Date().toISOString() }, null, 2));
        if ((name === 'write' || name === 'edit') && targetPath && (internal(targetPath) || !!requestedPath && internal(requestedPath))) throw new Error('会话与证据文件由程序维护，不允许通过模型工具修改');
        const raw = (file: string, data: Buffer) => {
          try {
            if (!paths.includes(`${artifactPath}/${file}`)) { save(file, data); }
            else appendFileSync(join(dir, file), data);
          } catch (error) { recordError = error; options.stop(`原始输出保存失败：${String(error)}`); }
        };
        const tool = name === 'read' ? createReadTool(cwd, { operations: {
          access: (path) => access(path, constants.R_OK), detectImageMimeType: detectSupportedImageMimeTypeFromFile,
          readFile: (path) => {
            signal?.throwIfAborted();
            assertContextIndexRead(path);
            assertContextIndexRead(actualPath(path));
            for (const evidence of Object.values(store.current().evidence)) if (evidence.artifactPaths.some(p => actualPath(resolve(store.sessionDir, p)) === actualPath(path))) checkEvidenceMaterials(evidence, store.sessionDir);
            const pending = readFile(path).then((bytes) => { raw('raw-read.bin', bytes); return bytes; });
            pendingReads.push(pending); return pending;
          },
        } }) : name === 'bash' ? createBashTool(cwd, { operations: {
          exec: (command, directory, settings) => localBash.exec(command, directory, { ...settings,
            onData: (data) => { raw('raw-output.txt', data); settings.onData(data); } }),
        } }) : base;
        if (name === 'bash' && isHttpCommand(command)) {
          try {
            const observed = await executeHttp(command, signal);
            save('http-request.bin', observed.requestBody); save('http-response.bin', observed.responseBody);
            http = { ...observed.exchange, requestArtifact: `${artifactPath}/http-request.bin`, responseArtifact: `${artifactPath}/http-response.bin` };
            result = { content: [{ type: 'text', text: observed.text }], details: { exitCode: 0, http: observed.exchange } };
          } catch (error) {
            if (error instanceof HttpExecutionError) {
              save('http-request.bin', error.requestBody); save('http-response.bin', error.responseBody);
              http = { ...error.partialExchange, requestArtifact: `${artifactPath}/http-request.bin`, responseArtifact: `${artifactPath}/http-response.bin` };
            }
            throw error;
          }
        } else result = await (tool as AgentTool<any>).execute(callId, args, signal, (partial) => {
          try {
            if (!paths.includes(`${artifactPath}/partial.jsonl`)) save('partial.jsonl', JSON.stringify(partial) + '\n');
            else appendFileSync(join(dir, 'partial.jsonl'), JSON.stringify(partial) + '\n');
          }
          catch (error) { recordError = error; options.stop(`部分输出保存失败：${String(error)}`); }
          update?.(partial);
        });
        if (name === 'read' && options.supportsImages === false && result.content.some((block) => block.type === 'image')) {
          result = { ...result, content: [{ type: 'text', text: `当前模型不支持图像输入。图像文件已保留：${targetPath}；未向模型发送图像或 base64。请使用可用文本资料。` }],
            details: { ...result.details, imageNotProvided: true, imagePath: targetPath } };
        }
      } catch (error) {
        failure = error;
        result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          details: error instanceof Error && 'details' in error ? error.details : {} };
      }
      // Pi may report read cancellation before its in-flight filesystem read settles.
      // Finish recording those bytes before freezing this execution's artifacts.
      await Promise.allSettled(pendingReads);
      let nonExecutionSaved = false;
      try {
        if (recordError) throw recordError;
        const details = (result.details ?? {}) as { exitCode?: number | null; status?: string };
        if (details.status === 'not_executed') {
          // Keep the attempted call/result for audit and the existing Run budget.
          // A rejected placeholder observed no target and must not mint Evidence.
          const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          save('result.json', JSON.stringify({ ...result, isError: true, status: 'not_executed', endedAt: new Date().toISOString() }, null, 2));
          save('result.txt', text);
          nonExecutionSaved = true;
          options.notice?.(`Agent: ${run.agent} · Run: ${run.id} · bash 未执行（占位命令）；未生成 Evidence`);
          throw Object.assign(new Error(text), { details: { ...result.details, artifactPaths: paths } });
        }
        const status: Evidence['status'] = signal?.aborted || details.status === 'interrupted' ? 'interrupted' : failure ? 'error' : 'observed';
        const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        save('result.json', JSON.stringify({ ...result, isError: !!failure, status, endedAt: new Date().toISOString() }, null, 2));
        save('result.txt', text);
        const evidence = store.recordEvidence({ runId: run.id, agent: run.agent, toolCallId: callId, ...origin, tool: name as ToolName, backend: 'local',
          status, kind: derived ? 'derived' : ['write', 'edit'].includes(name) ? 'mutation' : 'observation', artifactPaths: paths,
          artifactSha256: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(store.sessionDir, path))).digest('hex')])),
          summary: http ? `HTTP ${http.method} ${http.url} — ${http.status ?? 'unknown'} / ${status}` : `${name} ${targetPath ?? command.slice(0, 160)} — ${status}`,
          ...(targetPath ? { targetPath } : {}), ...(generatedConclusion && targetPath ? { generatedPath: targetPath } : {}),
          ...(derived && name === 'bash' ? { derivedPaths: materialFiles(command, cwd) } : {}),
          ...(http ? { http, outcomeKnown: http.outcome === 'completed' } : {}),
          ...(typeof details.exitCode === 'number' ? { exitCode: details.exitCode, outcomeKnown: status !== 'interrupted' } : {}) });
        let policyFeedback = '';
        if (http?.method === 'GET' && http.credentialFingerprint !== createHash('sha256').update('[]').digest('hex')) {
          const current = store.current(), intent = current.intents[run.intentId];
          const assertion = intent?.kind === 'verify' && intent.verifiesHypothesisId ? current.hypotheses[intent.verifiesHypothesisId]?.httpAssertion : undefined;
          const url = new URL(http.url);
          if (assertion && url.origin === assertion.origin && url.pathname === assertion.conditionsPath) {
            const command = 'xloom-http ' + JSON.stringify({ url: assertion.origin + assertion.conditionsPath, method: 'GET' });
            policyFeedback = `\nHTTP policy 提示：本次条件观察使用了凭据，不能作为 observations.policy。请实际执行 ${command}，不传 headers（或 headers:{}），取得无凭据条件 Evidence 后再最终提交。`;
          }
        }
        const receipt = `Agent: ${run.agent} · Session: ${run.agentSessionId} · Run: ${run.id}\nEvidence: ${evidence.id}\nTool: ${name}\nStatus: ${status}\nKind: ${evidence.kind}\nAbsolute path: ${join(dir, 'result.txt')}${policyFeedback}`;
        // The compact model receipt needs one directly readable path. Retain
        // the shorter relative path in the TUI notice so narrow screens can
        // display the whole artifact reference without splitting its call ID.
        options.notice?.(receipt.replace('\nAbsolute path:', `\nArtifact: ${artifactPath}/result.txt\nAbsolute path:`));
        if (failure) throw Object.assign(new Error(`${text}\n\n${receipt}`), { details: { ...result.details, evidenceId: evidence.id, artifactPaths: paths } });
        return { ...result, content: [...result.content, { type: 'text' as const, text: receipt }], details: { ...result.details, evidenceId: evidence.id, artifactPaths: paths } };
      } catch (error) {
        if (!nonExecutionSaved && !(error instanceof Error && 'details' in error && (error.details as { evidenceId?: string }).evidenceId)) options.stop(`证据保存失败：${String(error)}`);
        throw error;
      }
    } };
  });
  return [...local, ...recordedExternalTools(options)];
}
