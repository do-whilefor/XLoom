import type { ExternalDetails } from '../case/types.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export class BackendError extends Error {
  constructor(message: string, readonly details: ExternalDetails) { super(message); }
}
export function deadline(parent: AbortSignal | undefined, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason ?? new Error('用户取消'));
  if (parent?.aborted) cancel(); else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`工具超时 ${timeoutMs}ms；外部结果可能未知`)), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', cancel); } };
}
/** Abort waiting without replaying the request; caller owns transport cleanup. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('操作取消')); };
    promise.then((v) => { signal.removeEventListener('abort', abort); resolve(v); }, (e) => { signal.removeEventListener('abort', abort); reject(e); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
