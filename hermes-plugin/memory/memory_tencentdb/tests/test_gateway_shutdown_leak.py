"""End-to-end tests for the "A mode" Gateway shutdown contract.

Background
----------
When the ``memory_tencentdb`` provider runs under hermes and the Gateway
is launched **by** the hermes process (Mode A — supervisor as parent),
``provider.shutdown()`` used to leave the Gateway subprocess running.
Because the supervisor spawns the Gateway with ``start_new_session=True``,
an un-shutdown Gateway is reparented to PID 1 and survives as an orphan.

Two concrete bugs fell out of that:

1. Orphan Gateway processes accumulate across hermes restarts.
2. The next hermes process's ``is_running()`` health-check sees the stale
   Gateway as healthy and *reuses it*, silently ignoring any config the
   user rotated between restarts (e.g. a new LLM API key installed via
   ``memory-tencentdb-ctl --hermes config llm``).

The fix: ``provider.shutdown()`` now calls ``supervisor.shutdown()``.
This test module locks that contract in.

Test suite layout
-----------------
* :class:`GatewayShutdownLeakTest`
  Core contract tests against a fake Python HTTP Gateway. Fast (≤ a few
  seconds), no Node/pnpm/tsx dependency, safe for CI. Covers:
    - ``test_provider_shutdown_should_stop_supervisor_gateway``
      Supervisor-owned Gateway **must** die on provider.shutdown().
    - ``test_external_gateway_is_not_killed``
      If the Gateway was already running when the provider attached
      (``ensure_running`` returns early without spawning), shutdown must
      **not** terminate it — we only own what we started.
    - ``test_second_provider_does_not_reuse_stale_gateway``
      End-to-end reproduction of the "stale LLM config" user report:
      provider-A starts a Gateway, shuts down, provider-B starts up;
      provider-B must not silently reuse the old Gateway.
* :class:`RealGatewayShutdownTest`
  Integration test against the actual Node Gateway under
  ``src/gateway/server.ts``. Validates graceful shutdown (SIGTERM-driven
  ``gateway.stop()`` runs, SQLite WAL is checkpointed so ``*-wal``/
  ``*-shm`` sidecars don't leak). Skipped by default because it requires
  a working ``pnpm``/``tsx`` toolchain and ~30s to start; opt in via
  ``TDAI_E2E_REAL_GATEWAY=1``.

Run directly::

    python3 hermes-plugin/memory/memory_tencentdb/tests/test_gateway_shutdown_leak.py

Or scope to one case::

    python3 hermes-plugin/memory/memory_tencentdb/tests/test_gateway_shutdown_leak.py \\
        GatewayShutdownLeakTest.test_external_gateway_is_not_killed
中文：A模式网关关闭合约的端到端测试。
背景
----------
当``memory_tencentdb``提供者在hermes下运行且网关由hermes进程（模式A——监督程序作为父进程）启动时，``provider.shutdown()``过去会让网关子进程继续运行。
由于supervisor以``start_new_session=True``的方式启动了网关，未关闭的网关会被重新分配给PID 1并作为一个孤儿进程存活下来。
由此产生了两个具体的bug：
1. hermes重启时孤儿网关进程会累积。
2. 下一个hermes进程的``is_running()``健康检查会看到过期的网关是健康的，并且*重用它*，默默地忽略了用户在重启之间旋转的任何配置（例如通过``memory-tencentdb-ctl --hermes config llm``安装的新LLM API密钥）。
修复：``provider.shutdown()``现在调用了``supervisor.shutdown()``。此测试模块锁定该合约。
测试套件布局
-----------------
* :class:`GatewayShutdownLeakTest`
针对一个假的Python HTTP网关的核心合约测试。快速（≤几秒），无需Node/pnpm/tsx依赖，适合CI环境。涵盖：
- ``test_provider_shutdown_should_stop_supervisor_gateway``
监督程序拥有的网关**必须**在provider.shutdown()时停止。
- ``test_external_gateway_is_not_killed``
如果提供者附加到一个已经运行的网关（``ensure_running``提前返回而不启动），关闭时**不应**终止它——我们只拥有我们启动的东西。
- ``test_second_provider_does_not_reuse_stale_gateway``
重现“过期LLM配置”用户报告：提供者A启动一个网关，关闭，提供者B启动；提供者B必须不默默地重用旧的网关。
* :class:`RealGatewayShutdownTest`
针对实际Node网关（``src/gateway/server.ts``）的集成测试。验证优雅关闭（SIGTERM驱动的``gateway.stop()``运行，SQLite WAL被检查点保存以防止``*-wal``/``*-shm``侧车泄漏）。默认情况下跳过，因为它需要一个工作的``pnpm``/``tsx``工具链且启动需约30秒；通过设置``TDAI_E2E_REAL_GATEWAY=1``可启用。
直接运行：
python3 hermes-plugin/memory/memory_tencentdb/tests/test_gateway_shutdown_leak.py
或仅针对一个用例：
python3 hermes-plugin/memory/memory_tencentdb/tests/test_gateway_shutdown_leak.py \\
GatewayShutdownLeakTest.test_external_gateway_is_not_killed
"""

from __future__ import annotations

import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
# 中文：路径设置

# tdai-memory-openclaw-plugin / hermes-plugin / memory / memory_tencentdb / tests / THIS FILE
# 中文：tdai-memory-openclaw-plugin / hermes-plugin / memory / memory_tencentdb / tests / 此文件
_PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[4]
_HERMES_PLUGIN_ROOT = _PROJECT_ROOT / "hermes-plugin"


def _ensure_importable() -> Optional[str]:
    """Inject plugin + hermes-agent roots into ``sys.path``.

    Returns an informational skip reason if hermes-agent can't be located,
    otherwise None. Each test method checks the return value and skips if
    set, so the whole file still imports cleanly in environments without
    a hermes checkout.
    中文：将插件+hermes-agent根目录注入到``sys.path``中。
    如果无法定位hermes-agent，则返回一个信息性跳过原因，否则返回None。每个测试方法都会检查返回值并根据需要跳过测试，因此整个文件在没有hermes检出的环境中仍能干净地导入。
    """
    if str(_HERMES_PLUGIN_ROOT) not in sys.path:
        sys.path.insert(0, str(_HERMES_PLUGIN_ROOT))

    hermes_agent_root = os.environ.get("HERMES_AGENT_ROOT")
    if not hermes_agent_root:
        candidate = _PROJECT_ROOT.parent / "hermes-agent"
        if candidate.is_dir():
            hermes_agent_root = str(candidate)
    if not hermes_agent_root or not pathlib.Path(hermes_agent_root, "agent").is_dir():
        return (
            "hermes-agent checkout not found — set HERMES_AGENT_ROOT to "
            "point at a sibling hermes-agent repo to run this test."
        )
    if hermes_agent_root not in sys.path:
        sys.path.insert(0, hermes_agent_root)
    return None


# ---------------------------------------------------------------------------
# Fake Gateway (Python HTTP server) helpers
# ---------------------------------------------------------------------------
# 中文：模拟网关（Python HTTP 服务器）辅助函数

def _pick_free_port() -> int:
    """Ask the kernel for an ephemeral port.

    中文：向内核请求一个临时端口。
    """
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _make_fake_gateway_script(tmpdir: pathlib.Path, pid_file: pathlib.Path) -> pathlib.Path:
    """Write a small Python HTTP server that impersonates the Gateway.

    Behaviour:
      * On startup, writes its own PID into ``pid_file`` and also a
        line-per-request log into ``<tmpdir>/gateway.trace`` so tests can
        assert which instance answered which request.
      * Serves ``GET /health`` with the Gateway's canonical JSON shape.
        Echoes the ``MEMORY_TENCENTDB_LLM_API_KEY`` env var back in a
        ``fingerprint`` field so "stale config reuse" tests can see which
        instance answered.
      * SIGTERM handler: remove the pid file and exit cleanly — lets us
        distinguish "supervisor sent SIGTERM" from "orphaned, still up".
    中文：编写一个小巧的Python HTTP服务器来冒充网关。
    行为：
    * 启动时将自身的PID写入``pid_file``，并将其每条请求记录到``<tmpdir>/gateway.trace``中以便测试可以断言哪个实例响应了哪个请求。
    * 以网关的规范JSON形状提供``GET /health``服务。回显``MEMORY_TENCENTDB_LLM_API_KEY``环境变量至一个``fingerprint``字段，使“过期配置重用”测试能够看到是哪个实例响应了。
    * SIGTERM处理程序：移除PID文件并干净退出——让我们能够区分“监督程序发送SIGTERM”与“孤儿进程仍处于运行状态”。
    """
    script = tmpdir / "fake_gateway.py"
    trace = tmpdir / "gateway.trace"
    script.write_text(textwrap.dedent(
        f"""\
        import hashlib, json, os, signal, sys
        from http.server import BaseHTTPRequestHandler, HTTPServer

        PID_FILE = {str(pid_file)!r}
        TRACE = {str(trace)!r}
        PORT = int(os.environ["MEMORY_TENCENTDB_GATEWAY_PORT"])

        # Stamp startup so tests know this is the correct instance.
        # 中文：标记启动时间，以便测试知道这是正确的实例。
        FINGERPRINT = hashlib.sha1(
            os.environ.get("MEMORY_TENCENTDB_LLM_API_KEY", "").encode()
        ).hexdigest()[:12]

        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        with open(TRACE, "a", encoding="utf-8") as f:
            f.write(f"start pid={{os.getpid()}} fp={{FINGERPRINT}}\\n")

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    body = json.dumps({{
                        "status": "ok",
                        "version": "fake-v1",
                        "uptime": 1,
                        "fingerprint": FINGERPRINT,
                        "stores": {{
                            "vectorStore": True,
                            "embeddingService": True,
                        }},
                    }}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    with open(TRACE, "a", encoding="utf-8") as f:
                        f.write(f"GET /health pid={{os.getpid()}} fp={{FINGERPRINT}}\\n")
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, fmt, *args):
                pass

        def _term(_signum, _frame):
            try:
                os.unlink(PID_FILE)
            except OSError:
                pass
            with open(TRACE, "a", encoding="utf-8") as f:
                f.write(f"stop pid={{os.getpid()}}\\n")
            sys.exit(0)

        signal.signal(signal.SIGTERM, _term)
        signal.signal(signal.SIGINT, _term)

        HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
        """
    ))
    return script


def _pid_alive(pid: int) -> bool:
    """Return True if the OS says this pid is still a live process.

    中文：如果操作系统说此PID仍然是一个活动的进程，则返回True。
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_for_pid_file(pid_file: pathlib.Path, timeout: float = 5.0) -> int:
    """Poll until the fake gateway writes its pid file; return the pid.

    中文：轮询直到假网关写入其PID文件；返回PID。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pid_file.exists():
            raw = pid_file.read_text().strip()
            if raw:
                return int(raw)
        time.sleep(0.05)
    raise TimeoutError(f"fake gateway did not write {pid_file} within {timeout}s")


def _wait_until_dead(pid: int, timeout: float = 5.0) -> bool:
    """Poll up to ``timeout`` seconds for the pid to disappear.

    中文：在最多``timeout``秒内轮询以检查PID是否消失。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


def _kill_if_alive(pid: int) -> None:
    """Best-effort SIGTERM→SIGKILL for cleanup paths.

    中文：尽力而为地从SIGTERM到SIGKILL进行清理路径。
    """
    if not _pid_alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.2)
        if _pid_alive(pid):
            os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _set_env(overrides: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
    """Apply env overrides, returning a restore dict.

    中文：应用环境覆盖，返回一个恢复字典。
    """
    prior: Dict[str, Optional[str]] = {k: os.environ.get(k) for k in overrides}
    for k, v in overrides.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return prior


def _restore_env(prior: Dict[str, Optional[str]]) -> None:
    for k, v in prior.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


# ---------------------------------------------------------------------------
# Core contract tests — against fake Python HTTP Gateway
# ---------------------------------------------------------------------------
# 中文：核心合约测试 — 针对假Python HTTP 网关

class GatewayShutdownLeakTest(unittest.TestCase):
    """Supervisor lifecycle contract (fast; no Node dependency).

    中文：监督程序生命周期合约（快速；无需Node依赖）。
    """

    def setUp(self) -> None:
        skip = _ensure_importable()
        if skip:
            self.skipTest(skip)
        self._tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="tdai-shutdown-leak-"))
        self._pid_file = self._tmpdir / "gateway.pid"
        self._fake_script = _make_fake_gateway_script(self._tmpdir, self._pid_file)
        self._rogue_pids: List[int] = []

    def tearDown(self) -> None:
        if self._pid_file.exists():
            try:
                pid = int(self._pid_file.read_text().strip())
            except Exception:
                pid = 0
            if pid:
                _kill_if_alive(pid)
        for pid in self._rogue_pids:
            _kill_if_alive(pid)
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    # -- utilities ----------------------------------------------------------
    # 中文：—— 工具函数 ----------------------------------------------------------

    def _fake_gateway_cmd(self) -> str:
        return f"{sys.executable} {self._fake_script}"

    def _spawn_external_gateway(self, port: int, api_key: str = "") -> int:
        """Start a fake Gateway *outside* the supervisor's control.

        Simulates "Gateway already running when provider attaches" —
        e.g. started manually by the user or by a previous process that
        legitimately left it behind.
        中文：启动一个假的网关*在外围*控制之外。
        模拟“提供者连接时网关已运行”的情况——
        例如，由用户手动启动或由之前合法遗留下来的先前进程启动。
        """
        env = os.environ.copy()
        env["MEMORY_TENCENTDB_GATEWAY_PORT"] = str(port)
        if api_key:
            env["MEMORY_TENCENTDB_LLM_API_KEY"] = api_key
        proc = subprocess.Popen(
            [sys.executable, str(self._fake_script)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        # wait for it to come up
        # 中文：等待其启动
        pid = _wait_for_pid_file(self._pid_file, timeout=8.0)
        self.assertEqual(pid, proc.pid)
        self._rogue_pids.append(pid)
        return pid

    # -- tests --------------------------------------------------------------

    def test_provider_shutdown_should_stop_supervisor_gateway(self) -> None:
        """A-mode contract: Gateway we started MUST die on shutdown().

        中文：A模式合约：我们启动的网关必须在shutdown()后死亡。
        """
        from memory.memory_tencentdb import MemoryTencentdbProvider

        port = _pick_free_port()
        prior = _set_env({
            "MEMORY_TENCENTDB_GATEWAY_HOST": "127.0.0.1",
            "MEMORY_TENCENTDB_GATEWAY_PORT": str(port),
            "MEMORY_TENCENTDB_GATEWAY_CMD": self._fake_gateway_cmd(),
        })
        try:
            provider = MemoryTencentdbProvider()
            provider.initialize(session_id="leak-test-session", user_id="tester")

            pid = _wait_for_pid_file(self._pid_file, timeout=8.0)
            self.assertTrue(_pid_alive(pid))

            provider.shutdown()

            died = _wait_until_dead(pid, timeout=3.0)
            self.assertTrue(
                died,
                f"Gateway pid={pid} still alive 3s after provider.shutdown(); "
                "supervisor teardown did not propagate.",
            )
        finally:
            _restore_env(prior)

    def test_external_gateway_is_not_killed(self) -> None:
        """Symmetry contract: don't kill what we didn't start.

        If the Gateway was already serving on the configured port when
        the provider attached, ``supervisor.ensure_running()`` returns
        without spawning and leaves ``_process = None``. In that case
        ``shutdown()`` must be a no-op for the Gateway — killing it would
        break anyone else already using it.
        中文：对称合约：不要杀死我们没有启动的东西。
        如果提供者连接时网关已经在配置端口上运行，则``supervisor.ensure_running()``不会启动并返回，留下``_process = None``。在这种情况下，``shutdown()``必须是一个空操作——杀死它会破坏其他已经合法使用它的任何人。
        """
        from memory.memory_tencentdb import MemoryTencentdbProvider

        port = _pick_free_port()
        external_pid = self._spawn_external_gateway(port)

        prior = _set_env({
            "MEMORY_TENCENTDB_GATEWAY_HOST": "127.0.0.1",
            "MEMORY_TENCENTDB_GATEWAY_PORT": str(port),
            # Supply a CMD too — we want to prove the supervisor takes the
            # is_running() fast path and *doesn't* spawn a second copy.
            # 中文：提供一个 CMD 参数 —— 我们希望证明 supervisor 在 is_running() 快速路径上运行并且 *不* 启动第二个副本。
            "MEMORY_TENCENTDB_GATEWAY_CMD": self._fake_gateway_cmd(),
        })
        try:
            provider = MemoryTencentdbProvider()
            provider.initialize(session_id="external-gw-session", user_id="tester")

            # Sanity: the external Gateway is still the pid-file holder.
            # 中文：Sanity: 外部网关仍然是pid文件持有者。
            pid = int(self._pid_file.read_text().strip())
            self.assertEqual(
                pid, external_pid,
                "Supervisor unexpectedly started a second Gateway; "
                "is_running() fast path must be taken when a healthy "
                "Gateway is already serving the port.",
            )

            provider.shutdown()

            # External gateway must survive.
            # 中文：外部网关必须存活下来。
            time.sleep(0.5)
            self.assertTrue(
                _pid_alive(external_pid),
                f"External Gateway pid={external_pid} was killed by "
                "provider.shutdown(); supervisor must only terminate "
                "processes it started itself.",
            )
        finally:
            _restore_env(prior)

    def test_second_provider_does_not_reuse_stale_gateway(self) -> None:
        """Stale-config reproduction.

        Mirrors the user report: rotate ``MEMORY_TENCENTDB_LLM_API_KEY``
        between two hermes runs. The second provider must end up with a
        Gateway whose env has the *new* key — i.e. a brand-new process,
        not the first provider's leftover. The fake Gateway publishes
        ``fingerprint = sha1(api_key)[:12]`` over ``/health`` so we can
        tell the two apart by a single HTTP call.
        中文：遗留配置重现。
        模拟用户报告：在两次hermes运行之间轮换``MEMORY_TENCENTDB_LLM_API_KEY``。第二次提供者最终应该得到一个环境中有*新*密钥的网关——即，一个全新的进程，而不是第一次提供者的遗留物。假网关通过``/health``发布``fingerprint = sha1(api_key)[:12]``以便我们可以通过一次HTTP调用区分两者。
        """
        from memory.memory_tencentdb import MemoryTencentdbProvider
        from memory.memory_tencentdb.client import MemoryTencentdbSdkClient

        port = _pick_free_port()

        def _health_fingerprint() -> str:
            client = MemoryTencentdbSdkClient(
                base_url=f"http://127.0.0.1:{port}", timeout=2,
            )
            return client.health(timeout=2).get("fingerprint", "")

        prior = _set_env({
            "MEMORY_TENCENTDB_GATEWAY_HOST": "127.0.0.1",
            "MEMORY_TENCENTDB_GATEWAY_PORT": str(port),
            "MEMORY_TENCENTDB_GATEWAY_CMD": self._fake_gateway_cmd(),
            "MEMORY_TENCENTDB_LLM_API_KEY": "old-key-AAA",
        })
        try:
            # --- first provider run (the "before rotation" hermes) ---
            # 中文：--- 第一次 provider 运行（“轮换前”的 hermes）---
            provider_a = MemoryTencentdbProvider()
            provider_a.initialize(session_id="sess-a", user_id="tester")
            pid_a = _wait_for_pid_file(self._pid_file, timeout=8.0)
            fp_a = _health_fingerprint()
            self.assertTrue(fp_a, "first Gateway did not publish a fingerprint")

            provider_a.shutdown()
            self.assertTrue(
                _wait_until_dead(pid_a, timeout=3.0),
                "first Gateway still alive after provider_a.shutdown() — "
                "stale-config bug would reappear.",
            )

            # --- user rotates the LLM key between hermes restarts ---
            # 中文：第一次提供方运行（"旋转前"的hermes）
            os.environ["MEMORY_TENCENTDB_LLM_API_KEY"] = "new-key-ZZZ"

            # --- second provider run (the "after rotation" hermes) ---
            # 中文：--- 第二次 provider 运行（“轮换后”的 hermes）---
            provider_b = MemoryTencentdbProvider()
            provider_b.initialize(session_id="sess-b", user_id="tester")
            pid_b = _wait_for_pid_file(self._pid_file, timeout=8.0)
            fp_b = _health_fingerprint()

            self.assertNotEqual(
                pid_a, pid_b,
                "provider_b reused provider_a's Gateway pid — the "
                "orphan survived shutdown and was picked up by "
                "is_running() (classic stale-config bug).",
            )
            self.assertNotEqual(
                fp_a, fp_b,
                "provider_b's Gateway still reports the old key "
                f"fingerprint ({fp_a}); the new env never reached a "
                "fresh process.",
            )

            provider_b.shutdown()
            self.assertTrue(_wait_until_dead(pid_b, timeout=3.0))
        finally:
            _restore_env(prior)


# ---------------------------------------------------------------------------
# Integration test — against the real Node Gateway (opt-in)
# ---------------------------------------------------------------------------
# 中文：用户在hermes重启之间旋转LLM密钥

class RealGatewayShutdownTest(unittest.TestCase):
    """Opt-in integration test for graceful shutdown of the real Gateway.

    Enabled only when ``TDAI_E2E_REAL_GATEWAY=1`` is set, because it:
      * depends on ``pnpm`` / ``tsx`` being available on PATH,
      * costs ~10-30s (Node cold start + first /health),
      * writes to a temp SQLite data dir.

    Verifies two properties that matter beyond "pid dies":
      1. ``gateway.stop()`` actually ran — SIGTERM was delivered and the
         in-process shutdown handler finished before ``process.exit(0)``.
         Proxy signal: SQLite files are in a clean state (no leftover
         ``*-wal`` with unflushed bytes).
      2. The process exits within a reasonable grace window.
    中文：可选集成测试，验证优雅关闭真实网关。
    仅当设置了``TDAI_E2E_REAL_GATEWAY=1``时启用，因为这：
    * 依赖于PATH上的``pnpm`` / ``tsx`存在,
    * 成本约为10-30秒（Node冷启动+首次/health），
    * 写入临时SQLite数据目录。
    验证两个超出“进程退出”的属性：
    1. 实际上运行了``gateway.stop()``——SIGTERM被发送并且在``process.exit(0)``之前，内核关闭处理程序完成。
    信号代理：SQLite文件处于干净状态（没有未刷新的``*-wal``残留）。
    2. 进程在合理的优雅窗口内退出。
    """

    def setUp(self) -> None:
        if os.environ.get("TDAI_E2E_REAL_GATEWAY") != "1":
            self.skipTest(
                "Real-Gateway test skipped; set TDAI_E2E_REAL_GATEWAY=1 "
                "to enable (requires pnpm + tsx on PATH)."
            )
        skip = _ensure_importable()
        if skip:
            self.skipTest(skip)

        server_ts = _PROJECT_ROOT / "src" / "gateway" / "server.ts"
        if not server_ts.is_file():
            self.skipTest(f"src/gateway/server.ts not found at {server_ts}")
        if shutil.which("pnpm") is None:
            self.skipTest("pnpm not on PATH")

        self._tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="tdai-real-gw-"))
        self._data_dir = self._tmpdir / "data"
        self._data_dir.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_real_gateway_graceful_shutdown(self) -> None:
        from memory.memory_tencentdb import MemoryTencentdbProvider

        port = _pick_free_port()
        gateway_cmd = (
            f"sh -c 'cd {_PROJECT_ROOT} && exec pnpm exec tsx src/gateway/server.ts'"
        )

        prior = _set_env({
            "MEMORY_TENCENTDB_GATEWAY_HOST": "127.0.0.1",
            "MEMORY_TENCENTDB_GATEWAY_PORT": str(port),
            "MEMORY_TENCENTDB_GATEWAY_CMD": gateway_cmd,
            # The supervisor exports MEMORY_TENCENTDB_GATEWAY_{HOST,PORT}
            # into the child env, but ``src/gateway/config.ts`` currently
            # reads ``TDAI_GATEWAY_{HOST,PORT}``. Export both so this test
            # is agnostic to that mismatch (which is tracked separately).
            # 中文：supervisor 会把 MEMORY_TENCENTDB_GATEWAY_{HOST,PORT} 导出到子进程环境中，
            # 但 ``src/gateway/config.ts`` 目前读取的是 ``TDAI_GATEWAY_{HOST,PORT}``。
            # 两组变量都导出，让这个测试不依赖该命名差异（该问题单独跟踪）。
            "TDAI_GATEWAY_HOST": "127.0.0.1",
            "TDAI_GATEWAY_PORT": str(port),
            "TDAI_DATA_DIR": str(self._data_dir),
            # Supply a placeholder LLM key: /health doesn't need it, but
            # unset keys make the L1 extractor log loud errors. A fake
            # key keeps the log clean and has no effect on the shutdown
            # path we're actually testing.
            # 中文：第二次提供方运行（"旋转后"的hermes）
            "TDAI_LLM_API_KEY": "sk-test-placeholder-not-used",
            "MEMORY_TENCENTDB_LLM_API_KEY": "sk-test-placeholder-not-used",
        })
        try:
            provider = MemoryTencentdbProvider()
            provider.initialize(session_id="real-gw-sess", user_id="tester")

            # Fail loudly if the Gateway didn't actually come up — otherwise
            # a failed startup would mask the shutdown assertions below and
            # let a regression slip through. Surface the stderr log tail
            # (same location the supervisor uses) to make diagnosis easy.
            # 中文：如果网关实际上没有启动，则必须明确失败——否则，启动失败会掩盖下面的关闭断言，并导致回归问题被遗漏。显示stderr日志尾部（与supervisor使用的相同位置），以便于诊断。
            if not provider._gateway_available:  # noqa: SLF001 (test access)
            # 中文："noqa: SLF001 (test access)"
                log_path = pathlib.Path(
                    os.environ.get("HOME", "") or "/",
                    ".hermes", "logs", "memory_tencentdb", "gateway.stderr.log",
                )
                tail = ""
                if log_path.is_file():
                    data = log_path.read_bytes()
                    tail = data[-2048:].decode("utf-8", errors="replace")
                self.fail(
                    "real Node Gateway failed to become healthy; cannot "
                    f"test shutdown. Recent stderr:\n{tail}"
                )

            # The supervisor stores the Popen object; reach in (test-only)
            # to grab the pid so we can watch it across shutdown.
            # 中文：supervisor存储Popen对象；在此进行测试访问以获取pid，以便我们在关闭时对其进行监控。
            supervisor = provider._supervisor  # noqa: SLF001 (test access)
            # 中文："noqa: SLF001 (test access)"
            self.assertIsNotNone(supervisor, "supervisor must be set after initialize()")
            proc = supervisor._process  # noqa: SLF001
            # 中文："noqa: SLF001"
            self.assertIsNotNone(
                proc,
                "real Node Gateway was expected to be spawned by the supervisor; "
                "got None — did the health check fail?",
            )
            pid = proc.pid

            t0 = time.monotonic()
            provider.shutdown()
            elapsed = time.monotonic() - t0

            self.assertTrue(
                _wait_until_dead(pid, timeout=12.0),
                f"real Node Gateway pid={pid} did not exit within 12s of "
                "SIGTERM — graceful shutdown path hung.",
            )
            # Graceful stop should typically finish well under the 10s
            # supervisor timeout; flag long waits so regressions are loud.
            # 中文：优雅停止通常应在supervisor超时（10秒）内完成；标记长时间等待以使回归问题明显。
            self.assertLess(
                elapsed, 10.0,
                f"provider.shutdown() took {elapsed:.1f}s — suspiciously "
                "close to the SIGKILL fallback. Check gateway.stop() for "
                "blocking work.",
            )

            # Graceful-exit witness: no stray SQLite WAL/SHM should remain
            # under the data dir. If the Gateway was SIGKILL'd mid-write,
            # these sidecars would be left behind with uncommitted bytes.
            # 中文：优雅退出见证：在数据目录下不应有遗留的SQLite WAL/SHM。如果Gateway在写入过程中被SIGKILL中断，这些辅助文件将留下未提交的数据。
            leftovers = sorted(
                p for p in self._data_dir.rglob("*")
                if p.suffix in (".db-wal", ".db-shm")
            )
            self.assertEqual(
                leftovers, [],
                f"found leftover SQLite sidecars after graceful shutdown: "
                f"{[str(p) for p in leftovers]}",
            )
        finally:
            _restore_env(prior)


    def test_wal_checkpoint_after_capture_and_sigterm(self) -> None:
        """Write data via capture(), then SIGTERM — graceful close verified.

        End-to-end proof that ``gateway.stop()`` actually runs (not just
        "pid disappears") when the supervisor sends SIGTERM:

          1. Start a fresh real Node Gateway pointed at a temp data dir.
          2. Send several ``/capture`` calls to produce L0 data.
          3. Confirm data was actually written to disk (JSONL and/or .db).
          4. ``provider.shutdown()`` → SIGTERM → ``gateway.stop()`` →
             ``core.destroy()`` → ``vectorStore.close()`` (which runs
             an implicit ``PRAGMA wal_checkpoint``).
          5. Assert the process exited **cleanly** (exit code 0 via
             SIGTERM handler, not 137 from SIGKILL).
          6. Assert shutdown finished well under the 10s SIGKILL fallback.
          7. If any ``.db`` files exist, assert no dirty WAL / SHM remain.
          8. Confirm JSONL data files are intact (non-empty, valid JSON
             lines) — proves L0 writes were fully flushed.

        Note: when ``sqlite-vec`` is not available, VectorStore enters
        degraded mode and L0 goes through JSONL only. The test adapts:
        it always checks JSONL; WAL assertions only fire when ``.db``
        files actually exist.
        中文：通过capture()写入数据，然后SIGTERM——验证优雅关闭。
        端到端证明当监督程序发送SIGTERM时，实际上运行了``gateway.stop()``（而不仅仅是“pid消失”）：
        1. 启动一个指向临时数据目录的真实Node网关的全新实例。
        2. 发送多个``/capture``调用来生成L0数据。
        3. 确认数据实际上被写入磁盘（JSONL和/.db）。
        4. ``provider.shutdown()`` → SIGTERM → ``gateway.stop()`` → ``core.destroy()`` → ``vectorStore.close()``（这会运行一个隐式的``PRAGMA wal_checkpoint``）。
        5. 断言进程退出**干净地**（通过SIGTERM处理程序以退出码0，而不是由SIGKILL的137退出）。
        6. 断言关闭在10秒SIGKILL回退窗口内完成得很好。
        7. 如果存在任何``.db``文件，则断言没有脏的WAL / SHM残留。
        8. 确认JSONL数据文件完好无损（非空，有效JSON行）——证明L0写入完全刷新了。
        注意：当``sqlite-vec``不可用时，VectorStore进入降级模式且L0仅通过JSONL处理。测试会适应这一点：它总是检查JSONL；WAL断言只有在实际存在``.db``文件时才会触发。
        """
        from memory.memory_tencentdb import MemoryTencentdbProvider
        from memory.memory_tencentdb.client import MemoryTencentdbSdkClient
        import json as _json

        port = _pick_free_port()
        gateway_cmd = (
            f"sh -c 'cd {_PROJECT_ROOT} && exec pnpm exec tsx src/gateway/server.ts'"
        )

        prior = _set_env({
            "MEMORY_TENCENTDB_GATEWAY_HOST": "127.0.0.1",
            "MEMORY_TENCENTDB_GATEWAY_PORT": str(port),
            "MEMORY_TENCENTDB_GATEWAY_CMD": gateway_cmd,
            "TDAI_GATEWAY_HOST": "127.0.0.1",
            "TDAI_GATEWAY_PORT": str(port),
            "TDAI_DATA_DIR": str(self._data_dir),
            "TDAI_LLM_API_KEY": "sk-test-placeholder-not-used",
            "MEMORY_TENCENTDB_LLM_API_KEY": "sk-test-placeholder-not-used",
        })
        try:
            provider = MemoryTencentdbProvider()
            provider.initialize(session_id="wal-ckpt-sess", user_id="wal-tester")

            if not provider._gateway_available:  # noqa: SLF001
            # 中文："noqa: SLF001"
                log_path = pathlib.Path(
                    os.environ.get("HOME", "") or "/",
                    ".hermes", "logs", "memory_tencentdb", "gateway.stderr.log",
                )
                tail = ""
                if log_path.is_file():
                    data = log_path.read_bytes()
                    tail = data[-2048:].decode("utf-8", errors="replace")
                self.fail(
                    "real Node Gateway failed to become healthy; cannot "
                    f"test WAL checkpoint. Recent stderr:\n{tail}"
                )

            supervisor = provider._supervisor  # noqa: SLF001
            # 中文："noqa: SLF001"
            proc = supervisor._process  # noqa: SLF001
            # 中文："noqa: SLF001"
            self.assertIsNotNone(proc, "Gateway process must be spawned")
            pid = proc.pid

            # ---- Step 2: write data via /capture ----
            # 中文：---- 第2步：通过/capture写入数据 ----
            client = MemoryTencentdbSdkClient(
                base_url=f"http://127.0.0.1:{port}", timeout=10,
            )
            n_captures = 5
            for i in range(n_captures):
                try:
                    client.capture(
                        user_content=f"Test message {i}: the quick brown fox",
                        assistant_content=f"Acknowledged message {i}.",
                        session_key="wal-ckpt-sess",
                        user_id="wal-tester",
                    )
                except Exception:
                    # capture() may partially fail (e.g. LLM extraction) but
                    # L0 write still happens before extraction kicks in.
                    # 中文：capture()可能会部分失败（例如LLM提取），但在提取开始之前L0写入仍然会发生。
                    pass

            # Give the Gateway a moment to flush writes.
            # 中文：给网关一些时间来刷新写入操作。
            time.sleep(0.5)

            # ---- Step 3: confirm data was written to disk ----
            # JSONL (always present, even when VectorStore is degraded):
            # 中文：---- 第3步：确认数据已写入磁盘 ----
            # JSONL（始终存在，即使VectorStore降级也是如此）：
            jsonl_files = sorted(self._data_dir.rglob("*.jsonl"))
            self.assertTrue(
                len(jsonl_files) > 0,
                f"expected at least one .jsonl file under {self._data_dir} "
                f"after {n_captures} capture() calls.",
            )
            total_lines_before = 0
            for jf in jsonl_files:
                lines = [l for l in jf.read_text().splitlines() if l.strip()]
                total_lines_before += len(lines)
                # Validate each line is parseable JSON.
                # 中文：逐行验证是否可解析为JSON。
                for idx, line in enumerate(lines):
                    try:
                        _json.loads(line)
                    except _json.JSONDecodeError:
                        self.fail(
                            f"invalid JSON on line {idx+1} of {jf}: {line[:120]}"
                        )
            self.assertGreater(
                total_lines_before, 0,
                "JSONL files exist but contain no data lines.",
            )

            # .db files (only present when sqlite-vec loaded successfully):
            # 中文：.db文件（仅在sqlite-vec加载成功时存在）：
            db_files = sorted(self._data_dir.rglob("*.db"))
            has_sqlite = len(db_files) > 0

            # ---- Step 4: SIGTERM via provider.shutdown() ----
            # Grab a reference to the Popen *before* supervisor.shutdown()
            # sets it to None, so we can check returncode afterwards.
            # 中文：---- 第4步：通过provider.shutdown()发送SIGTERM信号----
            # 在supervisor.shutdown()设置它为None之前，获取Popen的引用，以便之后检查returncode。
            popen_ref = proc

            t0 = time.monotonic()
            provider.shutdown()
            elapsed = time.monotonic() - t0

            # ---- Step 5: verify clean exit (SIGTERM handler ran) ----
            # 中文：---- 第5步：验证干净退出（SIGTERM处理程序运行）----
            self.assertTrue(
                _wait_until_dead(pid, timeout=12.0),
                f"real Node Gateway pid={pid} did not exit within 12s.",
            )

            # returncode semantics:
            #   0        → Node SIGTERM handler ran and called process.exit(0)
            #   -15      → SIGTERM killed the process directly (normal for
            #               multi-layer launchers like ``pnpm exec tsx``: the
            #               supervisor's terminate() hits pnpm, which exits on
            #               signal; tsx/node children then exit as a cascade)
            #   -9       → SIGKILL (supervisor had to force-kill after 10s
            #               timeout — that's a regression)
            #   positive → unexpected crash exit code
            # 中文：返回码语义：
            # 0        → 节点SIGTERM处理程序运行并调用了process.exit(0)
            # -15      → SIGTERM直接杀死了进程（对于多层启动器如`pnpm exec tsx`来说是正常的：supervisor的terminate()击中了pnpm，后者在接收到信号后退出；tsx/node子进程则作为级联退出）
            # -9       → SIGKILL（supervisor在10秒超时后强制杀死了进程 —— 这是一个回退情况）
            # 正数     → 未预期的崩溃退出代码
            rc = popen_ref.returncode
            self.assertIsNotNone(rc, "process should have exited")
            self.assertNotEqual(
                rc, -9,
                "Gateway was SIGKILL'd (exit code -9) — the SIGTERM path "
                "failed to terminate within the supervisor's 10s timeout. "
                "Graceful shutdown is broken.",
            )
            # For direct-node launches rc==0 means the handler ran. For
            # pnpm-wrapped launches rc==-15 is expected (pnpm doesn't trap
            # SIGTERM). Both are acceptable; anything else is suspicious.
            # 中文：对于直接节点启动，rc==0意味着处理程序运行。对于pnpm包装启动，rc==-15是预期的（pnpm不会捕获SIGTERM）。两者都是可接受的；任何其他情况都值得怀疑。
            self.assertIn(
                rc, (0, -15, -2),  # 0=handler, -15=SIGTERM, -2=SIGINT
                # 中文：0=handler, -15=SIGTERM, -2=SIGINT
                f"Gateway exited with unexpected code {rc}. Expected 0 "
                "(graceful handler) or -15 (signal). Investigate.",
            )

            # ---- Step 6: timing ----
            # 中文：---- 第6步：时间间隔----
            self.assertLess(
                elapsed, 10.0,
                f"provider.shutdown() took {elapsed:.1f}s — close to the "
                "SIGKILL fallback; gateway.stop() may be blocked.",
            )

            # ---- Step 7: WAL/SHM cleanliness (only when .db exists) ----
            # 中文：---- 第7步：WAL/SHM清洁度（仅当.db存在时）----
            if has_sqlite:
                shm_leftovers = sorted(self._data_dir.rglob("*.db-shm"))
                self.assertEqual(
                    shm_leftovers, [],
                    f"SHM files should not survive graceful shutdown: "
                    f"{[str(p) for p in shm_leftovers]}",
                )

                dirty_wals = sorted(
                    f for f in self._data_dir.rglob("*.db-wal")
                    if f.stat().st_size > 0
                )
                self.assertEqual(
                    dirty_wals, [],
                    f"non-empty WAL files found after graceful shutdown — "
                    f"wal_checkpoint was NOT completed: "
                    f"{[(str(f), f.stat().st_size) for f in dirty_wals]}",
                )

            # ---- Step 8: JSONL integrity post-shutdown ----
            # The same JSONL files should still be intact and no smaller
            # (gateway.stop → core.destroy should not truncate them).
            # 中文：---- 步骤 8：关闭后 JSONL 完整性检查 ----
            # 相同的 JSONL 文件仍然应该保持完整且不应变小（gateway.stop → core.destroy 不应截断它们）。
            total_lines_after = 0
            for jf in jsonl_files:
                if jf.exists():
                    lines = [l for l in jf.read_text().splitlines() if l.strip()]
                    total_lines_after += len(lines)
            self.assertGreaterEqual(
                total_lines_after, total_lines_before,
                f"JSONL data shrank after shutdown "
                f"(before={total_lines_before}, after={total_lines_after}); "
                f"graceful shutdown may have corrupted L0 data.",
            )
        finally:
            _restore_env(prior)


if __name__ == "__main__":
    unittest.main(verbosity=2)
