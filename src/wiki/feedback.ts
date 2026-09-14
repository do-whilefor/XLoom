import type { MaterialDelivery } from "./materials.js";
import type { IndexStats } from "./cache.js";

export function materialFeedback(delivery: MaterialDelivery): string {
  const lines = [`${delivery.baseline === "initial" ? "首次资料交接" : "本轮资料交接"}：新增 ${delivery.added} 项，更新 ${delivery.changed} 项。`];
  const gaps = new Set(delivery.items.flatMap(item => item.relatedGaps.map(ref => `${ref.stepId}/${ref.gapId}`)));
  if (gaps.size) lines.push(`展示 ${gaps.size} 个关联问题入口：${[...gaps].slice(0, 3).join("、")}${gaps.size > 3 ? "等" : ""}。`);
  if (delivery.deferredCount) lines.push(`还有 ${delivery.deferredCount} 项未装入本轮提示，可按资料入口继续读取。`);
  if (delivery.originalLinking?.unavailableSources) lines.push(`关联检索中 ${delivery.originalLinking.unavailableSources} 份原件不可用，请从问题入口查看原因。`);
  if (delivery.originalLinking?.deferredGaps) lines.push(`另有 ${delivery.originalLinking.deferredGaps} 个问题尚未检索原文，可按问题入口继续检索。`);
  lines.push("已提示 ≠ 已复核；Decide 仍需读取来源并决定下一步。");
  return lines.join("\n\n");
}

/** Formats only trusted native retrieval result structures, never tool prose. */
export function retrievalFeedback(value: object): string {
  const result = value as { type?: string; questionRef?: { stepId: string; gapId: string }; originals?: object; wiki?: object; items?: unknown[]; searchTruncated?: boolean;
    hits?: unknown[]; index?: IndexStats; issues?: unknown[]; deferredWindows?: number; deferredCount?: number;
    complete?: boolean; retrievalProgress?: string; locator?: { evidenceId: string; byteOffset: number; byteLength: number }; integrity?: string;
    reading?: { newRecords: number; repeatedRecords: number; originalsWithUnreadBytes: number; fullyDeliveredOriginals: number; repeatedOriginalRange?: boolean } };
  if (result.type === "planning_materials") return materialFeedback(value as MaterialDelivery);
  const lines: string[] = [];
  if (result.type === "task_search") {
    lines.push("检索当前任务的 Wiki／原件资料。");
    if (result.wiki) lines.push(retrievalFeedback(result.wiki));
    if (result.originals) lines.push(retrievalFeedback(result.originals));
  } else if (result.type === "discovery_context") {
    lines.push(`能力发现：返回 ${result.items?.length ?? 0} 个消费者的候选前提与来源。`);
    if (result.searchTruncated) lines.push("候选搜索达到限制；未找到方案不表示不存在路径。");
    lines.push("候选前提匹配不表示实际消费或最终结果已经验证。");
  } else if (result.type === "question_context") {
    lines.push(`围绕问题 ${result.questionRef?.stepId}/${result.questionRef?.gapId} 检索资料。`);
    if (result.originals) lines.push(retrievalFeedback(result.originals));
  } else if (result.type === "original_search") {
    lines.push(`原文检索：返回 ${result.hits?.length ?? 0} 个定位片段${result.deferredWindows ? `，另有 ${result.deferredWindows} 个命中窗口未展开` : ""}。`);
    if (result.index) {
      const s = result.index;
      lines.push(`索引：新增 ${s.added}，重建 ${s.updated}，复用 ${s.reused}，移除 ${s.removed}；本次索引 ${s.indexedBytes} 字节。`);
      lines.push(`交付前完整校验 ${s.verifiedOriginals} 份命中原件${s.storage === "memory" ? "；缓存不可用，本次使用内存索引" : ""}。`);
    }
    if (result.issues?.length) lines.push(`${result.issues.length} 份原件无法使用，详情中保留原因。`);
  } else if (result.type === "original_read") {
    const loc = result.locator!;
    lines.push(`读取原文 ${loc.evidenceId}：字节 ${loc.byteOffset}–${loc.byteOffset + loc.byteLength}（右端不含），共 ${loc.byteLength} 字节。`);
    if (result.integrity === "verified") lines.push("完整原件校验通过；当前仅展示指定范围。");
  } else if (result.type === "retrieval") lines.push(`来源包：读取 ${result.hits?.length ?? 0} 项，${result.deferredCount ?? 0} 项待展开。`);
  if (result.complete === false) lines.push("资料交付尚不完整：请处理缺失原件或扩大读取预算。");
  if (result.retrievalProgress === "stop_repeating_query") lines.push("本轮相同查询没有带来新资料：请读取原文、缩小缺口或取得新观察。");
  if (result.reading) {
    const r = result.reading;
    if (r.repeatedRecords) lines.push(`本轮已交付过其中 ${r.repeatedRecords} 项资料；可直接检查原件，避免换入口重复读取。`);
    if (r.originalsWithUnreadBytes) lines.push(`${r.originalsWithUnreadBytes} 份相关原件仍有未精读字节；详情提供下一原件入口。`);
    if (r.repeatedOriginalRange) lines.push("本轮已读取过此原件范围；已重新校验完整文件，正文仍按原样返回。");
  }
  return lines.join("\n\n");
}
