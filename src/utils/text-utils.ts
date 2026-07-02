/**
 * Shared text utility functions for the memory-tdai plugin.
 * 中文：内存-tdai插件的共享文本工具函数.
 */

/**
 * Extract meaningful words from text (supports CJK and Latin).
 *
 * Used by both auto-recall (keyword search) and l1-dedup (keyword candidate recall).
 * Extracted to a shared module to prevent implementation drift.
 * 中文：从文本中提取有意义的词（支持CJK和拉丁字符）。用于自动回忆（关键词搜索）和l1-dedup（关键词候选召回）中。提取到一个共享模块以防止实现漂移.
 */
export function extractWords(text: string): Set<string> {
  const words = new Set<string>();

  // Latin words (2+ chars)
  // 中文：拉丁词（2+字符）
  const latinWords = text.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (latinWords) {
    for (const w of latinWords) words.add(w);
  }

  // CJK characters (each char as a "word", plus 2-gram)
  // 中文：CJK字符（每个字符作为一个“词”，加上2-gram）
  const cjkChars = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  if (cjkChars) {
    for (const c of cjkChars) words.add(c);
    // 2-grams for better matching
    // 中文：2-grams以获得更好的匹配
    for (let i = 0; i < cjkChars.length - 1; i++) {
      words.add(cjkChars[i] + cjkChars[i + 1]);
    }
  }

  return words;
}
