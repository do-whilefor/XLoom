import { createHash } from 'node:crypto';
import { appendFileSync, constants, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createReadTool, createWriteTool, createEditTool } from '../vendor/pi/coding-agent/core/tools/index.js';
import { createBashTool } from '../tools/bash.js';
import { createLocalBashOperations } from '../vendor/pi/coding-agent/core/tools/bash.js';
import { detectSupportedImageMimeTypeFromFile } from '../vendor/pi/coding-agent/utils/mime.js';
import type { AgentTool, AgentToolResult } from '../vendor/pi/agent/types.js';
import { BlackboardStore } from './store.js';
import type { Evidence, RunRecord, ToolName } from './types.js';
import { toolCallRef } from './types.js';
import { recordedExternalTools, type RecordingOptions } from '../tools/recorded-external.js';

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
      const targetPath = typeof args.path === 'string' ? actualPath(resolve(cwd, args.path.replace(/^~(?=\/)/, process.env.HOME ?? '~'))) : undefined;
      const sessionsRoot = actualPath(resolve(store.sessionDir, '..'));
      const internal = (path: string) => path === sessionsRoot || path.startsWith(sessionsRoot + sep);
      const generated = Object.values(store.current().evidence).flatMap((e) => [...(e.generatedPath ? [e.generatedPath] : []), ...(e.derivedPaths ?? [])]);
      const command = String(args.command ?? '');
      const derived = name === 'read' ? !!targetPath && (internal(targetPath) || generated.includes(targetPath)) : name === 'bash' &&
        (command.includes(sessionsRoot) || /(?:blackboard\/(?:view\.md|events\.jsonl)|agents\/(?:probe|proof)\.jsonl)/.test(command) || generated.some((p) => command.includes(p) || command.includes(basename(p))));
      // Mutation receipts are not content validation. Prose reports produced by the model stay derived on read-back.
      const generatedConclusion = name === 'write' && typeof args.content === 'string' &&
        (/\.(?:md|markdown|rst)$/i.test(targetPath ?? '') || /(?:结论|漏洞确认|审计报告|已确认漏洞|conclusion|finding|vulnerability confirmed)/i.test(args.content));
      let failure: unknown; let result: AgentToolResult<any>;
      let recordError: unknown;
      const pendingReads: Promise<Buffer>[] = [];
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        store.toolStarted(run.id, callId, name, artifactPath, responseRef);
        save('execution.json', JSON.stringify({ runId: run.id, agent: run.agent, agentSessionId: run.agentSessionId, toolCallId: callId, ...origin, tool: name, args, startedAt: new Date().toISOString() }, null, 2));
        if ((name === 'write' || name === 'edit') && targetPath && internal(targetPath)) throw new Error('会话与证据文件由程序维护，不允许通过模型工具修改');
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
            const pending = readFile(path).then((bytes) => { raw('raw-read.bin', bytes); return bytes; });
            pendingReads.push(pending); return pending;
          },
        } }) : name === 'bash' ? createBashTool(cwd, { operations: {
          exec: (command, directory, settings) => localBash.exec(command, directory, { ...settings,
            onData: (data) => { raw('raw-output.txt', data); settings.onData(data); } }),
        } }) : base;
        result = await (tool as AgentTool<any>).execute(callId, args, signal, (partial) => {
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
          summary: `${name} ${targetPath ?? command.slice(0, 160)} — ${status}`,
          ...(targetPath ? { targetPath } : {}), ...(generatedConclusion && targetPath ? { generatedPath: targetPath } : {}),
          ...(derived && name === 'bash' ? { derivedPaths: materialFiles(command, cwd) } : {}),
          ...(typeof details.exitCode === 'number' ? { exitCode: details.exitCode, outcomeKnown: status !== 'interrupted' } : {}) });
        const receipt = `Agent: ${run.agent} · Session: ${run.agentSessionId} · Run: ${run.id}\nEvidence: ${evidence.id}\nTool: ${name}\nStatus: ${status}\nKind: ${evidence.kind}\nAbsolute path: ${join(dir, 'result.txt')}`;
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
