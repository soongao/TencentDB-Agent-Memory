"""memory-tencentdb Memory Provider — MemoryProvider interface for Hermes.

Four-layer memory system (L0 conversation, L1 extraction, L2 scene blocks,
L3 persona synthesis) accessed via local Node.js Gateway sidecar.

The Gateway runs the memory-tencentdb Core engine (the same engine used by
the OpenClaw plugin) as an HTTP service. This provider translates Hermes
lifecycle events into Gateway API calls.

Config via environment variables:
  MEMORY_TENCENTDB_GATEWAY_HOST — Gateway host (default: 127.0.0.1)
  MEMORY_TENCENTDB_GATEWAY_PORT — Gateway port (default: 8420)
  MEMORY_TENCENTDB_GATEWAY_CMD  — Command to start the Gateway (optional; if
                                  unset, the provider auto-discovers
                                  ``src/gateway/server.ts`` next to the plugin
                                  checkout or under ``$HOME``)

The on-disk data directory (L0~L3 storage) is owned by the Gateway, not by
this provider. Point the Gateway at a custom location with ``TDAI_DATA_DIR``
(read directly by ``src/gateway/config.ts``); otherwise it falls back to
``~/.memory-tencentdb/memory-tdai`` (with legacy fallback to ``~/memory-tdai``
if it still exists). This provider no longer carries its own data-dir default
or env var — a single source of truth prevents the two layers from drifting
apart.
中文：memory-tencentdb 内存提供者 — 用于 Hermes 的 MemoryProvider 接口。
四层内存系统（L0 对话，L1 提取，L2 场景块，L3 人物合成）通过本地 Node.js Gateway 边车访问。
Gateway 运行 memory-tencentdb 核心引擎（与 OpenClaw 插件使用的相同引擎），作为 HTTP 服务。此提供者将 Hermes 生命周期事件转换为 Gateway API 调用。
配置方式：
MEMORY_TENCENTDB_GATEWAY_HOST — Gateway 主机地址（默认值：127.0.0.1）
MEMORY_TENCENTDB_GATEWAY_PORT — Gateway 端口（默认值：8420）
MEMORY_TENCENTDB_GATEWAY_CMD  — 启动 Gateway 的命令（可选；未设置时，提供者会自动发现 ``src/gateway/server.ts`` 或在 ``$HOME`` 下的插件目录）
磁盘上的数据目录（L0~L3 存储）由 Gateway 拥有，而不是此提供者。通过 ``TDAI_DATA_DIR`` 指定自定义位置（直接被 ``src/gateway/config.ts`` 读取）；否则会回退到 ``~/.memory-tencentdb/memory-tdai`` （如果仍然存在则使用旧的回退路径 ``~/memory-tdai``）。此提供者不再携带自己的数据目录默认值或环境变量 —— 单一来源的事实可以防止两层之间的偏移。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

from .client import MemoryTencentdbSdkClient
from .supervisor import GatewaySupervisor

logger = logging.getLogger(__name__)

# Circuit breaker: after N consecutive failures, pause API calls
# 中文：电路 breaker：连续失败 N 次后，暂停 API 调用
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 60

# Gateway resurrect throttle: minimum seconds between two consecutive
# ensure_running() attempts triggered by in-flight request failures.
# Chosen smaller than _BREAKER_COOLDOWN_SECS so we can try to revive the
# Gateway *within* a breaker-open window (otherwise the breaker would mask
# the outage for a full minute before we'd even attempt recovery).
# Chosen larger than supervisor's HEALTH_CHECK_MAX_WAIT (30s) so a failed
# revive never overlaps with the next attempt.
# 中文：网关复活节流：两次连续由在途请求失败触发的 ensure_running() 尝试之间最小秒数。
# 选择比 _BREAKER_COOLDOWN_SECS 小，以便我们可以在断路器打开窗口内尝试复活网关（否则断路器会掩盖故障一分钟以上，直到我们尝试恢复）。
# 选择大于 supervisor 的 HEALTH_CHECK_MAX_WAIT（30s），因此失败的复活永远不会与下一次尝试重叠。
_RECOVER_COOLDOWN_SECS = 15

# Background sync thread limits.
# _MAX_INFLIGHT_SYNCS caps concurrent capture threads: once reached we wait
# on the oldest one with _SYNC_JOIN_TIMEOUT_SECS before spawning a new one,
# so a hung Gateway can't cause unbounded thread growth.
# 中文：后台同步线程限制。
# _MAX_INFLIGHT_SYNCS 限制并发捕获线程数量：一旦达到上限，我们将等待最老的一个线程 _SYNC_JOIN_TIMEOUT_SECS 时间，然后再启动一个新的线程，这样挂起的网关不会导致无界线程增长。
_MAX_INFLIGHT_SYNCS = 4
_SYNC_JOIN_TIMEOUT_SECS = 5.0
# _SHUTDOWN_JOIN_TIMEOUT_SECS bounds how long shutdown will wait on *each*
# still-alive sync thread. Kept per-thread rather than global because one
# stuck thread shouldn't starve the rest.
# 中文：_SHUTDOWN_JOIN_TIMEOUT_SECS 限制 shutdown 等待每个仍然存活的同步线程的时间。保持按线程而不是全局设置是因为一个卡住的线程不应饿死其他线程。
_SHUTDOWN_JOIN_TIMEOUT_SECS = 5.0

# Watchdog: a daemon thread that periodically inspects the Gateway and
# resurrects it on death. This is the *only* mechanism that can recover from
# the "stuck-in-False" state where _gateway_available has been flipped to
# False (initial start failed or breaker-open path swallowed all errors) and
# every business request short-circuits before reaching the failure path that
# would otherwise call _try_recover_gateway().
#
# _WATCHDOG_INTERVAL_SECS controls the polling cadence. Kept smaller than
# _BREAKER_COOLDOWN_SECS so we can detect death and re-enable the provider
# well before the breaker would naturally expire.
# _WATCHDOG_SHUTDOWN_TIMEOUT_SECS bounds how long shutdown waits for the
# watchdog to exit cleanly; the thread is daemonized so a hang would not
# block interpreter exit, but a bounded join keeps logs orderly.
# 中文：看门狗：一个周期性检查网关并其死后复活的守护线程。这是唯一可以从“卡在False”状态中恢复的机制，即 _gateway_available 被翻转为 False（初始启动失败或断路器打开路径吞没了所有错误），并且每个业务请求都会短路而不会到达会调用 _try_recover_gateway() 的故障路径。
# _WATCHDOG_INTERVAL_SECS 控制检查频率。保持小于 _BREAKER_COOLDOWN_SECS，以便我们可以在断路器自然过期之前检测到死亡并重新启用提供者。
# _WATCHDOG_SHUTDOWN_TIMEOUT_SECS 限制 shutdown 等待看门狗干净退出的时间；线程是守护进程化的，因此挂起不会阻止解释器退出，但有界等待保持日志有序。
_WATCHDOG_INTERVAL_SECS = 10.0
_WATCHDOG_SHUTDOWN_TIMEOUT_SECS = 2.0

# Gateway networking defaults (kept here so is_available/initialize stay in sync)
# 中文：网关网络默认设置（保留在此处以使 is_available/initialize 保持同步）
_DEFAULT_GATEWAY_HOST = "127.0.0.1"
_DEFAULT_GATEWAY_PORT = 8420


def _resolve_gateway_port(default: int = _DEFAULT_GATEWAY_PORT) -> int:
    """Resolve MEMORY_TENCENTDB_GATEWAY_PORT with validation.

    Accepts surrounding whitespace. Falls back to ``default`` and logs a
    warning when the env var is unset, empty, not a valid integer, or
    outside the valid TCP port range (1..65535). This keeps ``is_available``
    exception-safe (required by the provider registration contract) and
    gives users a clear diagnostic instead of a raw ValueError stack.
    中文：解析 MEMORY_TENCENTDB_GATEWAY_PORT 并进行验证。
    允许周围空格。未设置时回退到 ``default``，并记录警告（当 env 变量为空、无效整数或超出有效 TCP 端口范围 [1..65535] 时）。这使 ``is_available`` 异常安全（符合提供者注册契约），并向用户提供清晰的诊断而不是原始 ValueError 堆栈。
    """
    raw = os.environ.get("MEMORY_TENCENTDB_GATEWAY_PORT")
    if raw is None or not raw.strip():
        return default
    try:
        port = int(raw.strip())
    except ValueError:
        logger.warning(
            "Invalid MEMORY_TENCENTDB_GATEWAY_PORT=%r (not an integer); "
            "falling back to default %d.",
            raw, default,
        )
        return default
    if not (1 <= port <= 65535):
        logger.warning(
            "MEMORY_TENCENTDB_GATEWAY_PORT=%d is out of range (1..65535); "
            "falling back to default %d.",
            port, default,
        )
        return default
    return port


def _resolve_gateway_host(default: str = _DEFAULT_GATEWAY_HOST) -> str:
    """Resolve MEMORY_TENCENTDB_GATEWAY_HOST, trimming whitespace.

    中文：解析 MEMORY_TENCENTDB_GATEWAY_HOST 并去除空格。
    """
    raw = os.environ.get("MEMORY_TENCENTDB_GATEWAY_HOST")
    if raw is None:
        return default
    host = raw.strip()
    return host or default


def _resolve_gateway_api_key() -> Optional[str]:
    """Read the optional Gateway Bearer token from the environment.

    Looks at ``MEMORY_TENCENTDB_GATEWAY_API_KEY`` (Hermes-namespaced) first;
    falls back to ``TDAI_GATEWAY_API_KEY`` so an operator who already wired
    up the Gateway-side env var does not have to set two names. Returns
    ``None`` when neither is set, which means "do not attach an
    Authorization header" — exactly matching the Gateway's own legacy
    default. Whitespace-only values are treated as unset to guard against
    shells that quote ``\\n`` into env vars.

    Important: this is purely the **client-side** secret. Whether the
    Gateway actually enforces a Bearer check is decided on the Gateway
    side (its own ``TDAI_GATEWAY_API_KEY`` / ``server.apiKey``); the
    plugin does not propagate this value across to the spawned Gateway.
    The operator must configure the same secret on both ends if they
    want auth enforcement.
    中文：从环境变量中读取可选的 Gateway Bearer 令牌。
    首先查看 ``MEMORY_TENCENTDB_GATEWAY_API_KEY``（Hermes 命名空间）；未设置时回退到 ``TDAI_GATEWAY_API_KEY``，以便已经配置了 Gateway 环境变量的操作员不需要设置两个名称。当两者均未设置时返回 ``None``，这意味着“不附加 Authorization 头” —— 完全符合 Gateway 的默认行为。仅空格的值被视为未设置以防止 shell 将 ``\n`` 转换为 env 变量。
    重要：这只是 **客户端** 秘密。Gateway 实际是否强制执行 Bearer 检查由 Gateway 自身决定（其自己的 ``TDAI_GATEWAY_API_KEY`` / ``server.apiKey``）；插件不会将此值传播到启动的 Gateway。如果需要认证验证，操作员必须在两端都配置相同的秘密。
    """
    for var in ("MEMORY_TENCENTDB_GATEWAY_API_KEY", "TDAI_GATEWAY_API_KEY"):
        raw = os.environ.get(var)
        if raw is None:
            continue
        value = raw.strip()
        if value:
            return value
    return None


# Candidate locations searched by _discover_gateway_cmd() when the user has not
# set MEMORY_TENCENTDB_GATEWAY_CMD. Order matters: in-tree checkout (next to
# this file) wins over ad-hoc clones in ``$HOME``.
# 中文：_discover_gateway_cmd() 搜索候选位置时未设置 MEMORY_TENCENTDB_GATEWAY_CMD 的用户。顺序很重要：此文件旁边的内置检出优先于 `$HOME` 中的临时克隆。
_GATEWAY_DISCOVERY_RELATIVE_PATHS = (
    # hermes-plugin/memory/memory_tencentdb/__init__.py → plugin root
    # 中文：hermes-plugin/memory/memory_tencentdb/__init__.py → 插件根目录
    Path("src") / "gateway" / "server.ts",
)
_GATEWAY_DISCOVERY_HOME_PATHS = (
    # New canonical install location (managed by install_hermes_memory_tencentdb.sh
    # and memory-tencentdb-ctl.sh): ~/.memory-tencentdb/tdai-memory-openclaw-plugin/...
    # 中文：新的标准安装位置（由install_hermes_memory_tencentdb.sh和memory-tencentdb-ctl.sh管理）：~/.memory-tencentdb/tdai-memory-openclaw-plugin/...
    Path(".memory-tencentdb") / "tdai-memory-openclaw-plugin" / "src" / "gateway" / "server.ts",
    # Legacy locations (kept for backward compatibility with installations done
    # before the ~/.memory-tencentdb/ consolidation):
    # 中文：遗留位置（为了向后兼容在~/.memory-tencentdb/合并之前完成的安装）：
    Path("tdai-memory-openclaw-plugin") / "src" / "gateway" / "server.ts",
    Path(".hermes") / "plugins" / "tdai-memory-openclaw-plugin" / "src" / "gateway" / "server.ts",
)


def _discover_gateway_cmd() -> Optional[str]:
    """Best-effort fallback to locate the Node Gateway entry point.

    Called only when ``MEMORY_TENCENTDB_GATEWAY_CMD`` is unset, so that a fresh
    checkout works out-of-the-box without the user having to hand-craft an
    absolute launch command. Resolution order:

      1. ``<plugin-root>/src/gateway/server.ts`` (in-tree: this file lives at
         ``<plugin-root>/hermes-plugin/memory/memory_tencentdb/__init__.py``).
      2. Well-known paths under ``$HOME`` (preferred:
         ``~/.memory-tencentdb/tdai-memory-openclaw-plugin``; legacy:
         ``~/tdai-memory-openclaw-plugin`` and
         ``~/.hermes/plugins/tdai-memory-openclaw-plugin``).

    Returns a ready-to-``Popen`` command string wrapping a ``sh -c`` that
    ``cd``-s into the plugin root before exec-ing ``pnpm exec tsx
    src/gateway/server.ts``. The ``cd`` is required because ``tsx`` is
    installed under ``<plugin-root>/node_modules`` and Node's ESM resolver
    searches ``package.json`` from the cwd upward — if we launched ``tsx``
    with the hermes-agent cwd, resolution would fail with
    ``ERR_MODULE_NOT_FOUND``. Using ``sh -c`` keeps the supervisor's
    ``shlex.split`` + ``Popen(argv)`` contract intact (no ``shell=True``).

    Returns ``None`` if no ``server.ts`` candidate exists. The function never
    raises: supervisor-side validation will surface a friendly warning if the
    discovered path later fails to start.
    中文：尽力查找 Node Gateway 的入口点作为回退。
    仅当未设置 ``MEMORY_TENCENTDB_GATEWAY_CMD`` 时调用，以便新克隆可以开箱即用地工作而无需用户手动编写绝对启动命令。解析顺序如下：
    1. ``<plugin-root>/src/gateway/server.ts``（内置：此文件位于 ``<plugin-root>/hermes-plugin/memory/memory_tencentdb/__init__.py``）。
    2. 在家目录下的已知路径（首选：``~/.memory-tencentdb/tdai-memory-openclaw-plugin``；旧版：``~/tdai-memory-openclaw-plugin`` 和 ``~/.hermes/plugins/tdai-memory-openclaw-plugin``）。
    返回一个准备好的 ``Popen`` 命令字符串，该命令字符串包含一个 ``sh -c``，在执行前会先切换到插件根目录并运行 ``pnpm exec tsx src/gateway/server.ts``。需要 ``cd`` 是因为 ``tsx`` 安装在 ``<plugin-root>/node_modules`` 下，并且 Node 的 ESM 解析器从当前工作目录向上搜索 ``package.json` —— 如果我们使用 hermes-agent 当前工作目录启动 ``tsx``，解析将失败并抛出 ``ERR_MODULE_NOT_FOUND``。使用 ``sh -c`` 保持监督者的 ``shlex.split`` + ``Popen(argv)`` 合同不变（不使用 ``shell=True``）。
    如果没有 ``server.ts`` 候选文件则返回 ``None``。此函数从不抛出：在监督者侧验证会显示友好的警告，如果发现的路径后续启动失败。
    """
    import shlex

    here = Path(__file__).resolve()
    # hermes-plugin/memory/memory_tencentdb/__init__.py → parents[3] = plugin root
    # 中文：hermes-plugin/memory/memory_tencentdb/__init__.py → parents[3] = 插件根目录
    plugin_root_candidates: List[Path] = []
    try:
        plugin_root_candidates.append(here.parents[3])
    except IndexError:  # pragma: no cover - defensive; __file__ depth is stable
    # 中文：pragma: no cover - 防御性；__file__ 深度稳定
        pass

    home_raw = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    home = Path(home_raw) if home_raw else None

    searched: List[Path] = []
    for root in plugin_root_candidates:
        for rel in _GATEWAY_DISCOVERY_RELATIVE_PATHS:
            searched.append(root / rel)
    if home is not None:
        for rel in _GATEWAY_DISCOVERY_HOME_PATHS:
            searched.append(home / rel)

    for candidate in searched:
        try:
            if candidate.is_file():
                # candidate = <plugin-root>/src/gateway/server.ts
                # -> parents[2] = <plugin-root>
                # 中文：candidate = <plugin-root>/src/gateway/server.ts
                # -> parents[2] = <plugin-root>
                plugin_root = candidate.parents[2]
                logger.info(
                    "memory-tencentdb Gateway command auto-discovered: %s "
                    "(override with MEMORY_TENCENTDB_GATEWAY_CMD)",
                    candidate,
                )
                # shlex.quote guards against spaces / shell metachars in paths.
                # The inner command mirrors start-memory-tencentdb-gateway.sh:
                #   cd <plugin-root> && exec pnpm exec tsx src/gateway/server.ts
                # 中文：shlex.quote 用于防止路径中的空格和 shell 元字符。
                # 内部命令镜像 start-memory-tencentdb-gateway.sh：
                # cd <plugin-root> && exec pnpm exec tsx src/gateway/server.ts
                inner = (
                    f"cd {shlex.quote(str(plugin_root))} && "
                    "exec pnpm exec tsx src/gateway/server.ts"
                )
                return f"sh -c {shlex.quote(inner)}"
        except OSError:  # pragma: no cover - e.g. permission errors on is_file
        # 中文：pragma: no cover - e.g. is_file 的权限错误
            continue

    logger.debug(
        "memory-tencentdb Gateway auto-discovery found no server.ts under: %s",
        ", ".join(str(p) for p in searched) or "<no candidates>",
    )
    return None


# Search tool limit bounds (shared by memory_search and conversation_search).
# 中文：搜索工具限制边界（由 memory_search 和 conversation_search 共享）。
_DEFAULT_SEARCH_LIMIT = 5
_MAX_SEARCH_LIMIT = 20


def _coerce_limit(
    raw: Any,
    *,
    default: int = _DEFAULT_SEARCH_LIMIT,
    maximum: int = _MAX_SEARCH_LIMIT,
) -> int:
    """Coerce a tool-call ``limit`` arg into a valid int in ``[1, maximum]``.

    LLM tool calls don't always honor the JSON Schema ``type: integer``
    declaration — we regularly see strings ("10"), floats ("10.5"), None,
    or booleans. A bare ``int(x)`` either raises ValueError (string "abc",
    "10.5") or silently coerces True/False to 1/0, which would surface as
    a useless ``Tool call failed: invalid literal for int()`` back to the
    model. Instead we:

      * accept None / empty string -> return ``default``;
      * reject bool explicitly (bool is an ``int`` subclass in Python, and
        ``int(True) == 1`` is almost never what the caller meant);
      * accept int / float / numeric-looking strings via float() then int();
      * clamp the result to ``[1, maximum]``;
      * on any failure, log a warning and fall back to ``default``.
    """
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        logger.warning(
            "memory-tencentdb: ignoring non-numeric limit=%r (bool); "
            "falling back to default %d.",
            raw, default,
        )
        return default
    try:
        # float() handles int, float, and numeric strings uniformly;
        # int() then truncates toward zero.
        # 中文：float() 以统一方式处理整数、浮点数和数值字符串；
        # int() 然后向零截断。
        value = int(float(raw))
    except (TypeError, ValueError):
        logger.warning(
            "memory-tencentdb: ignoring invalid limit=%r (not numeric); "
            "falling back to default %d.",
            raw, default,
        )
        return default
    if value < 1:
        return 1
    if value > maximum:
        return maximum
    return value


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------
# 中文：工具模式

MEMORY_SEARCH_SCHEMA = {
    "name": "memory_tencentdb_memory_search",
    "description": (
        "Search through the user's long-term memories. Use this when you need to "
        "recall specific information about the user's preferences, past events, "
        "instructions, or context from previous conversations. Returns relevant "
        "memory records ranked by relevance."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query describing what you want to recall about the user.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of results to return (default: 5, max: 20).",
            },
            "type": {
                "type": "string",
                "enum": ["persona", "episodic", "instruction"],
                "description": "Optional filter by memory type.",
            },
        },
        "required": ["query"],
    },
}

CONVERSATION_SEARCH_SCHEMA = {
    "name": "memory_tencentdb_conversation_search",
    "description": (
        "Search through past conversation history (raw dialogue records). "
        "Use when memory_tencentdb_memory_search doesn't have the information "
        "you need, or when you want to find specific past conversations or "
        "exact words the user said before."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query describing what conversation content you want to find.",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of messages to return (default: 5, max: 20).",
            },
        },
        "required": ["query"],
    },
}


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------
# 中文：MemoryProvider 实现

class MemoryTencentdbProvider(MemoryProvider):
    """memory-tencentdb four-layer memory via local Gateway sidecar.

    中文：通过本地 Gateway 边车实现 memory-tencentdb 四层内存。
    """

    def __init__(self):
        self._supervisor: Optional[GatewaySupervisor] = None
        self._client: Optional[MemoryTencentdbSdkClient] = None
        self._session_id = ""
        self._user_id = ""
        self._gateway_available = False
        self._initialized = False  # Track if initialize() has been called
        # 中文：跟踪 initialize() 是否已被调用

        # Background sync threads.
        # We allow at most _MAX_INFLIGHT_SYNCS in-flight sync threads at any
        # time. Stuck threads (e.g. Gateway hung mid-capture) are tracked in
        # _active_syncs so shutdown can still join them and we never lose
        # references to spawned threads. _sync_lock guards both fields.
        # 中文：后台同步线程。
        # 任何时候最多允许 _MAX_INFLIGHT_SYNCS 条在途同步线程。卡住的线程（例如网关捕获中途挂起）会被跟踪在 _active_syncs 中，以便关闭时仍能加入它们并确保不会丢失任何启动的线程。_sync_lock 同时保护这两个字段。
        self._sync_lock = threading.Lock()
        self._active_syncs: List[threading.Thread] = []

        # Circuit breaker
        # 中文：断路器
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0

        # Gateway auto-resurrect state.
        # _recover_lock ensures only one thread at a time actually calls
        # supervisor.ensure_running() (which can block up to 30s). Other
        # threads that see a failure will try the lock non-blockingly and
        # fall through — they never wait, so recovery attempts never add
        # latency to business calls.
        # _last_recover_attempt gates how often we retry when revival keeps
        # failing (e.g. gateway binary missing, node not installed).
        # Initialized to -inf (rather than 0.0) because time.monotonic()'s
        # reference point is undefined — on some platforms (notably macOS)
        # it starts near zero at process start, which would make the
        # ``now - 0.0 < _RECOVER_COOLDOWN_SECS`` check swallow the very
        # first recovery attempt. Using -inf guarantees the first attempt
        # always passes the throttle.
        # 中文：网关自动复活状态。
        # _recover_lock 确保每次只有一个线程实际调用 supervisor.ensure_running()（该操作可能会阻塞长达 30 秒）。其他看到失败的线程会非阻塞地尝试获取锁并继续执行——它们从不等待，因此恢复尝试从不会增加业务调用的延迟。
        # _last_recover_attempt 控制在复活持续失败时我们多久重试一次（例如网关二进制文件缺失或节点未安装）。
        # 初始化为 -inf 而不是 0.0 是因为 time.monotonic() 的参考点是未定义的——在某些平台上（特别是 macOS），它会在进程启动时接近零，这会使 ``now - 0.0 < _RECOVER_COOLDOWN_SECS`` 检查吞下第一次恢复尝试。使用 -inf 可以保证第一次尝试总是通过限流检查。
        self._recover_lock = threading.Lock()
        self._last_recover_attempt = float("-inf")

        # Watchdog state.
        # The watchdog runs as a daemon thread that periodically (every
        # _WATCHDOG_INTERVAL_SECS) verifies the Gateway is alive and, on
        # failure, calls _try_recover_gateway(). This breaks the
        # "stuck-in-False" deadlock where business requests short-circuit on
        # _gateway_available == False and never reach the failure path that
        # would trigger recovery. _watchdog_stop is an Event so shutdown can
        # signal a clean exit without waiting a full polling interval.
        # 中文：看门狗状态。
        # 看门狗作为一个守护线程运行，并定期（每隔 _WATCHDOG_INTERVAL_SECS）验证网关是否存活，如果失败则调用 _try_recover_gateway()。这打破了“卡在 False”死锁，即业务请求因 _gateway_available == False 而短路并从未到达会触发恢复的失败路径。_watchdog_stop 是一个 Event，以便关闭时可以干净退出而无需等待完整的轮询间隔。
        self._watchdog_thread: Optional[threading.Thread] = None
        self._watchdog_stop = threading.Event()

    # -- Properties -----------------------------------------------------------
    # 中文：-- 属性 -----------------------------------------------------------

    @property
    def name(self) -> str:
        return "memory_tencentdb"

    # -- Circuit breaker ------------------------------------------------------
    # 中文：-- 断路器 ------------------------------------------------------

    def _is_breaker_open(self) -> bool:
        if self._consecutive_failures < _BREAKER_THRESHOLD:
            return False
        if time.monotonic() >= self._breaker_open_until:
            self._consecutive_failures = 0
            return False
        return True

    def _record_success(self):
        self._consecutive_failures = 0

    def _record_failure(self):
        self._consecutive_failures += 1
        if self._consecutive_failures >= _BREAKER_THRESHOLD:
            self._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
            logger.warning(
                "memory-tencentdb circuit breaker tripped after %d failures. Pausing for %ds.",
                self._consecutive_failures, _BREAKER_COOLDOWN_SECS,
            )

    # -- Gateway auto-resurrect ----------------------------------------------
    # 中文：-- 网关自动复活 ----------------------------------------------

    def _try_recover_gateway(self, *, bypass_cooldown: bool = False) -> bool:
        """Best-effort: re-probe and, if needed, re-launch the Gateway.

        Called from the *failure* path of prefetch / sync_turn / handle_tool_call
        so a transient Gateway crash during an active Hermes session is not
        stuck behind the 60s circuit breaker. Also called from the watchdog
        thread (``bypass_cooldown=True``) which has its own cadence and must
        not be throttled by the request-driven 15s gate.

        Guarantees (do not break these without revisiting callers):
          * Never raises — exceptions are logged and swallowed.
          * Never blocks a losing thread: uses ``acquire(blocking=False)``.
            If another thread is already attempting recovery, we return
            ``False`` immediately.
          * Throttled by ``_RECOVER_COOLDOWN_SECS`` so a Gateway that
            refuses to start does not burn CPU on every failed request.
            The watchdog opts out of this throttle via ``bypass_cooldown``.
          * Refuses to run after ``shutdown()`` (detected via
            ``self._supervisor is None``) so we never resurrect a provider
            that the host has released.
          * On success: refreshes ``self._client`` / ``self._gateway_available``
            and resets the circuit breaker so the very next request isn't
            falsely blocked.
          * On failure: records the attempt timestamp; does NOT touch the
            circuit breaker (the caller already recorded a failure).
        中文：尽力重新探测并如需的话重新启动 Gateway。
        从预取 / 同步轮次 / 处理工具调用的故障路径中调用，以避免在活跃 Hermes 会话期间 Gateway 瞬时崩溃而被 60 秒断路器卡住。也从看门狗线程（``bypass_cooldown=True``）中调用，该线程有自己的节奏且不应受到请求驱动的 15 秒闸门限制。
        保证条件（在不破坏调用者的情况下不要打破这些规则）：
        * 不抛出异常 —— 异常会被记录并吞下。
        * 不阻塞失败线程：使用 ``acquire(blocking=False)``。如果另一个线程正在尝试恢复，我们立即返回 ``False``。
        * 通过 ``_RECOVER_COOLDOWN_SECS`` 被限制以防止 Gateway 拒绝启动时每失败一次请求都占用 CPU —— 监控者通过 ``bypass_cooldown`` 选择退出此限制。
        * 在调用 ``shutdown()`` 后拒绝运行（检测到 ``self._supervisor is None``）以免复活主机已释放的提供者。
        * 成功时：刷新 ``self._client`` / ``self._gateway_available`` 并重置断路器，以便下一次请求不会被错误地阻塞。
        * 失败时：记录尝试时间戳；不触发电路断路器（调用者已经记录了失败）。
        """
        supervisor = self._supervisor
        if supervisor is None:
            # Either initialize() was never called, or shutdown() already ran.
            # 中文：要么initialize()从未被调用，要么shutdown()已经运行过。
            return False

        if not bypass_cooldown:
            now = time.monotonic()
            if now - self._last_recover_attempt < _RECOVER_COOLDOWN_SECS:
                return False

        if not self._recover_lock.acquire(blocking=False):
            # Another thread is already attempting recovery — let it work.
            # 中文：另一个线程已经在尝试恢复——让它来完成吧。
            return False

        try:
            # Re-check supervisor under the lock: shutdown() could have set it
            # to None between our first read and acquiring the lock.
            # 中文：在锁下重新检查监督者：shutdown()可能在我们第一次读取和获取锁之间将其设置为None。
            supervisor = self._supervisor
            if supervisor is None:
                return False

            # Double-check the cooldown under the lock too: another recovery
            # may have completed between our read and the acquire().
            # 中文：同样，在锁下也再次检查冷却时间：另一个恢复操作可能在我们的读取和acquire()之间已经完成了。
            if not bypass_cooldown:
                now = time.monotonic()
                if now - self._last_recover_attempt < _RECOVER_COOLDOWN_SECS:
                    return False

            # Fast path: maybe the Gateway is already back (someone else
            # restarted it, or it was a transient blip).
            # 中文：快速路径：网关也许已经恢复正常运行（可能是其他人重启了它，或者只是一次瞬时故障）。
            if supervisor.is_running():
                logger.info(
                    "memory-tencentdb Gateway is reachable again; restoring provider state."
                )
                ok = True
            else:
                logger.warning(
                    "memory-tencentdb Gateway appears down; attempting to resurrect."
                )
                ok = supervisor.ensure_running()

            self._last_recover_attempt = time.monotonic()

            if ok:
                # Reattach the client (supervisor owns the authoritative one).
                # 中文：重新连接客户端（监督者拥有权威版本）。
                self._client = supervisor.client
                self._gateway_available = True
                # Clear the breaker so the next request can proceed
                # immediately instead of being blocked by the 60s cooldown.
                # 中文：清除断路器以便下一个请求可以立即处理而不是被60秒的冷却时间阻塞。
                self._consecutive_failures = 0
                self._breaker_open_until = 0.0
                logger.info("memory-tencentdb Gateway recovery succeeded.")
                return True

            logger.warning(
                "memory-tencentdb Gateway recovery failed; will retry no sooner than %ds.",
                _RECOVER_COOLDOWN_SECS,
            )
            return False
        except Exception as e:  # defensive: never propagate to caller
        # 中文：防御性：绝不向上层传播
            self._last_recover_attempt = time.monotonic()
            logger.warning("memory-tencentdb Gateway recovery raised: %s", e)
            return False
        finally:
            self._recover_lock.release()

    # -- Watchdog & lazy probe -----------------------------------------------
    # 中文：------------------ 看门狗 & 懒探测 -------------------------------

    def _ensure_alive_for_request(self) -> bool:
        """Lazy probe used by the request short-circuit guards.

        Problem this solves: prefetch / sync_turn / handle_tool_call all
        return early when ``_gateway_available`` is False, which means a
        provider that failed to start (or was tripped by the 60s breaker
        and never re-enabled) can never recover via the request path —
        recovery only runs in the failure ``except`` branch, but the guard
        prevents requests from ever reaching that branch.

        This method gives the guards a way out: when the breaker is closed
        but ``_gateway_available`` is False, attempt a single recovery
        synchronously (subject to the same lock + cooldown as the failure
        path). On success the caller can proceed with the real request; on
        failure it returns the same empty / disabled response as before.

        Safe to call from any thread. Never raises. Returns the value of
        ``_gateway_available`` after the attempt.
        中文：用于请求短路保护的惰性探测方法。
        解决的问题：预取 / 同步轮次 / 处理工具调用在 ``_gateway_available`` 为 False 时会提前返回，这意味着未能启动的提供者（或被 60 秒断路器触发且从未重新启用）将无法通过请求路径恢复 —— 恢复仅在故障分支的异常部分运行，但保护机制阻止请求到达该分支。
        此方法为保护机制提供了出路：当断路器关闭而 ``_gateway_available`` 为 False 时，尝试同步执行一次单次恢复（受相同的锁和冷却时间限制）。成功后调用者可以继续处理实际请求；失败则返回与之前相同的空 / 禁用响应。
        可从任何线程安全地调用。从不抛出异常。返回 ``_gateway_available`` 的值。
        """
        if self._gateway_available:
            return True
        if self._is_breaker_open():
            # Breaker takes precedence: respect its 60s cooldown so we do
            # not turn every request into a Gateway-restart attempt during
            # an outage.
            # 中文：断路器优先：尊重其60秒冷却时间，以免在故障期间每次请求都变成网关重启尝试。
            return False
        # Try to bring the Gateway back. This is throttled by the same
        # 15s cooldown as the failure path, so a flood of requests won't
        # cause a recovery storm.
        # 中文：尝试恢复网关。此操作由相同的15秒冷却时间限制，因此不会因大量请求而导致恢复风暴。
        self._try_recover_gateway()
        return self._gateway_available

    def _start_watchdog(self) -> None:
        """Start the background watchdog thread (idempotent).

        The watchdog is the only mechanism that can recover from the
        "Gateway dies while no requests are in flight" scenario. It also
        breaks the deadlock where _gateway_available is stuck False and
        every request short-circuits before triggering recovery.
        中文：启动后台看门狗线程（幂等）。
        看门狗是唯一可以从“网关在无请求传输时死机”场景中恢复的机制。它还可以打破_gateway_available 被卡住 False 的死锁，从而避免每次请求短路而不触发恢复。
        """
        if self._watchdog_thread is not None and self._watchdog_thread.is_alive():
            return
        self._watchdog_stop.clear()
        thread = threading.Thread(
            target=self._watchdog_loop,
            daemon=True,
            name="memory-tencentdb-watchdog",
        )
        self._watchdog_thread = thread
        thread.start()

    def _watchdog_loop(self) -> None:
        """Periodically verify Gateway health and resurrect on death.

        Runs until ``_watchdog_stop`` is set (by ``shutdown()``) or until
        the supervisor reference is dropped. Each iteration:

          1. Snapshot the supervisor reference. If None → exit (provider
             was shut down).
          2. Cheap path: if our own child PID is alive AND ``_gateway_available``
             is True, do nothing. Skips the HTTP round-trip in the common
             happy path.
          3. Otherwise, perform a real health check via supervisor.is_running().
             On success and ``_gateway_available`` is False (e.g. someone
             externally restarted the Gateway), reattach the client.
          4. On failure, call ``_try_recover_gateway(bypass_cooldown=True)``.
             The watchdog has its own pacing (``_WATCHDOG_INTERVAL_SECS``)
             so it must not be subject to the request-driven cooldown.

        All exceptions are logged and swallowed — the watchdog must never
        crash and leave the provider unsupervised.
        中文：周期性地验证网关健康状况并在其死亡时使其复活。
        运行直到 _watchdog_stop 被设置（由 shutdown() 设置）或直到 supervisor 引用被丢弃。每个迭代：
        1. 拷贝 supervisor 引用。如果为 None → 退出（提供者已关闭）。
        2. 快速路径：如果我们的子进程 PID 还活着并且 _gateway_available 为 True，则不做任何操作。跳过了常见的快乐路径中的 HTTP 循环。
        3. 否则，通过 supervisor.is_running() 执行真正的健康检查。成功且 _gateway_available 为 False（例如有人外部重启了网关）时重新连接客户端。
        4. 失败时调用 _try_recover_gateway(bypass_cooldown=True)。看门狗有自己的节奏 (_WATCHDOG_INTERVAL_SECS)，因此不应受到请求驱动的冷却期的影响。
        所有异常都会被记录并吞下——看门狗必须永不崩溃，以免让提供者无人监管。
        """
        logger.debug(
            "memory-tencentdb watchdog started (interval=%.1fs)",
            _WATCHDOG_INTERVAL_SECS,
        )
        while not self._watchdog_stop.wait(timeout=_WATCHDOG_INTERVAL_SECS):
            try:
                supervisor = self._supervisor
                if supervisor is None:
                    # Provider was shut down between ticks.
                    # 中文：提供者在两次心跳之间被关闭了。
                    break

                # Cheap happy path: child is alive and we're already marked
                # available. Nothing to do.
                # 中文：简单的成功路径：子进程存活且我们已标记为可用。无需执行任何操作。
                if self._gateway_available and supervisor.is_process_alive():
                    continue

                # Either we never marked available, the child died, or the
                # Gateway was started externally (no Popen handle but maybe
                # listening on the port). Do a real health check.
                # 中文：要么我们从未标记为可用，子进程已死亡，或者网关外部启动（没有Popen句柄但可能监听端口）。进行真正的健康检查。
                healthy = False
                try:
                    healthy = supervisor.is_running()
                except Exception as e:  # pragma: no cover - defensive
                # 中文：pragma: no cover - 防御性
                    logger.debug(
                        "memory-tencentdb watchdog health probe raised: %s", e,
                    )

                if healthy:
                    if not self._gateway_available:
                        # Externally revived (or first-time success after a
                        # bumpy start): reattach without re-spawning.
                        # 中文：外部恢复（或在坎坷开始后首次成功）：重新绑定而不重新生成子进程。
                        logger.info(
                            "memory-tencentdb watchdog: Gateway is reachable; "
                            "restoring provider state."
                        )
                        self._client = supervisor.client
                        self._gateway_available = True
                        self._consecutive_failures = 0
                        self._breaker_open_until = 0.0
                    continue

                # Truly down. Attempt resurrection, bypassing the request-path
                # cooldown — the watchdog itself enforces pacing.
                # 中文：真正宕机。尝试复活，绕过请求路径冷却时间——看门狗本身会限制节奏。
                logger.warning(
                    "memory-tencentdb watchdog: Gateway unreachable; "
                    "attempting to resurrect."
                )
                self._try_recover_gateway(bypass_cooldown=True)
            except Exception as e:  # pragma: no cover - defensive
            # 中文：pragma: no cover - 防御性
                logger.warning(
                    "memory-tencentdb watchdog iteration raised (continuing): %s", e,
                )

        logger.debug("memory-tencentdb watchdog exiting")

    def _stop_watchdog(self) -> None:
        """Signal the watchdog to exit and join briefly. Safe if not started.

        中文：向看门狗发送退出信号并短暂等待加入。未启动时安全。
        """
        self._watchdog_stop.set()
        thread = self._watchdog_thread
        self._watchdog_thread = None
        if thread is None:
            return
        thread.join(timeout=_WATCHDOG_SHUTDOWN_TIMEOUT_SECS)
        if thread.is_alive():
            # Daemon thread, will not block interpreter exit; just log so
            # users can correlate with Gateway hangs in the health probe.
            # 中文：守护线程，不会阻塞解释器退出；仅用于日志记录以便用户与健康探测中的网关挂起相关联。
            logger.debug(
                "memory-tencentdb watchdog did not exit within %.1fs; "
                "abandoning (daemon).",
                _WATCHDOG_SHUTDOWN_TIMEOUT_SECS,
            )

    # -- Core lifecycle -------------------------------------------------------
    # 中文：-- 核心生命周期 -------------------------------------------------------

    def is_available(self) -> bool:
        """Check if the Gateway is configured or already running.

        Prefers local config checks (env vars) to avoid blocking network calls.
        Only falls back to health check when no env config is present.
        中文：检查 Gateway 是否已配置或已在运行。
        优先使用本地配置检查（环境变量），避免阻塞式网络调用。
        仅当没有环境配置时，才回退到健康检查。
        """
        # Fast path: env var configured → assume available (will verify in initialize)
        # 中文：快速路径：环境变量配置 → 假设可用（将在初始化时验证）
        if os.environ.get("MEMORY_TENCENTDB_GATEWAY_CMD"):
            return True
        if os.environ.get("MEMORY_TENCENTDB_GATEWAY_PORT"):
            return True
        # Slow path: no env config, try a quick health check.
        # Use validated resolvers so a malformed env var never raises here
        # (is_available must never throw: it's called during provider
        # registration and an exception would break the whole plugin).
        # 中文：慢速路径：没有环境配置，尝试进行快速健康检查。
        host = _resolve_gateway_host()
        port = _resolve_gateway_port()
        api_key = _resolve_gateway_api_key()
        client = MemoryTencentdbSdkClient(
            base_url=f"http://{host}:{port}",
            timeout=2,
            api_key=api_key,
        )
        try:
            result = client.health(timeout=2)
            return result.get("status") in ("ok", "degraded")
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        """Start or connect to the Gateway sidecar.

        Gateway startup is performed in a background thread so that
        ``initialize()`` returns immediately and does not block the
        Hermes agent ``__init__`` (which would add up to 30 s latency
        before the first prompt is accepted).

        While the background thread is still running:
          * ``prefetch`` / ``sync_turn`` / ``handle_tool_call`` see
            ``_gateway_available == False`` and gracefully return empty
            results or no-ops — no data is lost because capture will
            succeed once the Gateway comes up and subsequent turns will
            work normally.
          * ``get_tool_schemas`` already returns schemas optimistically
            (gated on ``_initialized``, not ``_gateway_available``),
            so the tools appear in the LLM surface even before the
            Gateway is ready.
        中文：在后台启动或连接到网关侧车。
        网关启动在一个后台线程中执行以确保 initialize() 能立即返回而不阻塞 Hermes 代理的 __init__（这会在第一次接受提示之前增加多达 30 秒的延迟）。
        当后台线程仍在运行时：
        * prefetch / sync_turn / handle_tool_call 看到 _gateway_available == False 并优雅地返回空结果或无操作——因为捕获将在网关启动后成功，后续轮次将正常工作而不会丢失数据。
        * get_tool_schemas 已经乐观地返回了 schema（基于 _initialized 而不是 _gateway_available），因此工具在网关准备好之前就会出现在 LLM 表面。
        """
        self._session_id = session_id
        self._user_id = kwargs.get("user_id", "default")

        host = _resolve_gateway_host()
        port = _resolve_gateway_port()
        # Priority: explicit env var → auto-discovery (in-tree / $HOME fallbacks).
        # Auto-discovery lets fresh checkouts work without manual CMD wiring;
        # it only runs when the env var is not set, so existing deployments
        # are unaffected.
        # 中文：使用验证过的解析器，因此无效的环境变量永远不会在此引发错误
        # (is_available 必须永不抛出异常：它在提供程序注册期间被调用，并且异常会中断整个插件)
        gateway_cmd = os.environ.get("MEMORY_TENCENTDB_GATEWAY_CMD") or _discover_gateway_cmd()
        # Optional Bearer token attached to outbound Gateway requests
        # (off by default). The plugin only handles the client side — if
        # the operator wants the Gateway to enforce auth, they must
        # configure ``TDAI_GATEWAY_API_KEY`` / ``server.apiKey`` on the
        # Gateway side directly so both ends agree on the secret.
        # 中文：优先级：显式环境变量 → 自动发现（内部 / $HOME 回退）。
        api_key = _resolve_gateway_api_key()

        self._supervisor = GatewaySupervisor(
            host=host,
            port=port,
            gateway_cmd=gateway_cmd,
            api_key=api_key,
        )

        # Mark as initialized immediately so tools are registered
        # (get_tool_schemas checks _initialized, not _gateway_available).
        # 中文：自动发现允许新鲜检出无需手动 CMD 配置即可工作；
        # 仅在未设置环境变量时运行，因此现有部署不受影响。
        self._initialized = True

        def _background_start():
            """Start / connect to the Gateway in the background.

            中文：在后台启动或连接到网关。
            """
            try:
                available = self._supervisor.ensure_running()
                if available:
                    self._client = self._supervisor.client
                    self._gateway_available = True
                    logger.info(
                        "memory-tencentdb Gateway ready (background start, %s:%d)",
                        host, port,
                    )
                else:
                    logger.warning(
                        "memory-tencentdb Gateway not available after background start. "
                        "Memory features will be disabled until the Gateway is reachable. "
                        "Set MEMORY_TENCENTDB_GATEWAY_CMD to auto-start the Gateway, "
                        "or place the plugin checkout at ~/tdai-memory-openclaw-plugin "
                        "for auto-discovery."
                    )
            except Exception as e:
                logger.warning(
                    "memory-tencentdb background Gateway start failed (non-fatal): %s", e
                )

        # Fast path: if the Gateway is *already* running (e.g. started by
        # systemd, memory-tencentdb-ctl, or a previous session), skip the
        # thread overhead and attach synchronously. The health check takes
        # <100ms for a local Gateway, so this doesn't block meaningfully.
        # 中文：附加到传出网关请求的可选 Bearer 令牌（默认关闭）。插件仅处理客户端方面 — 如果操作员希望网关执行身份验证，则必须
        # 直接在网关侧配置 ``TDAI_GATEWAY_API_KEY`` / ``server.apiKey``，以便两端同意密钥。
        if self._supervisor.is_running():
            self._client = self._supervisor.client
            self._gateway_available = True
            logger.info(
                "memory-tencentdb Gateway already running (%s:%d)",
                host, port,
            )
        else:
            # Gateway is not up yet — start it in the background.
            # 中文：立即标记为初始化以使工具注册
            # (get_tool_schemas 检查 _initialized，而不是 _gateway_available)。
            t = threading.Thread(
                target=_background_start, daemon=True,
                name="tdai-gateway-init",
            )
            t.start()

        # Start the watchdog regardless of the initial start outcome.
        # Even if _background_start fails (e.g. tdai binary missing on
        # first launch), the watchdog will keep retrying so a later
        # external fix (operator installs node, drops the plugin into
        # the discovery path, etc.) is picked up automatically without
        # requiring a hermes restart.
        # 中文：无论初始启动结果如何，都启动看门狗。
        # 即使 _background_start 失败（例如，在首次启动时缺少 tdai 可执行文件），看门狗也会继续重试，以便自动检测后续外部修复（操作员安装节点、将插件放入发现路径等）而无需重启 hermes。
        self._start_watchdog()

    def system_prompt_block(self) -> str:
        if not self._gateway_available:
            return ""
        return (
            "# memory-tencentdb Memory\n"
            f"Active. User: {self._user_id}.\n"
            "Four-layer memory system (L0→L1→L2→L3) with automatic conversation "
            "capture, structured memory extraction, scene blocks, and persona synthesis.\n"
            "Use memory_tencentdb_memory_search to find specific memories, "
            "memory_tencentdb_conversation_search to search raw conversation history."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Synchronous recall — fetch memories in real-time for the current turn.

        中文：同步回忆——实时为当前轮次检索记忆。
        """
        if not query:
            return ""
        # Lazy probe before the short-circuit guard. If the Gateway died but
        # the breaker has not yet tripped (or has since cooled down), this
        # gives the request path a chance to revive it instead of silently
        # returning "" forever. See _ensure_alive_for_request() for the
        # guarantees and rationale.
        # 中文：短路保护之前的懒惰探测。如果网关已死但断路器尚未跳闸（或已经冷却），这可以给请求路径一个机会来恢复它而不是永远返回“”。参见 _ensure_alive_for_request() 以了解保证和理由。
        if not self._ensure_alive_for_request() or not self._client:
            return ""

        effective_session = session_id or self._session_id
        try:
            result = self._client.recall(
                query=query,
                session_key=effective_session,
                user_id=self._user_id,
            )
            context = result.get("context", "")
            self._record_success()
            if context:
                return f"## memory-tencentdb Memory\n{context}"
            return ""
        except Exception as e:
            self._record_failure()
            logger.debug("memory-tencentdb prefetch failed: %s", e)
            # Fire-and-forget attempt to bring the Gateway back for the next
            # call. Never blocks more than supervisor.ensure_running()'s own
            # timeout, and only one thread at a time actually does the work.
            # 中文：无等待尝试在下次调用时恢复网关。从不阻塞超过 supervisor.ensure_running()'s 自身的超时时间，并且每次只有一个线程实际执行工作。
            self._try_recover_gateway()
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """No-op — recall is done synchronously in prefetch().

        中文：空操作——回忆已在 prefetch() 中同步完成。
        """
        pass

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Send the turn to Gateway for capture (non-blocking).

        Threading model:
          * Each call spawns a daemon thread that performs one ``capture``.
          * ``_active_syncs`` retains references to all still-alive threads so
            they are never orphaned when a new sync starts.
          * If ``_MAX_INFLIGHT_SYNCS`` is reached (e.g. Gateway is hung),
            we wait on the oldest thread for ``_SYNC_JOIN_TIMEOUT_SECS`` before
            spawning a new one. If that thread is still alive afterwards we
            still spawn, but keep the stuck thread tracked so ``shutdown`` can
            try to reap it later.
          * All mutations of ``_active_syncs`` are serialized by
            ``_sync_lock`` so concurrent callers (future async entry points)
            cannot leak references via a read/modify/write race.
        中文：将轮次发送给网关进行捕获（非阻塞）。
        线程模型：
        * 每次调用都会启动一个守护线程来执行一次 capture。
        * _active_syncs 保留所有仍在存活的线程的引用，以防止在新同步开始时孤儿化它们。
        * 如果达到 _MAX_INFLIGHT_SYNCS（例如网关挂起），则在最古老的线程上等待 _SYNC_JOIN_TIMEOUT_SECS 之后再启动一个新的。如果该线程仍然活着，则我们仍然会启动它，并继续跟踪卡住的线程，以便 shutdown 可以稍后尝试回收它。
        * 所有对 _active_syncs 的修改都由 _sync_lock 序列化，因此并发调用（未来的异步入口点）无法通过读/改写竞争导致引用泄漏。
        """
        # Lazy probe — same rationale as prefetch(). Without this, a
        # provider stuck in the False/closed-breaker state would silently
        # drop every captured turn until the watchdog (or a manual
        # restart) revived it.
        # 中文：懒惰探测 —— 同 prefetch() 的理由相同。如果没有这个，处于 False/闭合断路器状态的提供商会默默地丢弃每个捕获转弯直到看门狗（或手动重启）将其恢复。
        if not self._ensure_alive_for_request() or not self._client:
            return

        effective_session = session_id or self._session_id
        client = self._client

        def _sync():
            try:
                client.capture(
                    user_content=user_content,
                    assistant_content=assistant_content,
                    session_key=effective_session,
                    user_id=self._user_id,
                )
                self._record_success()
            except Exception as e:
                self._record_failure()
                logger.warning("memory-tencentdb sync failed: %s", e)
                # Trigger recovery from a background thread — safe because
                # _try_recover_gateway itself is non-blocking under
                # contention and swallows all exceptions.
                # 中文：从后台线程触发恢复 —— 安全因为 _try_recover_gateway 本身在争用下是非阻塞的，并且吞咽所有异常。
                self._try_recover_gateway()

        # Reap finished threads and, if at capacity, wait on the oldest one.
        # We pick the oldest non-finished candidate *outside* the lock so the
        # join() call doesn't hold _sync_lock (holding a lock across a
        # potentially slow join would serialize every incoming turn).
        # 中文：回收已完成的线程，如果已达到容量限制，则等待最古老的线程。我们选择锁外部的最古老的未完成候选者，以便 join() 调用不会持有 _sync_lock（跨潜在慢速 join 持有锁会序列化每个传入转弯）。
        oldest_to_join: Optional[threading.Thread] = None
        with self._sync_lock:
            self._active_syncs = [t for t in self._active_syncs if t.is_alive()]
            if len(self._active_syncs) >= _MAX_INFLIGHT_SYNCS:
                oldest_to_join = self._active_syncs[0]

        if oldest_to_join is not None:
            oldest_to_join.join(timeout=_SYNC_JOIN_TIMEOUT_SECS)
            if oldest_to_join.is_alive():
                logger.warning(
                    "memory-tencentdb sync backlog: oldest sync thread still "
                    "running after %.1fs; %d in-flight threads tracked. "
                    "Continuing with a new sync; Gateway may be hung.",
                    _SYNC_JOIN_TIMEOUT_SECS, len(self._active_syncs),
                )

        thread = threading.Thread(
            target=_sync, daemon=True, name="memory-tencentdb-sync",
        )
        with self._sync_lock:
            # Reap again in case the join above freed slots, then register.
            # 中文：再次回收以防止上面的 join 释放槽位，然后注册。
            self._active_syncs = [t for t in self._active_syncs if t.is_alive()]
            self._active_syncs.append(thread)
        thread.start()

    def shutdown(self) -> None:
        """Clean shutdown — flush and release resources.

        中文：清潔關機——刷新並釋放資源。
        """
        # Stop the watchdog FIRST so it does not race with shutdown by
        # spawning a fresh recovery attempt while we're tearing the
        # supervisor down. Idempotent + non-blocking-bounded.
        # 中文：首先停止看门狗，以免在我们拆卸 supervisor 的同时它启动新的恢复尝试。幂等且非阻塞边界限制。
        self._stop_watchdog()

        # Wait for every background sync thread we ever spawned (not just the
        # most recent one). Taking a snapshot under the lock first means new
        # calls to sync_turn during shutdown can't race with our iteration.
        # 中文：等待我们曾经spawn的每个后台同步线程（而不仅仅是最近的一个）。在锁下进行快照意味着在关闭期间的新sync_turn调用将不会与我们的迭代发生竞争。
        with self._sync_lock:
            pending = list(self._active_syncs)
            self._active_syncs.clear()

        for t in pending:
            if not t.is_alive():
                continue
            t.join(timeout=_SHUTDOWN_JOIN_TIMEOUT_SECS)
            if t.is_alive():
                # Threads are daemon, so they won't block interpreter exit —
                # but log so users can correlate with Gateway issues.
                # 中文：这些线程是守护进程，因此不会阻塞解释器退出——但记录日志以便用户可以关联到网关问题。
                logger.warning(
                    "memory-tencentdb shutdown: sync thread %s still alive "
                    "after %.1fs; abandoning (daemon).",
                    t.name, _SHUTDOWN_JOIN_TIMEOUT_SECS,
                )

        # Send session end if Gateway is available
        # 中文：如果网关可用，则发送会话结束
        if self._client and self._gateway_available:
            try:
                self._client.end_session(
                    session_key=self._session_id,
                    user_id=self._user_id,
                )
            except Exception as e:
                logger.debug("memory-tencentdb session end failed: %s", e)

        # Note: do NOT shut down the supervisor/Gateway here — it may serve
        # other sessions. The Gateway manages its own lifecycle.
        # We *do* drop our reference to the supervisor so any in-flight
        # _try_recover_gateway() call sees self._supervisor is None and
        # bails out instead of resurrecting a released provider.
        # 中文：注意：不要在此处关闭监督者/网关 — 它可能为其他会话服务。网关管理自己的生命周期。
        # 我们确实释放了对监督者的引用，因此任何在途的_try_recover_gateway()调用将看到self._supervisor为None并退出而不是复活一个已释放的服务提供商。
        self._client = None
        self._gateway_available = False
        self._initialized = False
        self._supervisor = None

    # -- Tools ----------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Optimistically return tool schemas if Gateway is configured or running.
        # This is critical because MemoryManager.add_provider() calls
        # get_tool_schemas() BEFORE initialize() to build the _tool_to_provider
        # routing table. If we return [] here, tools won't be routable
        # even after initialize() succeeds (despite _refresh_tool_registration).
        # 中文：如果网关配置或运行，则乐观地返回工具模式。这至关重要，因为MemoryManager.add_provider()在initialize()之前调用get_tool_schemas()以构建_tool_to_provider路由表。如果我们在此处返回[]，即使initialize()成功后工具也无法路由（尽管_refresh_tool_registration）。
        if self._gateway_available or self._initialized:
            return [MEMORY_SEARCH_SCHEMA, CONVERSATION_SEARCH_SCHEMA]
        # Pre-init: check if Gateway is likely to be available
        # 中文：预初始化：检查网关可能可用
        if os.environ.get("MEMORY_TENCENTDB_GATEWAY_CMD") or os.environ.get("MEMORY_TENCENTDB_GATEWAY_PORT"):
            return [MEMORY_SEARCH_SCHEMA, CONVERSATION_SEARCH_SCHEMA]
        return []

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        # Lazy probe — gives tool-call path the same self-heal opportunity
        # as prefetch / sync_turn. Without this, an LLM-issued memory_search
        # call could see "Gateway is not connected" forever even after the
        # Gateway came back up, because nothing else would flip
        # _gateway_available back to True.
        # 中文：懒加载探测 — 给工具调用路径提供同样的自我修复机会
        # 如同prefetch / sync_turn。否则，一个由LLM发出的memory_search调用可能会永远看到“网关未连接”，即使网关已经恢复上线，因为没有任何其他操作会将_gateway_available重新设置为True。
        self._ensure_alive_for_request()
        if not self._client:
            return json.dumps({
                "error": "memory-tencentdb Gateway is not connected. Memory search is temporarily unavailable.",
                "hint": "The Gateway may still be starting up. Try again in a moment.",
            })
        if self._is_breaker_open():
            return json.dumps({"error": "memory-tencentdb Gateway temporarily unavailable (circuit breaker open)."})

        try:
            if tool_name == "memory_tencentdb_memory_search":
                query = args.get("query", "")
                if not query:
                    return json.dumps({"error": "Missing required parameter: query"})
                result = self._client.search_memories(
                    query=query,
                    limit=_coerce_limit(args.get("limit")),
                    type_filter=args.get("type", ""),
                )
                self._record_success()
                return json.dumps(result)

            if tool_name == "memory_tencentdb_conversation_search":
                query = args.get("query", "")
                if not query:
                    return json.dumps({"error": "Missing required parameter: query"})
                result = self._client.search_conversations(
                    query=query,
                    limit=_coerce_limit(args.get("limit")),
                )
                self._record_success()
                return json.dumps(result)

            return json.dumps({"error": f"Unknown tool: {tool_name}"})

        except Exception as e:
            self._record_failure()
            # Same fire-and-forget recovery as prefetch(); the error
            # returned to the LLM below is unchanged.
            # 中文：与prefetch()相同的无回执恢复；下面返回给LLM的错误没有改变
            self._try_recover_gateway()
            return json.dumps({"error": f"Tool call failed: {e}"})

    # -- Optional hooks -------------------------------------------------------
    # 中文：-- 可选挂钩 -------------------------------------------------------

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in memory writes to memory-tencentdb for indexing.

        中文：将内置记忆写入镜像到 memory-tencentdb 以便建立索引。
        """
        # TODO: Implement mirroring of Hermes builtin MEMORY.md/USER.md writes
        # to memory-tencentdb's recall index for conflict suppression and dedup.
        # 中文：TODO: 实现对 Hermes 内置 MEMORY.md/USER.md 写入内容的镜像
        # 到 memory-tencentdb 的回溯索引，以实现冲突抑制和去重。
        pass

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Trigger session-level flush on the Gateway.

        中文：在网关上触发会话级刷新。
        """
        if self._client and self._gateway_available:
            try:
                self._client.end_session(
                    session_key=self._session_id,
                    user_id=self._user_id,
                )
            except Exception as e:
                logger.debug("memory-tencentdb on_session_end failed: %s", e)

    # -- Config ---------------------------------------------------------------
    # 中文：-- 配置 ---------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "gateway_cmd",
                "description": "Command to start the memory-tencentdb Gateway (e.g. 'node --import tsx /path/to/server.ts')",
                "env_var": "MEMORY_TENCENTDB_GATEWAY_CMD",
                "required": False,
            },
            {
                "key": "gateway_host",
                "description": "Gateway host",
                "default": "127.0.0.1",
                "env_var": "MEMORY_TENCENTDB_GATEWAY_HOST",
            },
            {
                "key": "gateway_port",
                "description": "Gateway port",
                "default": "8420",
                "env_var": "MEMORY_TENCENTDB_GATEWAY_PORT",
            },
            {
                "key": "gateway_api_key",
                "description": (
                    "Optional Bearer token attached to outbound Gateway "
                    "requests. Set this to the same secret you configure on "
                    "the Gateway side (``TDAI_GATEWAY_API_KEY`` / "
                    "``server.apiKey``) so the Bearer comparison succeeds. "
                    "Leave unset to skip the Authorization header entirely "
                    "(legacy default; matches an open Gateway)."
                ),
                "secret": True,
                "required": False,
                "env_var": "MEMORY_TENCENTDB_GATEWAY_API_KEY",
            },
            {
                "key": "llm_api_key",
                "description": "LLM API key (for Gateway's standalone LLM calls)",
                "secret": True,
                "required": True,
                "env_var": "MEMORY_TENCENTDB_LLM_API_KEY",
            },
            {
                "key": "llm_base_url",
                "description": "LLM API base URL",
                "default": "https://api.openai.com/v1",
                "env_var": "MEMORY_TENCENTDB_LLM_BASE_URL",
            },
            {
                "key": "llm_model",
                "description": "LLM model name",
                "default": "gpt-4o",
                "env_var": "MEMORY_TENCENTDB_LLM_MODEL",
            },
        ]


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------
# 中文：插件入口点

def register(ctx) -> None:
    """Register memory-tencentdb as a memory provider plugin.

    中文：将memory-tencentdb注册为内存提供插件.
    """
    ctx.register_memory_provider(MemoryTencentdbProvider())
