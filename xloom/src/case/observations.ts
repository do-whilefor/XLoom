import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { initialHttpExchange, parseHttpCommand, parseStrictJson, HTTP_RESPONSE_LIMIT, HTTP_REQUEST_LIMIT } from '../tools/http.js';
import { hasToolSource, verificationBinding, type BoardState, type CheckedObservation, type Evidence, type Hypothesis } from './types.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const emptyCredentials = hash('[]');
const ensure: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`HTTP观察绑定：${message}`);
};
class ObservationUnavailable extends Error {}
const available: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new ObservationUnavailable(message);
};
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), '需要完整JSON对象，不能使用预览/回显文字');
  return value as RecordValue;
}
/** Bounded RFC6901 traversal; no expression execution or permissive coercion. */
export function scalarAt(value: unknown, pointer: string): string | number | boolean | null {
  ensure(pointer.length <= 256 && (pointer === '' || pointer.startsWith('/')), '非法JSON pointer');
  let cursor: unknown = value;
  for (const encoded of pointer === '' ? [] : pointer.slice(1).split('/')) {
    ensure(!/~(?![01])/.test(encoded), '非法JSON pointer转义');
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    ensure(cursor !== null && typeof cursor === 'object' && Object.hasOwn(cursor, key), 'JSON位置缺失');
    cursor = (cursor as RecordValue)[key];
  }
  ensure(cursor === null || ['string', 'number', 'boolean'].includes(typeof cursor), '位置必须是严格标量');
  return cursor as string | number | boolean | null;
}

/** Commit/recovery preparation only. Never called from a pure replay reducer. */
export function prepareHttpObservation(sessionDir: string, board: BoardState, h: Hypothesis): CheckedObservation {
  const a = h.httpAssertion, v = h.verification, o = v?.observations;
  ensure(a && v && o, '影响/路径确认需要既有httpAssertion和本次observations；普通stdout不能替代目标实验');
  ensure(a.kind === 'http-owner-read' && a.actor !== a.owner, '首版只支持声明的不同身份私有对象读取契约');
  const origin = new URL(a.origin);
  ensure(['http:', 'https:'].includes(origin.protocol) && origin.origin === a.origin, 'origin必须是无路径/认证/查询的HTTP源');
  for (const path of [a.resourcePath, a.conditionsPath, a.identityPath]) {
    const url = new URL(path, origin);
    ensure(path.startsWith('/') && url.origin === a.origin && !url.search && !url.hash && url.pathname === path,
      '契约端点必须是同源固定路径，不支持用户输入查询回显作为语义来源');
  }
  ensure(!['', '/success', '/actor', '/identity', '/subject', '/owner', '/object', '/status'].includes(a.valuePointer), '身份/状态/成功标记不能单独充当私有内容');
  const run = board.runs[v.runId];
  ensure(run?.agent === 'proof' && run.agentSessionId !== board.agentSessions.probe, '需要独立Proof来源');
  const evidenceIds = new Set(v.factIds.flatMap((id) => board.facts[id]?.evidenceIds ?? []));
  const evidence: CheckedObservation['evidence'] = {};
  const edgeIds: string[] = [];
  const checked = (result: CheckedObservation['result'], reason?: string): CheckedObservation => ({
    version: 1, binding: verificationBinding(board, h), evidence, edgeIds, result, ...(reason ? { reason } : {}),
  });
  try {
  const cache = new Map<string, { e: Evidence; response: RecordValue; request: unknown }>();
  let sshEndpoint: string | undefined;
  const material = (e: Evidence, path: string, expected: string | undefined, limit: number) => {
    ensure(e.artifactPaths.includes(path), '材料不属于所引用Evidence');
    const base = realpathSync(sessionDir), file = realpathSync(resolve(sessionDir, path));
    ensure(file.startsWith(base + sep), '材料不得跨Case或逃逸会话目录');
    const bytes = readFileSync(file);
    ensure(bytes.length <= limit && (expected === undefined || hash(bytes) === expected), '原始材料缺失、摘要不符或超限');
    return bytes;
  };
  const get = (id: string) => {
    const cached = cache.get(id); if (cached) return cached;
    const e = board.evidence[id], http = e?.http;
    ensure(evidenceIds.has(id) && e && e.agent === 'proof' && e.runId === run.id && hasToolSource(run, e) &&
      run.evidenceIds.includes(id) && e.kind === 'observation', '所有绑定须来自本次Proof、进入verification Fact链的实际观察');
    ensure(http?.version === 1, '缺少支持版本的原生HTTP请求/响应记录；普通shell、复读材料不可确认');
    const transport = (http as typeof http & { transport?: 'local' | 'ssh' }).transport ?? 'local';
    ensure(transport === 'local' ? (a.backend ?? 'local') === 'local' && e.tool === 'bash' && e.backend === 'local' : transport === 'ssh' && a.backend === 'kali' && e.tool === 'kali' && e.backend === 'kali' &&
      e.execution?.backend === 'kali' && e.execution.outcome === 'completed', '原生HTTP传输与实际工具/后端来源不符');
    if (transport === 'ssh') {
      ensure(e.execution?.host && Number.isInteger(e.execution.port) && e.execution.username, 'SSH观察缺少实际主机、端口或账户来源');
      const endpoint = JSON.stringify([e.execution.host, e.execution.port, e.execution.username]);
      ensure(sshEndpoint === undefined || endpoint === sshEndpoint, 'SSH观察不能拼接不同主机或账户的同名目标'); sshEndpoint = endpoint;
    }
    available(e.status === 'observed' && http.complete && http.outcome === 'completed', '目标动作失败或中断，结果未知，不能作为反证或影响确认');
    const url = new URL(http.url);
    ensure(url.origin === a.origin && !url.search && !url.hash, 'HTTP观察与既有目标源/路径条件不符');
    ensure([http.requestBodySha256, http.responseBodySha256].every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)),
      'HTTP请求/响应原始材料必须带有效SHA256摘要；仅旧执行元数据的artifact摘要可缺省');
    const requestBytes = material(e, http.requestArtifact, http.requestBodySha256, HTTP_REQUEST_LIMIT);
    const responseBytes = material(e, http.responseArtifact, http.responseBodySha256, HTTP_RESPONSE_LIMIT);
    const item = { e, request: requestBytes.length ? parseStrictJson(requestBytes) : null, response: object(parseStrictJson(responseBytes)) };
    evidence[id] = { request: http.requestBodySha256, response: http.responseBodySha256 }; cache.set(id, item); return item;
  };
  const at = (id: string, path: string, method?: 'GET' | 'POST') => {
    const item = get(id), http = item.e.http!;
    ensure(new URL(http.url).pathname === path && (!method || http.method === method), '观察端点或实际方法不匹配');
    return item;
  };
  const ok = (id: string) => { const item = get(id); available(item.e.http!.status === 200, '必要前提尚未得到HTTP 200支持，403不能解释为成功或前提已满足'); return item; };
  const deny = (id: string) => { const item = get(id); available([401, 403].includes(item.e.http!.status ?? 0), '需要可解释的401/403独立拒绝对照'); return item; };
  const required = (id: string | undefined, name: string) => { available(typeof id === 'string' && !!id, `缺少${name}观察，保持未知`); return id; };
  const credential = (id: string) => get(id).e.http!.credentialFingerprint;
  // These headers are excluded from credential identity by the native recorder.
  // They still influence application behavior, so controls must hold them fixed.
  const nonCredentialHeaders = ['accept', 'accept-encoding', 'content-type', 'x-xloom-agent', 'x-xloom-backend', 'content-length', 'host', 'connection'];
  const comparable = (left: string, right: string) => {
    const a = get(left).e.http!, b = get(right).e.http!;
    available(a.method === b.method && a.requestBodySha256 === b.requestBodySha256 &&
      nonCredentialHeaders.every(name => a.requestHeaderHashes[name] === b.requestHeaderHashes[name]),
      '对照与实际实验的非凭据输入不同，拒绝可能来自请求校验而非权限，保持未知');
  };
  const policy = at(o.policy, a.conditionsPath, 'GET'); ok(o.policy);
  ensure(policy.request === null && credential(o.policy) === emptyCredentials, '策略语义须来自无用户可控输入的服务端条件观察');
  available(policy.response.object === a.object && policy.response.owner === a.owner &&
    (policy.response.policy ?? policy.response.accessPolicy) === 'owner-only', '对象/归属/私有策略不匹配；公共授权解释不能确认越权');
  const complete = !v.pathCheck || v.pathCheck.complete;
  const full = complete || v.verdict === 'rejected';
  const ownerId = full ? required(o.ownerIdentity, '所有者身份') : undefined;
  for (const [id, actor] of [[o.actorIdentity, a.actor], ...(ownerId ? [[ownerId, a.owner]] : [])] as Array<[string, string]>) {
    const identity = at(id, a.identityPath, 'GET'); ok(id);
    available(identity.request === null && identity.response.identity === actor && identity.response.authenticated !== false,
      '需要匹配的服务端身份观察，声明字段不能替代认证对照');
  }
  const invalidIdentity = at(o.invalidIdentity, a.identityPath, 'GET'); deny(o.invalidIdentity);
  available(invalidIdentity.request === null, '非法身份对照必须无请求体，输入校验拒绝不能证明认证');
  comparable(o.actorIdentity, o.invalidIdentity);
  if (ownerId) comparable(ownerId, o.invalidIdentity);
  const actorCredential = credential(o.actorIdentity), ownerCredential = ownerId ? credential(ownerId) : undefined;
  available(actorCredential !== emptyCredentials && credential(o.invalidIdentity) !== actorCredential &&
    (!ownerId || (ownerCredential !== actorCredential && ownerCredential !== emptyCredentials && credential(o.invalidIdentity) !== ownerCredential)),
    '必须建立不同身份及错误/无凭据身份拒绝，回显不自证身份');
  const subjects = new Map([[actorCredential, a.actor]]);
  const checkImpact = (): CheckedObservation['result'] => {
  const allowedId = required(o.allowed, '所有者基线'), deniedId = required(o.denied, '匿名资源对照'), testId = required(o.test, '实际终点');
  const allowed = at(allowedId, a.resourcePath), denied = at(deniedId, a.resourcePath), observed = at(testId, a.resourcePath);
  ok(allowedId); deny(deniedId);
  ensure(credential(allowedId) === ownerCredential && subjects.has(credential(testId)) && credential(deniedId) === emptyCredentials,
    '资源实验凭据与真实身份/匿名对照不匹配');
  ensure(allowed.e.http!.method === observed.e.http!.method && denied.e.http!.method === observed.e.http!.method, '资源对照必须使用相同方法');
  comparable(allowedId, testId); comparable(deniedId, testId);
  available(allowed.response.object === a.object && allowed.response.owner === a.owner, '所有者基线不是当前对象');
  available(observed.response.object === undefined || observed.response.object === a.object, '测试结果属于其他对象，不能反驳或确认当前对象');
  available(observed.response.owner === undefined || observed.response.owner === a.owner, '测试对象归属发生变化，保持未知');
  if (policy.response.state !== undefined) available(allowed.response.state === policy.response.state && observed.response.state === policy.response.state,
    '对象状态与本次策略前提不一致或缺失，状态失效不能作为反证');
  const value = scalarAt(allowed.response, a.valuePointer);
  ensure(typeof value === 'string' && value.length > 0, '首版需要非空私有内容，布尔成功/HTTP状态不是影响');
  // A finite origin exclusion: copied bytes remain request-controlled when
  // taken from a JSON key or from part of a scalar, not only from a whole value.
  // This does not attempt to recognize arbitrary encodings or transformations.
  const containsValue = (input: unknown): boolean => {
    if (Array.isArray(input)) return input.some(containsValue);
    if (input !== null && typeof input === 'object') return Object.entries(input).some(([key, item]) => key.includes(value) || containsValue(item));
    return String(input).includes(value);
  };
  ensure(![allowed, observed].some(item => item.e.http!.requestBodySha256 !== hash('') && containsValue(item.request)),
    '请求输入回显不能充当私有内容');
  const headerValues = (e: Evidence): string[] => {
    const path = e.artifactPaths.find(path => /(?:^|\/)execution\.json$/.test(path));
    ensure(path, '缺少原始HTTP执行参数，无法核对请求头内容来源');
    const execution = object(parseStrictJson(material(e, path, e.artifactSha256?.[path], 2 * HTTP_REQUEST_LIMIT + 128 * 1024)));
    const args = object(execution.args);
    ensure(execution.tool === e.tool && typeof args.command === 'string', '原始HTTP执行参数与工具来源不符');
    const input = parseHttpCommand(args.command), http = e.http!;
    const reconstructed = initialHttpExchange(input, http.transport ?? 'local');
    // Older records lack a digest for execution.json. Its reconstructed fields
    // still must match every recorder-owned request/header fingerprint; raw
    // metadata alone cannot replace the actual request identity.
    ensure(reconstructed.url === http.url && reconstructed.method === http.method &&
      reconstructed.requestBodySha256 === http.requestBodySha256 && reconstructed.credentialFingerprint === http.credentialFingerprint &&
      Object.keys(reconstructed.requestHeaderHashes).length === Object.keys(http.requestHeaderHashes).length &&
      Object.entries(reconstructed.requestHeaderHashes).every(([name, digest]) => http.requestHeaderHashes[name] === digest),
      '原始HTTP参数与已记录的请求/凭据/请求头摘要不一致');
    return Object.entries({ ...input.headers, host: input.url.host, connection: 'close', 'content-length': String(input.body.length) }).flat();
  };
  ensure(![allowed, observed].some(item => headerValues(item.e).some(header => header.includes(value))),
    '请求头回显不能充当私有内容');
  const status = observed.e.http!.status;
  available(status === 200 || status === 401 || status === 403, '终点不是支持范围内的正常结果或拒绝，能力/服务不可用保持未知');
  if (status === 401 || status === 403) return 'mismatch';
  else {
    available(observed.response.object === a.object && observed.response.owner === a.owner, '测试结果未提供当前对象和归属，保持未知');
    const observedValue = scalarAt(observed.response, a.valuePointer);
    return observedValue === value ? 'match' : 'mismatch';
  }
  };
  // Neither a response echo nor owner HTTP200 is sufficient: the conditions,
  // authenticated identities, invalid identity, and anonymous resource denial
  // above are mandatory parts of this explicitly limited application contract.
  if (v.pathCheck) {
    const path = board.attackPaths[v.pathCheck.pathId], transfers = o.transfers ?? [];
    ensure(path && transfers.length === v.pathCheck.edgeIds.length && new Set(transfers.map((t) => t.edgeId)).size === transfers.length,
      '每条所确认连接必须有独立对应的实际传递绑定');
    // Dependency order comes from the declared main path, not array ordering.
    const orderedTransfers = [...transfers].sort((left, right) => path.nodeIds.indexOf(path.edges.find((edge) => edge.id === left.edgeId)?.from ?? '') -
      path.nodeIds.indexOf(path.edges.find((edge) => edge.id === right.edgeId)?.from ?? ''));
    for (const transfer of orderedTransfers) {
      const edge = path.edges.find((e) => e.id === transfer.edgeId);
      ensure(edge?.relation === 'enables' && v.pathCheck.edgeIds.includes(edge.id), '传递必须绑定当前路径的已声明enables边');
      const from = ok(transfer.from), to = get(transfer.to);
      const rejectedEndpoint = v.verdict === 'rejected' && transfer.to === o.test && [401, 403].includes(to.e.http!.status ?? 0);
      if (!rejectedEndpoint) ok(transfer.to);
      const fromSubject = subjects.get(credential(transfer.from));
      ensure(transfer.from !== transfer.to && fromSubject && from.response.subject === fromSubject && from.response.object === a.object &&
        (to.response.object === a.object || (rejectedEndpoint && to.response.object === undefined)),
        '路径返回的主体或对象不相容，或缺少前一步身份依据');
      ensure(to.e.http!.method === 'POST' && Date.parse(from.e.http!.endedAt) <= Date.parse(to.e.http!.startedAt), '能力必须先取得再实际传入后继请求');
      const output = scalarAt(from.response, transfer.outputPointer);
      ensure(typeof output === 'string' && output.length > 0, '前一步产物必须为实际非空字符串');
      if (transfer.delegation) {
        const identity = at(transfer.delegation.identity, a.identityPath, 'GET'); ok(transfer.delegation.identity);
        const invalid = at(transfer.delegation.invalidIdentity, a.identityPath, 'GET'); deny(transfer.delegation.invalidIdentity);
        comparable(transfer.delegation.identity, transfer.delegation.invalidIdentity);
        const toSubject = identity.response.identity;
        available(identity.request === null && invalid.request === null && typeof toSubject === 'string' && toSubject !== fromSubject && toSubject !== a.owner &&
          identity.response.authenticated !== false, '委派身份前提不匹配，不能推断身份转换');
        const declared = policy.response.delegations;
        available(Array.isArray(declared) && declared.some((entry) => entry && typeof entry === 'object' &&
          entry.from === fromSubject && entry.to === toSubject && entry.object === a.object) && from.response.delegatesTo === toSubject,
          '策略与前一步产物没有给出当前对象的相容身份委派依据');
        const toCredential = credential(transfer.to);
        ensure(toCredential !== credential(transfer.from) && toCredential === credential(transfer.delegation.identity) &&
          ![toCredential, credential(transfer.from)].includes(credential(transfer.delegation.invalidIdentity)), '委派身份及非法凭据对照来源不匹配');
        ensure(identity.e.http!.requestHeaderHashes.authorization === hash('Bearer ' + output) &&
          to.e.http!.requestHeaderHashes.authorization === hash('Bearer ' + output), '委派token没有实际用于后一步Bearer认证');
        available(Date.parse(from.e.http!.endedAt) <= Date.parse(identity.e.http!.startedAt) &&
          (to.response.subject === toSubject || (rejectedEndpoint && to.response.subject === undefined)),
          '委派身份观察发生在token取得前，或后继响应身份不匹配');
        subjects.set(toCredential, toSubject);
      } else {
        ensure(credential(transfer.to) === credential(transfer.from) &&
          (to.response.subject === fromSubject || (rejectedEndpoint && to.response.subject === undefined)),
          '路径主体不连续；身份变化需要显式且有依据的委派检查');
        const input = scalarAt(to.request, required(transfer.inputPointer, '连接输入位置'));
        ensure(output === input, '前一步产物与后一步实际请求输入不匹配');
      }
      ensure(edge.evidenceIds.includes(transfer.from) && edge.evidenceIds.includes(transfer.to), '路径边未引用本次实际前后观察');
      const nodeEvidence = (id: string) => (board.facts[id] ? [board.facts[id]] : (board.hypotheses[id]?.factIds ?? []).map((id) => board.facts[id])).flatMap((f) => f?.evidenceIds ?? []);
      ensure(nodeEvidence(edge.from).includes(transfer.from) && nodeEvidence(edge.to).includes(transfer.to), '路径节点事实与本次传递输入/输出不匹配');
      if (policy.response.state !== undefined) available(from.response.state === policy.response.state && to.response.state === policy.response.state, '路径对象状态已变化');
      edgeIds.push(edge.id);
    }
    for (const previous of transfers) {
      const before = path.edges.find((e) => e.id === previous.edgeId)!;
      for (const next of transfers) {
        const after = path.edges.find((e) => e.id === next.edgeId)!;
        if (before.to === after.from) ensure(previous.to === next.from,
          '相邻连接必须共享同一次实际中间观察，不能拼接各自成功但不连续的片段');
      }
    }
    if (complete || v.verdict === 'rejected') {
      const finalNode = path.nodeIds.at(-1), previousNode = path.nodeIds.at(-2);
      const finalEdge = path.edges.find((edge) => edge.from === previousNode && edge.to === finalNode && edge.relation === 'enables');
      ensure(finalEdge && transfers.find((transfer) => transfer.edgeId === finalEdge.id)?.to === o.test, '完整路径的最后连接必须到达本次实际终点观察');
    }
  } else ensure(!o.transfers?.length, '单点不能夹带未绑定路径的连接确认');
  return checked(full ? checkImpact() : 'match');
  } catch (error) {
    if (error instanceof ObservationUnavailable) return checked('unavailable', error.message);
    throw error;
  }
}
