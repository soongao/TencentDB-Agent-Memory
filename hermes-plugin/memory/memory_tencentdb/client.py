"""MemoryTencentdbSdkClient — HTTP client for the memory-tencentdb Gateway.

Wraps all Gateway API endpoints with timeout, retry, and error handling.
Thread-safe — can be shared across prefetch/sync threads.
中文：MemoryTencentdbSdkClient — 内存-tencentdb网关的HTTP客户端。
将所有网关API端点包装在超时、重试和错误处理中。
线程安全——可以在预取/同步线程间共享。
"""

from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10  # seconds
# 中文："seconds"


class MemoryTencentdbSdkClient:
    """HTTP client for the memory-tencentdb Gateway sidecar.

    中文：内存-tencentdb网关边车的HTTP客户端。
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        timeout: int = DEFAULT_TIMEOUT,
        api_key: Optional[str] = None,
    ):
        """Construct the client.

        Args:
            base_url: Gateway base URL.
            timeout: Default request timeout in seconds.
            api_key: Optional Bearer token. When non-empty, every request
                attaches ``Authorization: Bearer <api_key>``. When ``None``
                or empty, no auth header is sent — this preserves the
                pre-existing open-Gateway behaviour and is the right default
                for any deployment where the Gateway has not opted into
                ``TDAI_GATEWAY_API_KEY`` yet.

                The provider sources this value from
                ``MEMORY_TENCENTDB_GATEWAY_API_KEY`` (with
                ``TDAI_GATEWAY_API_KEY`` as a fallback). The Gateway must
                be configured with the matching secret independently —
                this client does not (and should not) propagate the value
                across to the Gateway process.
        """
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        # Strip whitespace defensively — env vars often pick up trailing
        # newlines from `echo` or YAML quoting; an exact-match Bearer
        # comparison would otherwise reject a key that "looks right".
        # 中文：防止单词间空格——环境变量经常会从 `echo` 或 YAML 引用中拾取多余的换行符；否则，精确匹配的 Bearer 比较可能会拒绝一个“看起来正确”的密钥。
        self._api_key = (api_key or "").strip() or None

    def _build_headers(self, *, content_type: bool) -> Dict[str, str]:
        """Build request headers, conditionally adding Authorization.

        Centralised so the auth header logic is stated once: every method
        below goes through ``_post`` / ``_get`` which call this helper. If
        you ever add a new HTTP verb, route it here.
        中文：构建请求头，条件性地添加Authorization。
        集中式，因此授权标头逻辑只声明一次：下面的方法都会通过 ``_post`` / ``_get`` 调用此辅助函数。如果你要添加新的HTTP动词，请将其路由到这里。
        """
        headers: Dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _post(self, path: str, body: Dict[str, Any], timeout: Optional[int] = None) -> Dict[str, Any]:
        """Make a POST request to the Gateway.

        中文：向网关发送POST请求。
        """
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._build_headers(content_type=True),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            logger.warning("memory-tencentdb Gateway %s returned %d: %s", path, e.code, body_text[:500])
            raise
        except Exception as e:
            logger.debug("memory-tencentdb Gateway %s failed: %s", path, e)
            raise

    def _get(self, path: str, timeout: Optional[int] = None) -> Dict[str, Any]:
        """Make a GET request to the Gateway.

        中文：向网关发送GET请求。
        """
        url = f"{self._base_url}{path}"
        req = urllib.request.Request(
            url,
            headers=self._build_headers(content_type=False),
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.debug("memory-tencentdb Gateway GET %s failed: %s", path, e)
            raise

    # -- API methods ----------------------------------------------------------
    # 中文：-- API 方法 ----------------------------------------------------------

    def health(self, timeout: int = 3) -> Dict[str, Any]:
        """Check if the Gateway is healthy.

        中文：检查网关是否健康。
        """
        return self._get("/health", timeout=timeout)

    def recall(self, query: str, session_key: str, user_id: str = "") -> Dict[str, Any]:
        """Recall memories for a query (prefetch).

        中文：为查询召回记忆（预取）。
        """
        body: Dict[str, Any] = {"query": query, "session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._post("/recall", body)

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
    ) -> Dict[str, Any]:
        """Capture a conversation turn (sync_turn)."""
        body: Dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            body["session_id"] = session_id
        if user_id:
            body["user_id"] = user_id
        return self._post("/capture", body)

    def search_memories(self, query: str, limit: int = 5, type_filter: str = "", scene: str = "") -> Dict[str, Any]:
        """Search L1 structured memories.

        中文：搜索L1结构化记忆。
        """
        body: Dict[str, Any] = {"query": query, "limit": limit}
        if type_filter:
            body["type"] = type_filter
        if scene:
            body["scene"] = scene
        return self._post("/search/memories", body)

    def search_conversations(self, query: str, limit: int = 5, session_key: str = "") -> Dict[str, Any]:
        """Search L0 raw conversations.

        中文：搜索L0原始对话。
        """
        body: Dict[str, Any] = {"query": query, "limit": limit}
        if session_key:
            body["session_key"] = session_key
        return self._post("/search/conversations", body)

    def end_session(self, session_key: str, user_id: str = "") -> Dict[str, Any]:
        """End a session and trigger flush.

        中文：结束会话并触发刷新。
        """
        body: Dict[str, Any] = {"session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._post("/session/end", body)

    def seed(
        self,
        data: Any,
        session_key: str = "",
        strict_round_role: bool = False,
        auto_fill_timestamps: bool = True,
        config_override: Optional[Dict[str, Any]] = None,
        timeout: int = 300,
    ) -> Dict[str, Any]:
        """Batch seed historical conversations into the memory pipeline.

        Args:
            data: Seed input — Format A ``{"sessions": [...]}`` or Format B ``[...]``.
            session_key: Fallback session key when input sessions lack one.
            strict_round_role: Require each round to have both user and assistant.
            auto_fill_timestamps: Auto-fill missing timestamps (default True).
            config_override: Plugin config overrides (deep-merged).
            timeout: Request timeout in seconds (seed can be slow, default 300s).

        Returns:
            Summary dict with sessions_processed, rounds_processed, etc.
        """
        body: Dict[str, Any] = {"data": data}
        if session_key:
            body["session_key"] = session_key
        if strict_round_role:
            body["strict_round_role"] = True
        if not auto_fill_timestamps:
            body["auto_fill_timestamps"] = False
        if config_override:
            body["config_override"] = config_override
        return self._post("/seed", body, timeout=timeout)
