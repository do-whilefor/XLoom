import type { HttpAssertion } from './types.js';

/** Human-readable scope of the finite program check, independent of model prose. */
export function confirmedHttpScope(assertion: HttpAssertion | undefined): string {
  if (!assertion) return '缺少结构化HTTP验证范围，需要复核';
  const { actor, owner, object, origin, resourcePath } = assertion;
  return `HTTP私有对象读取：${actor} 读取 ${owner} 所有 ${object}（${origin}${resourcePath}；${assertion.backend === 'kali' ? 'Kali SSH' : '本机'} 原生请求）`;
}

export function confirmedHttpImpact(assertion: HttpAssertion | undefined): string {
  if (!assertion) return '缺少可核对的HTTP内容观察，需要复核';
  const { actor, owner, object, origin, resourcePath, valuePointer } = assertion;
  return `${actor} 在 ${origin}${resourcePath} 取得与所有者 ${owner} 基线相同的 ${object} 私有内容（${valuePointer}）；限于本次实际身份、对象与对照。`;
}
