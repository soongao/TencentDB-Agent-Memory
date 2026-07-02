"""Tests for memory-tencentdb provider self-healing.

Verifies the fixes that prevent the "tdai dies and is never resurrected"
class of failures:

  1. Watchdog thread starts on initialize() and resurrects a dead Gateway
     even when no business request triggers the failure path.
  2. Lazy probe (_ensure_alive_for_request) lets a request short-circuit
     guard self-heal before returning empty, breaking the
     "_gateway_available stuck at False" deadlock.
  3. is_process_alive() correctly distinguishes "child has exited" from
     "child still running but unhealthy".
  4. shutdown() cleanly stops the watchdog and drops the supervisor so
     subsequent recovery attempts are no-ops.

These tests use mocks for the supervisor / client so they neither spawn
real Node processes nor open network sockets.
中文：memory-tencentdb提供者自我修复的测试。
验证防止“tdai死亡且永不复生”类失败的修正：
1. 在initialize()时启动看门狗线程，并在无业务请求触发故障路径的情况下使死掉的网关复活。
2. 懒探针(_ensure_alive_for_request)允许请求短路，从而在返回空结果前进行自我修复，打破“_gateway_available卡在False”的死锁。
3. is_process_alive()正确地区分“子进程已退出”与“子进程仍在运行但不健康”。
4. shutdown()干净地停止看门狗并释放监督者，使后续的恢复尝试成为无效操作。
这些测试使用了对监督者/客户端的模拟，因此既不会启动真正的节点进程也不会打开网络套接字。
"""

from __future__ import annotations

import os
import pathlib
import sys
import threading
import time
from typing import Optional
from unittest.mock import MagicMock

import pytest

# Inject plugin + hermes-agent roots into sys.path so the provider module
# can be imported regardless of whether tests are invoked from the
# tdai-memory-openclaw-plugin tree (where this file lives at
# hermes-plugin/memory/memory_tencentdb/tests/) or from a hermes-agent
# checkout (where the same file is under tests/plugins/memory/). Mirrors
# the layout used by ``test_gateway_shutdown_leak.py`` next door.
# 中文：将插件+hermes-agent 根目录注入 sys.path，以便无论测试是从 tdai-memory-openclaw-plugin 树（此文件位于 hermes-plugin/memory/memory_tencentdb/tests/）还是从 hermes-agent 源码调用时，都可以导入提供者模块。这与相邻的 ``test_gateway_shutdown_leak.py`` 文件中使用的布局一致。
_THIS_FILE = pathlib.Path(__file__).resolve()
_HERE = _THIS_FILE.parent
# When checked into the plugin repo: parents[4] = repo root,
# hermes-plugin/ holds the importable ``plugins`` package.
# When checked into hermes-agent: the tests/ tree already sits under a
# repo root that exposes ``plugins`` directly, so the extra insertion is
# harmless (sys.path lookups stop at the first match).
# 中文：当插件库提交到代码仓库时：parents[4] = 代码根目录，hermes-plugin/ 包含可导入的 ``plugins`` 模块。
for candidate in (
    _HERE.parents[3] if len(_HERE.parents) >= 4 else None,    # plugin repo: hermes-plugin/
    # 中文：插件仓库: hermes-plugin/
    _HERE.parents[4] if len(_HERE.parents) >= 5 else None,    # hermes-agent root
    # 中文：hermes-agent 根目录
    _HERE.parents[2] if len(_HERE.parents) >= 3 else None,    # fallback
    # 中文：回退
):
    if candidate is not None and (candidate / "plugins").is_dir():
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))

# Optional: hermes-agent provides ``agent.memory_provider``. Tests can set
# HERMES_AGENT_ROOT to point at a sibling checkout if needed.
# 中文：可选：hermes-agent 提供了 ``agent.memory_provider``。测试可以设置 HERMES_AGENT_ROOT 指向一个同级检出（如果需要的话）。
_hermes_root = os.environ.get("HERMES_AGENT_ROOT")
if not _hermes_root:
    # Try the canonical sibling layout used by this monorepo.
    # 中文：尝试使用此单仓库中使用的标准兄弟目录布局。
    sibling = _HERE.parents[4] / "hermes-agent" if len(_HERE.parents) >= 5 else None
    if sibling is not None and (sibling / "agent").is_dir():
        _hermes_root = str(sibling)
if _hermes_root and _hermes_root not in sys.path:
    sys.path.insert(0, _hermes_root)

try:
    from plugins.memory.memory_tencentdb import MemoryTencentdbProvider
    from plugins.memory.memory_tencentdb import supervisor as supervisor_module
except ImportError as e:  # pragma: no cover — env-dependent
# 中文：pragma: 不覆盖 — 环境依赖
    pytest.skip(
        f"memory_tencentdb provider not importable ({e}); set HERMES_AGENT_ROOT "
        "to a hermes-agent checkout if running from the plugin repo.",
        allow_module_level=True,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
# 中文：辅助函数


class FakeSupervisor:
    """In-memory stand-in for GatewaySupervisor.

    Lets tests script the sequence of (alive?, healthy?, ensure_running()
    outcome) values without spawning subprocesses or opening sockets.
    中文：内存中的GatewaySupervisor替代品。
    允许测试脚本指定(alive?, healthy?, ensure_running()结果)序列，而无需启动子进程或打开套接字。
    """

    def __init__(self) -> None:
        self.alive = True
        self.healthy = True
        # If set, the next ensure_running() call flips alive+healthy back on.
        # 中文：如果设置，下一次 ensure_running() 调用会将 alive+healthy 重置为开启状态。
        self.respawn_succeeds = True
        self.client = MagicMock(name="MemoryTencentdbSdkClient")
        self.ensure_running_calls = 0
        self.is_running_calls = 0
        self.is_process_alive_calls = 0
        self.shutdown_calls = 0

    def is_running(self) -> bool:
        self.is_running_calls += 1
        return self.healthy

    def is_process_alive(self) -> bool:
        self.is_process_alive_calls += 1
        return self.alive

    def ensure_running(self) -> bool:
        self.ensure_running_calls += 1
        if self.respawn_succeeds:
            self.alive = True
            self.healthy = True
            return True
        return False

    def shutdown(self) -> None:
        self.shutdown_calls += 1
        self.alive = False
        self.healthy = False


def _wait_until(predicate, *, timeout: float = 3.0, interval: float = 0.02) -> bool:
    """Poll ``predicate`` until it returns truthy or ``timeout`` elapses.

    中文：直到`predicate`返回真值或超时为止，循环检查`predicate`。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.fixture()
def fast_watchdog(monkeypatch):
    """Make the watchdog poll every 50 ms instead of 10 s.

    Tests can then trigger a state change and assert the watchdog reacts
    within a tight bound, keeping the suite fast.
    中文：将看门狗的轮询频率从10秒改为50毫秒。
    测试可以触发状态变化并断言看门狗在较紧的时间范围内作出反应，从而保持测试套件的速度。
    """
    import plugins.memory.memory_tencentdb as mod

    monkeypatch.setattr(mod, "_WATCHDOG_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(mod, "_WATCHDOG_SHUTDOWN_TIMEOUT_SECS", 0.5)
    # Also collapse the request-path cooldown so tests do not need to wait
    # 15 s between recovery attempts triggered from prefetch / sync_turn.
    # 中文：同时合并请求路径冷却时间，避免测试在从预取 / sync_turn 触发恢复尝试之间等待 15 秒。
    monkeypatch.setattr(mod, "_RECOVER_COOLDOWN_SECS", 0)
    yield


@pytest.fixture()
def provider_with_fake_supervisor(monkeypatch, fast_watchdog):
    """Yield a MemoryTencentdbProvider wired to a FakeSupervisor.

    We monkey-patch the GatewaySupervisor symbol used inside the provider
    module so initialize() builds a FakeSupervisor instead of the real one.
    The FakeSupervisor is exposed on the provider as ``_fake`` for tests
    to manipulate.
    中文：生成一个与FakeSupervisor绑定的MemoryTencentdbProvider。
    我们在提供者模块内部劫持GatewaySupervisor符号，使得initialize()构建一个FakeSupervisor而非真正的监督者。FakeSupervisor作为`_fake`暴露给测试以供操作。
    """
    import plugins.memory.memory_tencentdb as mod

    fake = FakeSupervisor()

    def _factory(*args, **kwargs):
        return fake

    monkeypatch.setattr(mod, "GatewaySupervisor", _factory)
    # Make the auto-discovery happy: pretend an env var is set so the
    # provider does not try to walk the filesystem looking for server.ts.
    # 中文：让自动发现满意：假装设置了环境变量，使提供者不需要遍历文件系统查找 server.ts 文件。
    monkeypatch.setenv("MEMORY_TENCENTDB_GATEWAY_CMD", "fake-cmd")

    provider = MemoryTencentdbProvider()
    provider.initialize(session_id="test-session", user_id="test-user")
    provider._fake = fake  # attach for test access
    # 中文：用于测试访问的附加项

    # initialize() may have spawned _background_start in another thread.
    # Wait until the provider settles into the "available" state before
    # tests start poking at it. The FakeSupervisor reports healthy from
    # the get-go, so this should be quick.
    # 中文：initialize() 可能在另一个线程中spawn了_background_start。
    # 在测试开始之前，等待提供者稳定到"可用"状态。FakeSupervisor一开始就报告健康状况良好，因此这应该很快。
    _wait_until(lambda: provider._gateway_available, timeout=2.0)

    try:
        yield provider
    finally:
        provider.shutdown()


# ---------------------------------------------------------------------------
# Supervisor.is_process_alive
# ---------------------------------------------------------------------------
# 中文：Supervisor.is_process_alive


class _FakePopen:
    def __init__(self, returncode: Optional[int] = None) -> None:
        self._returncode = returncode

    def poll(self):
        return self._returncode

    @property
    def returncode(self):
        return self._returncode


def test_is_process_alive_returns_false_without_spawn():
    sup = supervisor_module.GatewaySupervisor(gateway_cmd="")
    assert sup.is_process_alive() is False


def test_is_process_alive_true_when_running():
    sup = supervisor_module.GatewaySupervisor(gateway_cmd="")
    sup._process = _FakePopen(returncode=None)
    assert sup.is_process_alive() is True


def test_is_process_alive_false_after_exit():
    sup = supervisor_module.GatewaySupervisor(gateway_cmd="")
    sup._process = _FakePopen(returncode=137)
    assert sup.is_process_alive() is False


def test_reap_dead_process_drops_handle():
    sup = supervisor_module.GatewaySupervisor(gateway_cmd="")
    sup._process = _FakePopen(returncode=137)
    sup._reap_dead_process()
    assert sup._process is None


def test_reap_dead_process_keeps_alive_handle():
    sup = supervisor_module.GatewaySupervisor(gateway_cmd="")
    alive = _FakePopen(returncode=None)
    sup._process = alive
    sup._reap_dead_process()
    assert sup._process is alive


# ---------------------------------------------------------------------------
# Watchdog: detects death, resurrects, and reattaches
# ---------------------------------------------------------------------------
# 中文：看门狗：检测死亡、复活并重新附着


def test_watchdog_starts_after_initialize(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    assert provider._watchdog_thread is not None
    assert provider._watchdog_thread.is_alive()


def test_watchdog_detects_dead_gateway_and_resurrects(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake

    # Simulate "tdai got SIGKILL'd": process is dead, port is silent.
    # 中文：模拟 "tdai 接收到 SIGKILL": 进程已死，端口无声。
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = True
    # Also force the provider into the "stuck" state to mimic the
    # production deadlock described in the issue.
    # 中文：还将提供者强制置于"卡住"状态以模拟生产中描述的问题中的死锁。
    provider._gateway_available = False

    # The watchdog (interval=50ms) should pick this up well within 1s.
    # 中文：每隔50ms的看门狗应该在1s内很好地检测到这一点。
    assert _wait_until(
        lambda: fake.ensure_running_calls >= 1, timeout=2.0
    ), "watchdog never called ensure_running on a dead Gateway"

    # And after the respawn succeeds it must flip availability back on.
    # 中文：并且在 respawn 成功后，必须将其可用性切换回开启状态。
    assert _wait_until(
        lambda: provider._gateway_available, timeout=2.0
    ), "watchdog respawned but never restored _gateway_available"

    # Client was reattached from the (post-respawn) supervisor instance.
    # 中文：客户端从（post-respawn）监督器实例重新附着。
    assert provider._client is fake.client


def test_watchdog_picks_up_external_restart_without_respawning(
    provider_with_fake_supervisor,
):
    """If something external (systemd, operator) brings tdai back, the
    watchdog should NOT spawn a duplicate — it should just notice health
    is back and reattach."""
    provider = provider_with_fake_supervisor
    fake = provider._fake

    # Mark provider as "stuck False" but keep the Gateway healthy.
    # 中文：标记提供者为"stuck False"但保持网关健康。
    provider._gateway_available = False
    fake.alive = True
    fake.healthy = True
    initial_respawns = fake.ensure_running_calls

    assert _wait_until(
        lambda: provider._gateway_available, timeout=2.0
    ), "watchdog never reattached to an externally-healthy Gateway"

    assert fake.ensure_running_calls == initial_respawns, (
        "watchdog spawned a duplicate even though the Gateway was healthy"
    )


def test_watchdog_resets_circuit_breaker_on_recovery(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake

    # Trip the breaker manually (mimics 5 consecutive request failures).
    # 中文：手动触发断路器（模拟连续5次请求失败）。
    provider._consecutive_failures = 999
    provider._breaker_open_until = time.monotonic() + 60
    provider._gateway_available = False
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = True

    assert _wait_until(
        lambda: provider._gateway_available and not provider._is_breaker_open(),
        timeout=2.0,
    ), "watchdog recovered Gateway but did not reset the breaker"


def test_watchdog_stops_on_shutdown(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    thread = provider._watchdog_thread
    assert thread is not None and thread.is_alive()

    provider.shutdown()

    # After shutdown, the thread must wind down promptly.
    # 中文：关闭后，线程必须迅速停止运转。
    thread.join(timeout=1.0)
    assert not thread.is_alive(), "watchdog kept running after shutdown()"


# ---------------------------------------------------------------------------
# Lazy probe: request path self-heals when stuck-False
# ---------------------------------------------------------------------------
# 中文：懒探测：当stuck-False时，请求路径自我修复。


def test_prefetch_recovers_when_stuck_false_and_breaker_closed(
    provider_with_fake_supervisor,
):
    """The original bug: prefetch sees _gateway_available==False and
    short-circuits to "" forever, never giving recovery a chance. After
    the fix, prefetch should attempt a one-shot recovery and proceed."""
    provider = provider_with_fake_supervisor
    fake = provider._fake

    # Stop the watchdog so it cannot sneak in and do the recovery for us;
    # we want to assert that the *request path* is what triggers the heal.
    # 中文：停止看门狗以防止其擅自进行恢复；我们希望断言是*请求路径*触发了修复。
    provider._stop_watchdog()

    # Park the provider in the stuck state.
    # 中文：将提供者置于停滞状态。
    provider._gateway_available = False
    provider._client = None
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = True
    fake.client.recall.return_value = {"context": "memories from tdai"}

    result = provider.prefetch(query="hello", session_id="test-session")

    assert "memories from tdai" in result, (
        "prefetch should self-heal and return real memories, got: %r" % result
    )
    assert provider._gateway_available
    assert fake.ensure_running_calls >= 1


def test_prefetch_respects_open_breaker(provider_with_fake_supervisor):
    """Breaker should still take precedence — the lazy probe must not
    中文：断路器仍应优先——懒探针必须不能在确认故障期间将每个请求都变成复活尝试。
    turn every request into a respawn attempt during a confirmed outage."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()

    provider._gateway_available = False
    provider._consecutive_failures = 999
    provider._breaker_open_until = time.monotonic() + 60
    initial_respawns = fake.ensure_running_calls

    assert provider.prefetch(query="hello") == ""
    assert fake.ensure_running_calls == initial_respawns, (
        "lazy probe ran ensure_running while breaker was open"
    )


def test_handle_tool_call_recovers_when_stuck_false(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()

    provider._gateway_available = False
    provider._client = None
    fake.respawn_succeeds = True
    fake.client.search_memories.return_value = {"results": ["m1", "m2"]}

    out = provider.handle_tool_call(
        "memory_tencentdb_memory_search", {"query": "anything"}
    )

    assert "results" in out
    assert provider._gateway_available


def test_sync_turn_recovers_when_stuck_false(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()

    provider._gateway_available = False
    provider._client = None
    fake.respawn_succeeds = True
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.sync_turn(user_content="u", assistant_content="a")

    assert capture_called.wait(timeout=2.0), (
        "sync_turn never reached the Gateway after lazy recovery"
    )
    assert provider._gateway_available


# ---------------------------------------------------------------------------
# Shutdown safety
# ---------------------------------------------------------------------------
# 中文：关闭安全措施


def test_shutdown_drops_supervisor_blocks_recovery(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider.shutdown()

    # Even if a stale request came in after shutdown, _try_recover_gateway
    # must refuse to run (supervisor is None).
    # 中文：即使在关闭后有 stale 请求进来，_try_recover_gateway 必须拒绝运行（supervisor 为 None）。
    before = fake.ensure_running_calls
    assert provider._try_recover_gateway() is False
    assert fake.ensure_running_calls == before


def test_shutdown_is_idempotent(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    provider.shutdown()
    provider.shutdown()  # must not raise
    # 中文：必须不抛出
