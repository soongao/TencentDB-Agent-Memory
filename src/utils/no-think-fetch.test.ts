import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createNoThinkFetch,
  isValidDisableThinkingStrategy,
  normalizeDisableThinking,
  type DisableThinkingStrategy,
} from "./no-think-fetch";

/**
 * Capture the (input, init) passed through to the real global fetch so we can
 * assert on the (possibly rewritten) request body. The mock never blindly
 * JSON.parses the body — it just records and returns a stub Response.
 * 中文：捕获传递给真实全局fetch的(input, init)，以便我们可以断言(可能被重写的)请求体。模拟不会盲目地对body进行JSON解析——它只是记录并返回一个占位Response.
 */
function captureFetch() {
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createNoThinkFetch", () => {
  // ─── vllm strategy (original behavior) ────────────────────────────────────
  // 中文：──── vllm 策略（原始行为） ────────────────────────────────────

  describe("vllm strategy", () => {
    it("injects chat_template_kwargs.enable_thinking=false into chat bodies", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");

      await f("https://example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "qwen3", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(sent.messages).toHaveLength(1);
    });

    it("merges into an existing chat_template_kwargs instead of clobbering it", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");

      await f("https://example", {
        body: JSON.stringify({ messages: [], chat_template_kwargs: { foo: "bar", enable_thinking: true } }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.chat_template_kwargs).toEqual({ foo: "bar", enable_thinking: false });
    });

    it("leaves embedding requests (input, no messages) untouched", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");
      const body = JSON.stringify({ model: "bge-m3", input: ["hello"] });

      await f("https://example/v1/embeddings", { body });

      expect(calls[0].init!.body).toBe(body);
      expect(JSON.parse(calls[0].init!.body as string).chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── deepseek strategy ───────────────────────────────────────────────────
  // 中文：──── deepseek 策略 ─────────────────────────────────────────────────

  describe("deepseek strategy", () => {
    it("injects top-level enable_thinking: false", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("deepseek");

      await f("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-reasoner", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.enable_thinking).toBe(false);
      expect(sent.chat_template_kwargs).toBeUndefined();
      expect(sent.messages).toHaveLength(1);
    });
  });

  // ─── dashscope strategy ─────────────────────────────────────────────────
  // 中文：──── dashscope 策略 ─────────────────────────────────────────────────

  describe("dashscope strategy", () => {
    it("injects top-level enable_thinking: false", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("dashscope");

      await f("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "qwen-plus", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.enable_thinking).toBe(false);
      expect(sent.chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── openai strategy ────────────────────────────────────────────────────
  // 中文：──── openai 策略 ────────────────────────────────────────────────────

  describe("openai strategy", () => {
    it("injects reasoning_effort: low", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("openai");

      await f("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "o3-mini", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.reasoning_effort).toBe("low");
      expect(sent.chat_template_kwargs).toBeUndefined();
      expect(sent.enable_thinking).toBeUndefined();
    });
  });

  // ─── anthropic strategy ─────────────────────────────────────────────────
  // 中文：──── anthropic 策略 ─────────────────────────────────────────────────

  describe("anthropic strategy", () => {
    it("injects thinking: { type: disabled }", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("anthropic");

      await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.thinking).toEqual({ type: "disabled" });
      expect(sent.chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── kimi strategy ─────────────────────────────────────────────────────
  // 中文：──── kimi 策略 ─────────────────────────────────────────────────────

  describe("kimi strategy", () => {
    it("injects thinking: { type: disabled }", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("kimi");

      await f("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.thinking).toEqual({ type: "disabled" });
      expect(sent.chat_template_kwargs).toBeUndefined();
      expect(sent.enable_thinking).toBeUndefined();
    });
  });

  // ─── gemini strategy ────────────────────────────────────────────────────
  // 中文：──── gemini 策略 ────────────────────────────────────────────────────

  describe("gemini strategy", () => {
    it("injects thinking_config: { thinking_budget: 0 }", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("gemini");

      await f("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });

      const sent = JSON.parse(calls[0].init!.body as string);
      expect(sent.thinking_config).toEqual({ thinking_budget: 0 });
      expect(sent.chat_template_kwargs).toBeUndefined();
    });
  });

  // ─── strategy === false (passthrough) ───────────────────────────────────
  // 中文：─── strategy === false（透传） ───────────────────────────────────

  describe("false strategy", () => {
    it("returns globalThis.fetch directly", () => {
      const f = createNoThinkFetch(false);
      expect(f).toBe(globalThis.fetch);
    });

    it("default parameter returns globalThis.fetch", () => {
      const f = createNoThinkFetch();
      expect(f).toBe(globalThis.fetch);
    });
  });

  // ─── Common behavior across all strategies ──────────────────────────────
  // 中文：─── 所有策略的常见行为 ──────────────────────────────

  describe("common behavior", () => {
    it("forwards a non-JSON string body unchanged", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("vllm");

      await f("https://example", { body: "not-json" });

      expect(calls[0].init!.body).toBe("not-json");
    });

    it("forwards requests with no init and with a non-string body unchanged", async () => {
      const calls = captureFetch();
      const f = createNoThinkFetch("deepseek");

      await f("https://example");
      expect(calls[0].init).toBeUndefined();

      const blob = new Uint8Array([1, 2, 3]);
      await f("https://example", { body: blob });
      expect(calls[1].init!.body).toBe(blob);
    });
  });
});

// ─── Validation helpers ─────────────────────────────────────────────────────
// 中文：─── 验证辅助函数 ─────────────────────────────────────────────────────

describe("isValidDisableThinkingStrategy", () => {
  it("returns true for all valid strategies", () => {
    const valid: DisableThinkingStrategy[] = [false, "vllm", "deepseek", "dashscope", "openai", "anthropic", "kimi", "gemini"];
    for (const v of valid) {
      expect(isValidDisableThinkingStrategy(v)).toBe(true);
    }
  });

  it("returns false for invalid values", () => {
    const invalid = [true, "invalid", "sglang", "VLLM", 0, null, undefined, "", "true"];
    for (const v of invalid) {
      expect(isValidDisableThinkingStrategy(v)).toBe(false);
    }
  });
});

describe("normalizeDisableThinking", () => {
  it("maps true to vllm (shorthand)", () => {
    expect(normalizeDisableThinking(true)).toBe("vllm");
  });

  it("maps false to false", () => {
    expect(normalizeDisableThinking(false)).toBe(false);
  });

  it("maps undefined to false", () => {
    expect(normalizeDisableThinking(undefined)).toBe(false);
  });

  it("passes through valid strategy strings", () => {
    expect(normalizeDisableThinking("vllm")).toBe("vllm");
    expect(normalizeDisableThinking("deepseek")).toBe("deepseek");
    expect(normalizeDisableThinking("dashscope")).toBe("dashscope");
    expect(normalizeDisableThinking("openai")).toBe("openai");
    expect(normalizeDisableThinking("anthropic")).toBe("anthropic");
    expect(normalizeDisableThinking("kimi")).toBe("kimi");
    expect(normalizeDisableThinking("gemini")).toBe("gemini");
  });

  it("warns and returns false for unknown strategies", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeDisableThinking("unknown_strategy")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown disableThinking strategy "unknown_strategy"'),
    );
    warnSpy.mockRestore();
  });
});
