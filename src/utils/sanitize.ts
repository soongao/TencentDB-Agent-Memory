/**
 * Text sanitization for memory pipeline (capture & recall).
 * Removes injected tags, gateway metadata, media noise, etc.
 * 中文：内存管道（捕获与回忆）的文本净化。
 * 移除注入标签、网关元数据、媒体噪声等。
 */

/**
 * Clean text for the memory pipeline: remove injected tags, metadata,
 * timestamps, media markers and base64 image data.
 *
 * Used by both capture (L0 recording) and recall (query cleaning) paths.
 * 中文：为内存管道清理文本：移除注入标签、元数据、时间戳、媒体标记和base64图像数据。
 * 用于捕获（L0录音）和回忆（查询清理）路径。
 */
export function sanitizeText(text: string): string {
  let cleaned = text;

  // Remove injected memory context tags (prevent feedback loops)
  // 中文：移除注入的记忆上下文标签（防止反馈循环）
  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, "");
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, "");
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, "");

  // Remove offload-injected task context blocks (MMD mermaid diagrams)
  // 中文：移除卸载注入的任务上下文块（MMD mermaid图示）
  cleaned = cleaned.replace(/<current_task_context>[\s\S]*?<\/current_task_context>/g, "");
  cleaned = cleaned.replace(/<history_task_context[\s\S]*?<\/history_task_context>/g, "");

  // Remove framework-injected inbound metadata blocks (from inbound-meta.ts buildInboundUserContextPrefix).
  // These are "label:\n```json\n...\n```" blocks that the framework prepends to user messages.
  // Pattern matches all known block labels:
  //   - Conversation info (untrusted metadata):
  //   - Sender (untrusted metadata):
  //   - Thread starter (untrusted, for context):
  //   - Replied message (untrusted, for context):
  //   - Forwarded message context (untrusted metadata):
  //   - Chat history since last reply (untrusted, for context):
  // 中文：移除框架注入的入站元数据块（来自inbound-meta.ts buildInboundUserContextPrefix）。
  // 这些是“label:\n```json\n...\n```”块，框架会在用户消息前缀添加。
  // 模式匹配所有已知块标签：
  // - 会话信息（不可信元数据）:
  // - 发送者（不可信元数据）:
  // - 主题发起人（不可信，用于上下文）:
  // - 回复的消息（不可信，用于上下文）:
  // - 转发消息的上下文（不可信元数据）:
  // - 自上次回复以来的聊天历史记录（不可信，用于上下文）:
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[\s\S]*?\):\s*```json\s*[\s\S]*?```/g,
    "",
  );

  // Remove conversation metadata JSON blocks (legacy pattern)
  // 中文：移除会话元数据JSON块（遗留模式）
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"session[\s\S]*?\}\s*```/g, "");

  // Remove framework reply directive tags: [[reply_to_current]], [[reply_to_xxx]], etc.
  // 中文：移除框架回复指令标签：[[reply_to_current]]，[[reply_to_xxx]]等
  cleaned = cleaned.replace(/\[\[reply_to[^\]]*\]\]\s*/g, "");

  // Remove injected skill-selection wrappers, e.g. ¥¥[... ]¥¥
  // 中文：移除注入的能力选择包装器，例如¥¥[...]¥¥
  cleaned = cleaned.replace(/¥¥\[[\s\S]*?\]¥¥/g, "");

  // Remove line-leading timestamps, e.g. "[Tue 2026-03-24 03:48 UTC]"
  // or "[Tue 2026-03-24 20:21 GMT+8]", "[Thu 2026-03-24 01:51 GMT+5:30]"
  // Matches brackets containing word chars, digits, hyphens, colons, plus signs,
  // and spaces — the '+' is needed for timezone offsets like GMT+8, GMT+5:30.
  // 中文：移除行首时间戳，例如 "[Tue 2026-03-24 03:48 UTC]" 或 "[Tue 2026-03-24 20:21 GMT+8]", "[Thu 2026-03-24 01:51 GMT+5:30]"
  // 匹配包含字母、数字、连字符、冒号和加号的括号——加号用于时区偏移如GMT+8, GMT+5:30。
  cleaned = cleaned.replace(/^\[[\w\d\-:+ ]+\]\s*/gm, "");

  // Remove gateway media-attachment markers:
  //   [media attached: /path/to/file.png (image/png) | /path/to/file.png]
  // 中文：移除网关媒体附件标记：
  // [media attached: /path/to/file.png (image/png) | /path/to/file.png]
  cleaned = cleaned.replace(/\[media attached:[^\]]*\]\s*/g, "");

  // Remove gateway image-reply instructions injected after media attachments.
  // Starts with "To send an image back" and ends before the next real content.
  // 中文：移除注入在媒体附件之后的图像回复指令。以 "To send an image back" 开始并在下一个真实内容前结束。
  cleaned = cleaned.replace(
    /To send an image back,[\s\S]*?(?:Keep caption in the text body\.)\s*/g,
    "",
  );

  // Remove "System: [timestamp] Exec completed ..." blocks appended by the framework.
  // 中文：移除框架附加的 "System: [时间戳] 执行完成 ..." 块。
  cleaned = cleaned.replace(/^System:\s*\[[\s\S]*?$/gm, "");

  // Remove inline base64 image data URIs (e.g. data:image/png;base64,iVBOR...)
  // Replace with empty string (not a placeholder) so that pure-image messages
  // become empty after sanitization and are naturally filtered by length checks.
  // 中文：移除内联 base64 图像数据 URI（例如 data:image/png;base64,iVBOR...）
  // 用空字符串替换，以便纯图像消息在清理后变为空，并自然通过长度检查被过滤。
  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "");

  // Remove null chars + compress whitespace
  // 中文：移除 null 字符并压缩空白
  cleaned = cleaned.replace(/\0/g, "").replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

/**
 * Strip fenced code blocks from assistant replies before L0 capture.
 *
 * AI responses often contain large code snippets (```...```) that dilute
 * the semantic signal for embedding and memory extraction. This function
 * removes only the code block content while preserving surrounding
 * natural-language explanations.
 *
 * Only applied to `role=assistant` messages in the L0 capture path —
 * user messages and recall queries are NOT affected.
 * 中文：在 L0 捕获前从助手回复中剥离围栏代码块。
 * AI 响应经常包含大量代码片段（```...``），这会稀释嵌入和记忆提取的语义信号。此功能仅移除代码块内容同时保留周围自然语言解释。
 * 仅应用于 L0 捕获路径中的 `role=assistant` 消息——用户消息和回忆查询不受影响。
 */
export function stripCodeBlocks(text: string): string {
  return text.replace(/```[^\n]*\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ============================
// L0 / L1 Capture & Extraction Filters
// ============================
// 中文：L0 / L1 捕获与提取过滤器

/**
 * L0 capture filter — intentionally **permissive**.
 *
 * L0 is the raw conversation archive. We want to preserve as much user input
 * as possible so that downstream stages (L1 extraction, search, analytics)
 * have the full picture. Only messages that are *structurally* useless are
 * dropped here:
 *   - Empty / whitespace-only text
 *   - Framework-internal noise (bootstrap, session reset, NO_REPLY, …)
 *   - Slash commands (/new, /reset, …)
 *
 * Content-quality filters (length, symbols, prompt injection) are deferred
 * to {@link shouldExtractL1}.
 * 中文：L0捕获过滤器——故意设置为**宽松**。
 * L0是原始对话存档。我们希望尽可能保留用户输入，
 * 以便下游阶段（L1提取、搜索、分析）能够拥有完整的视图。只有那些*结构上*无用的消息才会被丢弃：
 * - 空消息/仅空白文本
 * - 框架内部噪声（启动、会话重置、NO_REPLY等）
 * - 斜杠命令（/new, /reset等）
 * 内容质量过滤器（长度、符号、提示注入）将推迟到 {@link shouldExtractL1}。
 */
export function shouldCaptureL0(text: string): boolean {
  if (!text || !text.trim()) return false;

  // Filter framework-internal / bootstrap noise messages
  // 中文：过滤框架内部/启动噪声消息
  if (isFrameworkNoise(text)) return false;

  // Slash commands are framework directives, not user content
  // 中文：斜杠命令是框架指令，不是用户内容
  if (text.startsWith("/")) return false;

  return true;
}

/**
 * L1 extraction filter — **strict** quality gate.
 *
 * Applied when L0 messages are fed into the LLM extraction pipeline.
 * Filters out content that is too short, too long, purely symbolic,
 * or looks like a prompt-injection attack — none of which should
 * become structured memories.
 *
 * This function is a superset of {@link shouldCaptureL0}: anything
 * rejected by L0 is also rejected here, plus additional quality checks.
 * 中文：L1提取过滤器——**严格**的质量门。
 * 当L0消息被送入LLM提取管道时应用此过滤器。
 * 过滤掉太短、太长、纯粹符号性的或看起来像是提示注入攻击的内容——这些都不应成为结构化记忆的一部分。
 * 此函数是 {@link shouldCaptureL0} 的超集：任何被L0拒绝的消息也会在这里被拒绝，再加上额外的质量检查。
 */
export function shouldExtractL1(text: string): boolean {
  // First apply the same structural filters as L0
  // 中文：首先应用与L0相同的结构性过滤器
  if (!shouldCaptureL0(text)) return false;

  // ── Length filters ──
  // const isCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
  // if (isCJK && text.length < 2) return false;
  // if (!isCJK && text.length < 2) return false;
  // if (text.length > 5000) return false;
  // 中文：── 长度过滤 ──
  // const isCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
  // if (isCJK && text.length < 2) return false;
  // if (!isCJK && text.length < 2) return false;
  // if (text.length > 5000) return false;

  // ── Content-quality filters ──
  // Match strings composed entirely of non-word, non-space, non-CJK characters (1–5 chars).
  // 中文：── 内容质量过滤 ──
  // 匹配由非单词、非空格、非CJK字符组成的字符串（1-5个字符）。
  if (/^[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{1,5}$/.test(text)) return false;
  if (/^[?？]+$/.test(text)) return false;

  // ── Security filters ──
  // Reject prompt-injection payloads — prevent malicious content from being
  // persisted into structured memory and re-injected on future recalls.
  // 中文：── 安全过滤 ──
  // 拒绝提示注入载荷——防止恶意内容被持久化到结构化记忆中并在未来的回忆中重新注入。
  if (looksLikePromptInjection(text)) return false;

  return true;
}

/**
 * @deprecated Use {@link shouldExtractL1} (strict) or {@link shouldCaptureL0} (permissive) instead.
 *
 * Kept as an alias of `shouldExtractL1` for backward compatibility.
 * 中文：@deprecated 使用 {@link shouldExtractL1}（严格）或 {@link shouldCaptureL0}（宽松）代替。
 * 保持作为 `shouldExtractL1` 的别名以兼容性考虑。
 */
export const shouldCapture = shouldExtractL1;

// ============================
// Prompt Injection Detection
// ============================
// 中文：提示注入检测

/**
 * Known prompt-injection / jailbreak patterns.
 *
 * Covers:
 * 1. Instruction override — "ignore all previous instructions", etc.
 * 2. Role hijack — "you are now DAN", "act as root", etc.
 * 3. System/developer boundary probing — "system prompt", "developer message"
 * 4. XML/tag injection — opening tags that match our context boundaries
 * 5. Tool/command invocation tricks — "run command X", "execute tool Y"
 * 6. Multi-language variants — Chinese prompt-injection patterns
 * 中文：已知的提示注入 / 监狱突破 模式。
 * 涵盖：
 * 1. 指令覆盖 — “忽略所有先前指令” 等。
 * 2. 角色劫持 — “你现在是 DAN”，“扮演 root 角色” 等。
 * 3. 系统/开发者边界探测 — “系统提示”，“开发人员消息”
 * 4. XML/标签注入 — 匹配我们上下文边界的 开始标签
 * 5. 工具/命令调用技巧 — “运行命令 X”，“执行工具 Y”
 * 6. 多语言变体 — 中文提示注入模式
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // ── Instruction override ──
  // 中文：── 指令覆盖 ──
  /ignore\b.{0,30}\b(instructions|rules|guidelines)/i,
  /disregard\b.{0,30}\b(instructions|rules|guidelines)/i,
  /forget\b.{0,30}\b(instructions|rules|context)/i,
  /override\b.{0,30}\b(instructions|rules|guidelines|safety)/i,

  // ── Role hijack ──
  // 中文：── 角色劫持 ──
  /you are now (?!going|about|ready)/i, // "you are now DAN" but not "you are now going to..."
  // 中文："你现在已经DAN"而不是"你即将成为..."
  /act as (?:if you are |if you were )?(?:a |an )?(?:root|admin|unrestricted|unfiltered|jailbroken)/i,
  /enter (?:DAN|jailbreak|god|sudo|developer|dev|debug|unrestricted|unfiltered) mode/i,
  /switch to (?:DAN|jailbreak|god|sudo|developer|dev|debug|unrestricted|unfiltered) mode/i,

  // ── System boundary probing ──
  // 中文：── 系统边界探测 ──
  /(?:show|reveal|print|output|display|repeat|leak|dump|give)\b.{0,20}\bsystem prompt/i,
  /reveal (?:your |the )?(system|hidden|secret|internal) (?:prompt|instructions|rules)/i,
  /what (?:are|is) your (?:system|hidden|original|initial) (?:prompt|instructions|rules)/i,

  // ── XML/tag injection (our context boundaries) ──
  // 中文：── XML/标签注入（我们的上下文边界） ──
  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,

  // ── Tool/command invocation tricks ──
  // 中文：── 工具/命令调用技巧 ──
  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command|function|shell)\b/i,

  // ── Chinese variants ──
  /忽略(?:所有|之前|以上|先前)?(?:的)?(?:指令|规则|指示|说明)/,
  /无视(?:所有|之前|以上)?(?:的)?(?:指令|规则|限制)/,
  /(?:显示|输出|告诉我|给我看)(?:你的)?(?:系统|初始|隐藏)?(?:提示词|指令|规则|prompt)/,
  /你(?:现在|从现在开始)是/,            // "你现在是 DAN"
];

/**
 * Detect likely prompt-injection / jailbreak attempts.
 *
 * Normalises whitespace before matching to defeat trivial obfuscation
 * (e.g. extra spaces / newlines between keywords).
 * 中文：检测可能的提示注入/逃逸尝试。
 * 在匹配前标准化空白字符以抵御简单的混淆（例如，关键词之间的多余空格或换行符）。
 */
export function looksLikePromptInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detect framework-injected noise messages that should never be captured.
 *
 * These include:
 * - "(session bootstrap)" — synthetic user turn for Google turn-order compliance
 * - Session startup instructions from /new or /reset
 * - "✅ New session started" — AI's ack of session startup (no user-meaningful content)
 * - Pre-compaction memory flush prompts (system-to-agent instructions, not user content)
 * - AI's NO_REPLY ack of memory flush (no user-meaningful content)
 * 中文：检测不应被捕获的框架注入噪声消息。
 * 包括但不限于：
 * - "(session bootstrap)" — 用于Google回合顺序合规性的合成用户回合
 * - 从/new 或 /reset 开始的会话启动指令
 * - "✅ 新会话已开始" — AI对会话启动的确认（无用户有意义的内容）
 * - 预压缩前内存刷新提示（系统到代理的指令，非用户内容）
 * - AI对内存刷新的NO_REPLY确认（无用户有意义的内容）
 */
function isFrameworkNoise(text: string): boolean {
  const t = text.trim();

  // Google turn-order bootstrap placeholder
  // 中文：Google回合顺序初始化占位符
  if (t === "(session bootstrap)") return true;

  // Framework session-reset instruction (starts with "A new session was started via /new or /reset")
  // 中文：框架会话重置指令（以"A new session was started via /new or /reset"开头）
  if (t.startsWith("A new session was started via")) return true;

  // AI's pure ack of session startup: "✅ New session started · model: ..."
  // 中文：AI对会话启动的纯确认："✅ 新会话已开始 · 模型: ..."
  if (/^✅\s*New session started/.test(t)) return true;

  // Pre-compaction memory flush prompt injected by the framework as a synthetic
  // user turn. This is an internal system-to-agent instruction, NOT real user
  // content. Capturing it would pollute L0/L1 memories with framework directives.
  // 中文：预压缩前内存刷新提示由框架作为合成用户回合注入。
  // 这是内部系统到代理的指令，不是真实用户内容。捕获它会导致L0/L1记忆被框架指令污染。
  if (t.startsWith("Pre-compaction memory flush")) return true;

  // AI's NO_REPLY response to memory flush (or other silent-reply scenarios).
  // A bare "NO_REPLY" (with optional whitespace) carries no user-meaningful content.
  // 中文：AI对内存刷新的NO_REPLY响应（或其他静默回复场景）。
  // 仅"NO_REPLY"（可选带空白字符）不包含用户有意义的内容。
  if (/^NO_REPLY\s*$/.test(t)) return true;

  return false;
}

/**
 * Pick up to `max` recent unique texts.
 * 中文：选择最近最多`max`个唯一的文本。
 */
export function pickRecentUnique(texts: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = texts.length - 1; i >= 0 && result.length < max; i--) {
    const t = texts[i]!;
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result.reverse();
}

// ============================
// LLM Safety Utilities
// ============================
// 中文：LLM 安全工具

/**
 * Escape XML-like tags in text to prevent tag injection attacks.
 *
 * When memory content or persona text is injected into XML-delimited sections
 * (e.g. `<user-persona>...</user-persona>`), a malicious user could craft content
 * containing `</user-persona>` to break out of the section boundary.
 *
 * This function escapes `<` and `>` in known dangerous patterns (closing tags
 * that match our injection boundaries) so the content cannot prematurely close
 * the XML section.
 * 中文：在文本中转义类似 XML 的标签以防止标签注入攻击。
 */
export function escapeXmlTags(text: string): string {
  // Escape closing tags that match our injection section boundaries
  // 中文：转义与我们的注入区域边界匹配的关闭标签
  return text.replace(
    /<\/?(?:user-persona|relevant-memories|scene-navigation|relevant-scenes|memory-tools-guide|system|assistant)>/gi,
    (match) => match.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
}

// ============================
// JSON Sanitization for LLM Output
// ============================
// 中文：LLM 输出 JSON 精简

/**
 * Sanitize a raw JSON string from LLM output so that `JSON.parse` won't throw
 * "Bad control character in string literal".
 *
 * Per RFC 8259 §7, U+0000–U+001F MUST be escaped inside JSON string literals.
 * LLMs sometimes produce unescaped control characters (raw newlines, tabs, etc.)
 * inside string values.
 *
 * Strategy (two-phase):
 *  1. **Precise pass** — walk through JSON string literals (delimited by `"`)
 *     and escape any unescaped U+0000–U+001F inside them to `\uXXXX` form,
 *     while leaving structural whitespace (between values) untouched.
 *  2. **Fallback** — if the precise pass still fails `JSON.parse`, fall back to
 *     a simple global strip of rare control chars (\x00–\x08, \x0b, \x0c,
 *     \x0e–\x1f) which are almost never meaningful in natural-language content.
 * 中文：精简来自 LLM 输出的原始 JSON 字符串，以便 `JSON.parse` 不会抛出 "Bad control character in string literal" 错误。
 */
export function sanitizeJsonForParse(raw: string): string {
  // Phase 1: Escape control characters inside JSON string literals.
  // We walk the string character-by-character to properly handle escape sequences.
  // 中文：根据 RFC 8259 §7，在 JSON 字符串字面量中 U+0000–U+001F 必须转义。LLMs 有时会在字符串值中生成未转义的控制字符（原始换行符、制表符等）。
  const escaped = escapeControlCharsInJsonStrings(raw);
  try {
    JSON.parse(escaped);
    return escaped;
  } catch {
    // Phase 1 didn't fully fix it — fall through to phase 2
    // 中文：策略（两阶段）：
  }

  // Phase 2: Brute-force strip of rare control chars that have no textual meaning.
  // Preserves \t (\x09), \n (\x0a), \r (\x0d) which are common structural whitespace.
  // NOTE: We strip from `escaped` (Phase 1 result) rather than `raw`, so that any
  // control-character escaping Phase 1 performed is preserved even when the JSON has
  // other issues (e.g. trailing commas) that cause the Phase 1 parse to fail.
  // 中文：1. **精确通过** — 遍历由 `"` 分隔的 JSON 字符串字面量，并将其中任何未转义的 U+0000–U+001F 转换为 `\uXXXX` 形式，同时保留结构空白（值之间的空白）不变。
  const stripped = escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return stripped;
}

/**
 * Walk through a JSON text and escape U+0000–U+001F control characters that
 * appear *inside* JSON string literals (between unescaped `"` delimiters).
 *
 * Characters that already have short escape sequences (\n, \r, \t, \b, \f)
 * are mapped to those; others become \uXXXX.
 *
 * Structural whitespace outside string literals is left untouched.
 * 中文：遍历一个 JSON 文本，并转义出现在 JSON 字符串字面量（在未转义的 `"` 分隔符之间）内的 U+0000–U+001F 控制字符。
 * 已经具有简短转义序列（\n, \r, \t, \b, \f）的字符会被映射到这些；其他字符则变为 \uXXXX。
 * 字符串外部的结构空白字符保持不变。
 */
function escapeControlCharsInJsonStrings(text: string): string {
  const SHORT_ESCAPES: Record<number, string> = {
    0x08: "\\b", // backspace
    // 中文：backspace
    0x09: "\\t", // tab
    0x0a: "\\n", // line feed
    // 中文：line feed
    0x0c: "\\f", // form feed
    // 中文：form feed
    0x0d: "\\r", // carriage return
    // 中文：carriage return
  };

  const out: string[] = [];
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);

    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        // Already-escaped sequence — copy both characters verbatim
        // 中文：已转义的序列 — 将两个字符原样复制
        out.push(ch, text[i + 1]!);
        i += 2;
        continue;
      }
      if (ch === '"') {
        // End of string literal
        // 中文：字符串结束
        out.push(ch);
        inString = false;
        i++;
        continue;
      }
      if (code <= 0x1f) {
        // Unescaped control character inside string — escape it
        // 中文：字符串内部未转义的控制字符 — 转义它
        const short = SHORT_ESCAPES[code];
        if (short) {
          out.push(short);
        } else {
          out.push("\\u" + code.toString(16).padStart(4, "0"));
        }
        i++;
        continue;
      }
      // Normal character inside string
      // 中文：字符串内部普通字符
      out.push(ch);
      i++;
    } else {
      // Outside string literal
      // 中文：字符串外部
      if (ch === '"') {
        out.push(ch);
        inString = true;
        i++;
        continue;
      }
      // Structural character (including whitespace) — pass through
      // 中文：结构字符（包括空白字符）——直接通过
      out.push(ch);
      i++;
    }
  }

  return out.join("");
}
