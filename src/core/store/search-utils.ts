/**
 * Search utilities — shared helpers for memory search across backends.
 *
 * Contains:
 * - RRF (Reciprocal Rank Fusion) merge — used by SQLite hybrid search
 *   (eliminates the 3x duplication in auto-recall, memory-search, conversation-search)
 * - FTS query building — re-exported from sqlite for convenience
 * 中文：搜索工具——跨后端的内存搜索共享辅助函数。
 * 包含：
 * - RRF（互惠排名融合）合并 —— 用于SQLite混合搜索
 * （消除自动回忆、内存搜索和对话搜索中的3倍重复）
 * - FTS查询构建 —— 从sqlite导出以方便使用
 */

// ============================
// RRF (Reciprocal Rank Fusion)
// ============================
// 中文：RRF (互惠排名融合)

/**
 * Standard RRF constant from the original RRF paper.
 * Higher k → more weight on lower-ranked items (smoother distribution).
 * 中文：原始RRF常量来自最初的RRF论文。
 * k值越大 → 越重视低排名项（分布更平滑）
 */
export const RRF_K = 60;

/**
 * Merge multiple ranked lists via Reciprocal Rank Fusion.
 *
 * Each item's RRF score = sum over all lists of 1/(k + rank + 1).
 * Items appearing in multiple lists get their scores summed.
 *
 * @param lists   Array of ranked lists. Each list must have items with an `id` field.
 * @param k       RRF constant (default: 60).
 * @returns       Merged list sorted by descending RRF score, with `rrfScore` attached.
 *
 * @example
 * ```ts
 * const merged = rrfMerge(
 *   [ftsResults, vecResults],
 *   (item) => item.record_id,
 * );
 * ```
 * 中文：通过互惠排名融合合并多个排名列表。
 * 每项的RRF得分为各列表中排名加1后的倒数之和。
 * 出现在多张列表中的项目其得分相加。
 * @params   lists   排名列表数组。每个列表必须包含具有`id`字段的项。
 * @k       RRF常量（默认值：60）。
 * @return    返回按降序RRF得排序后的合并列表，带有`rrfScore`属性。
 * @example
 * ```ts
 * const merged = rrfMerge(
 * [ftsResults, vecResults],
 * (item) => item.record_id,
 * );
 * ```
 */
export function rrfMerge<T>(
  lists: T[][],
  getId: (item: T) => string,
  k: number = RRF_K,
): Array<T & { rrfScore: number }> {
  const map = new Map<string, { item: T; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = getId(item);
      const score = 1 / (k + rank + 1);
      const existing = map.get(id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, rrfScore }));
}
