"""GatewaySupervisor — manages the memory-tencentdb Gateway Node.js sidecar process.

On initialize(), checks if the Gateway is already running. If not, starts
it as a subprocess and waits for /health to become available.

On shutdown(), sends a flush signal and waits for clean exit.
中文：GatewaySupervisor — 管理内存-TencentDB网关Sidecar进程。
"""

from __future__ import annotations

import logging
import os
import shlex
import subprocess
import time
from typing import IO, Optional

from .client import MemoryTencentdbSdkClient

logger = logging.getLogger(__name__)

# Default Gateway address
# 中文：默认网关地址
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8420

# Health check parameters
# 中文：健康检查参数
HEALTH_CHECK_INTERVAL = 0.5  # seconds between checks
# 中文：检查间隔秒数
HEALTH_CHECK_MAX_WAIT = 30   # max seconds to wait for Gateway to start
# 中文：等待网关启动的最大秒数
HEALTH_CHECK_RETRIES = 3     # retries for is_running check
# 中文：is_running检查的重试次数

# Log file rotation parameters
# 中文：日志文件轮转参数
LOG_TAIL_BYTES_ON_CRASH = 2048  # bytes of stderr log to surface on startup crash
# 中文：启动崩溃时表面的stderr日志字节数


class GatewaySupervisor:
    """Manages the memory-tencentdb Gateway sidecar lifecycle.

    中文：管理内存-TencentDB网关Sidecar生命周期。
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        gateway_cmd: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        """Construct the supervisor.

        Args:
            host: Gateway bind host.
            port: Gateway bind port.
            gateway_cmd: Shell command to spawn the Gateway. Falls back to
                ``MEMORY_TENCENTDB_GATEWAY_CMD`` env var when None.
            api_key: Optional Gateway Bearer token used by the **client**
                (every outbound request adds ``Authorization: Bearer <key>``).
                The supervisor does NOT propagate this value to the spawned
                Gateway's environment — turning auth on at the Gateway is the
                operator's responsibility (set ``TDAI_GATEWAY_API_KEY`` /
                ``server.apiKey`` on the Gateway side directly, in the same
                place you'd configure its port and data dir). Both ends must
                see the same secret; the plugin only handles the client half.
                ``None`` / empty means "do not attach an Authorization
                header", which preserves the legacy default.
        """
        self._host = host
        self._port = port
        self._base_url = f"http://{host}:{port}"
        self._api_key = (api_key or "").strip() or None
        self._client = MemoryTencentdbSdkClient(
            base_url=self._base_url,
            timeout=5,
            api_key=self._api_key,
        )
        self._process: Optional[subprocess.Popen] = None
        # File handles for child's stdout/stderr. Kept open for the lifetime of
        # the process so the kernel pipe buffer never fills up (otherwise the
        # Gateway's event loop would block on write() after ~64 KB of logs).
        # 中文：为子进程的stdout/stderr保留的文件句柄。在整个进程中保持打开状态，以防止内核管道缓冲区溢出（否则Gateway的事件循环会在写入后阻塞约64KB的日志）。
        self._stdout_log: Optional[IO[bytes]] = None
        self._stderr_log: Optional[IO[bytes]] = None
        self._stderr_log_path: Optional[str] = None

        # Resolve Gateway command
        # Priority: explicit arg > MEMORY_TENCENTDB_GATEWAY_CMD env
        # 中文：解析网关命令
        # 优先级：显式参数 > MEMORY_TENCENTDB_GATEWAY_CMD环境变量
        self._gateway_cmd = gateway_cmd or os.environ.get("MEMORY_TENCENTDB_GATEWAY_CMD", "")

    def is_running(self) -> bool:
        """Check if the Gateway is currently responding to health checks.

        中文：检查网关当前是否响应健康检查。
        """
        for _ in range(HEALTH_CHECK_RETRIES):
            try:
                result = self._client.health(timeout=2)
                return result.get("status") in ("ok", "degraded")
            except Exception:
                time.sleep(0.2)
        return False

    def is_process_alive(self) -> bool:
        """Return True iff we have spawned a child and it has not exited.

        Distinct from ``is_running()``:
          * ``is_running`` performs a network health check — slow, but works
            even when the Gateway was started externally (systemd, manual run).
          * ``is_process_alive`` only inspects our own ``Popen`` handle — fast,
            and lets the watchdog notice an exited child without paying for an
            HTTP round-trip every tick.

        Returns False when we never spawned a child, or when the child has
        exited (``poll()`` returns a non-None code). The watchdog combines
        both checks: ``is_process_alive() or is_running()`` — only when both
        say "no" do we attempt a re-spawn.
        中文：如果已spawn子进程且未退出，则返回True。
        与`is_running()`不同：
        * `is_running`执行网络健康检查——慢，但即使网关外部启动（systemd、手动运行）也能工作。
        * `is_process_alive`仅检查我们自己的`Popen`句柄——快，并让看门狗注意到退出的子进程而无需每次心跳都支付HTTP往返费用。
        当从未spawn子进程或子进程已退出(`poll()`返回非空代码)时返回False。看门狗结合两项检查：`is_process_alive() or is_running()`——只有两者都说“否”时才尝试重新启动。
        """
        proc = self._process
        if proc is None:
            return False
        return proc.poll() is None

    def _reap_dead_process(self) -> None:
        """Drop the reference to a child we spawned that has since exited.

        Called from ``ensure_running`` so that a re-spawn after a crash does
        not leak the previous ``Popen`` handle (the kernel still owns the
        zombie until ``wait()``-style call). Safe to call when the process
        is still alive — it's a no-op in that case.
        中文：移除已退出的子进程引用。
        从`ensure_running`调用，以防止崩溃后的重新启动泄漏之前的`Popen`句柄（内核在`wait()`样式调用前仍拥有僵尸进程）。即使进程仍在运行也安全调用——在这种情况下它是无操作。
        """
        proc = self._process
        if proc is None:
            return
        if proc.poll() is None:
            return  # still alive
            # 中文：仍然存活
        try:
            # poll() already reaped the child via waitpid internally on POSIX,
            # so there is nothing more to do here. Just drop our handle and
            # close the log files we opened for this run.
            # 中文：在POSIX下，poll()已经通过waitpid内部回收了子进程，因此这里无需再做其他操作。只需丢弃我们的句柄并关闭本次运行中打开的日志文件。
            rc = proc.returncode
            logger.warning(
                "memory-tencentdb Gateway: previous child exited (code=%s); "
                "reaping before respawn.", rc,
            )
        finally:
            self._process = None
            self._close_log_handles()

    def ensure_running(self) -> bool:
        """Ensure the Gateway is running. Start it if not.

        Returns True if the Gateway is available, False if startup failed.
        中文：确保网关正在运行。如果没有运行则启动它。
        如果网关可用返回True，否则如果启动失败返回False。
        """
        if self.is_running():
            logger.info("memory-tencentdb Gateway already running at %s", self._base_url)
            return True

        # If we previously spawned a child and it has since died, drop the
        # stale Popen handle so the new spawn below isn't shadowed by a
        # zombie reference. Without this, a crashed-then-respawned Gateway
        # would keep ``self._process`` pointing at the dead PID forever and
        # ``is_process_alive()`` would mislead the watchdog.
        # 中文：如果之前已spawn了一个子进程且它已死亡，则丢弃过时的Popen句柄，以免新spawn被僵尸引用所遮蔽。否则，崩溃后再重启的Gateway会永远将``self._process``指向死PID，并导致``is_process_alive()``误导看门狗。
        self._reap_dead_process()

        # Try to start the Gateway
        # 中文：尝试启动网关
        if not self._gateway_cmd:
            logger.warning(
                "memory-tencentdb Gateway is not running and no gateway command configured. "
                "Set MEMORY_TENCENTDB_GATEWAY_CMD environment variable or pass gateway_cmd to supervisor. "
                "memory-tencentdb memory will be unavailable."
            )
            return False

        logger.info("Starting memory-tencentdb Gateway: %s", self._gateway_cmd)

        try:
            env = os.environ.copy()
            env["MEMORY_TENCENTDB_GATEWAY_PORT"] = str(self._port)
            env["MEMORY_TENCENTDB_GATEWAY_HOST"] = self._host
            # Note: we deliberately do NOT inject TDAI_GATEWAY_API_KEY into
            # the child's env from here. Whether the Gateway enforces auth is
            # the operator's call — they configure it on the Gateway side
            # (env, yaml, docker run, systemd unit) just like any other
            # Gateway setting. The supervisor's ``api_key`` is purely the
            # client-side Bearer token used for outbound requests.
            # 中文：备注：我们故意不从这里注入TDAI_GATEWAY_API_KEY到子进程的环境变量中。网关是否启用认证由操作者决定——他们在网关侧（env、yaml、docker run、systemd unit）进行配置，就像其他任何网关设置一样。监护人的``api_key``纯粹是客户端用于发起请求的Bearer令牌。

            # Redirect child stdout/stderr to log files instead of PIPE.
            # Using PIPE without an active reader will deadlock the child once
            # the pipe buffer (~64 KB) fills up. A log directory next to the
            # data dir keeps logs inspectable on crash while eliminating the
            # blocking risk entirely.
            # 中文：将子进程的标准输出/标准错误重定向到日志文件而不是PIPE。使用PIPE而没有活跃的读取器会在管道缓冲区（约64 KB）填满时导致子进程死锁。数据目录旁边的日志目录使在崩溃时可以检查日志，同时完全消除了阻塞的风险。
            log_dir = self._resolve_log_dir()
            try:
                os.makedirs(log_dir, exist_ok=True)
            except OSError as e:
                logger.warning(
                    "memory-tencentdb Gateway: failed to create log dir %s (%s); "
                    "falling back to DEVNULL", log_dir, e,
                )
                log_dir = None

            if log_dir is not None:
                stdout_path = os.path.join(log_dir, "gateway.stdout.log")
                stderr_path = os.path.join(log_dir, "gateway.stderr.log")
                # Append mode: preserve previous runs for postmortem.
                # 中文：追加模式：保留之前的运行以便事后分析。
                self._stdout_log = open(stdout_path, "ab", buffering=0)
                self._stderr_log = open(stderr_path, "ab", buffering=0)
                self._stderr_log_path = stderr_path
                stdout_target: object = self._stdout_log
                stderr_target: object = self._stderr_log
            else:
                stdout_target = subprocess.DEVNULL
                stderr_target = subprocess.DEVNULL

            self._process = subprocess.Popen(
                shlex.split(self._gateway_cmd),
                env=env,
                stdout=stdout_target,
                stderr=stderr_target,
                start_new_session=True,  # Detach from parent process group
                # 中文：从父进程组分离
            )
        except Exception as e:
            logger.error("Failed to start memory-tencentdb Gateway: %s", e)
            self._close_log_handles()
            return False

        # Wait for health check
        # 中文：等待健康检查
        return self._wait_for_health()

    def _resolve_log_dir(self) -> str:
        """Pick a directory to store Gateway stdout/stderr logs.

        Priority:
          1. ``MEMORY_TENCENTDB_LOG_DIR`` env var
          2. ``~/.hermes/logs/memory_tencentdb`` (hermes-style log location)
          3. ``<cwd>/.memory-tencentdb-logs`` (last-resort fallback if $HOME
             is not set — unusual on real systems, but e.g. hermetic tests)

        Note: the supervisor intentionally does *not* derive this from the
        Gateway's data dir — the Gateway owns that path and the supervisor
        no longer tracks it. Keeping our log dir in the hermes log tree also
        avoids interleaving Gateway logs with user-facing memory data.
        中文：选择一个目录来存储网关stdout/stderr日志。
        优先级：
        1. `MEMORY_TENCENTDB_LOG_DIR`环境变量
        2. `~/.hermes/logs/memory_tencentdb`（hermes风格的日志位置）
        3. `<cwd>/.memory-tencentdb-logs`（如果未设置$HOME——在实际系统中不常见，但在例如封闭测试中可能有用）
        注意：监督器故意不从网关的数据目录派生此路径——网关拥有该路径且监督器不再跟踪它。将我们的日志目录保留在hermes日志树中也避免了与用户可见的内存数据交织。
        """
        env_dir = os.environ.get("MEMORY_TENCENTDB_LOG_DIR")
        if env_dir:
            return env_dir
        home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
        if home:
            return os.path.join(home, ".hermes", "logs", "memory_tencentdb")
        return os.path.join(os.getcwd(), ".memory-tencentdb-logs")

    def _close_log_handles(self) -> None:
        """Close log file handles; safe to call multiple times.

        中文：关闭日志文件句柄；多次调用安全。
        """
        for attr in ("_stdout_log", "_stderr_log"):
            handle: Optional[IO[bytes]] = getattr(self, attr, None)
            if handle is not None:
                try:
                    handle.close()
                except Exception:
                    pass
                setattr(self, attr, None)

    def _tail_stderr_log(self, max_bytes: int = LOG_TAIL_BYTES_ON_CRASH) -> str:
        """Return the last `max_bytes` of the stderr log for crash diagnostics.

        中文：返回stderr日志的最后`max_bytes`字节用于崩溃诊断。
        """
        path = self._stderr_log_path
        if not path:
            return ""
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                if size > max_bytes:
                    f.seek(-max_bytes, os.SEEK_END)
                return f.read().decode("utf-8", errors="replace")
        except Exception:
            return ""

    def _wait_for_health(self) -> bool:
        """Wait for the Gateway to become healthy.

        中文：等待网关变得健康。
        """
        start = time.monotonic()
        while time.monotonic() - start < HEALTH_CHECK_MAX_WAIT:
            # Check if process died
            # 中文：检查进程是否已死亡
            if self._process and self._process.poll() is not None:
                rc = self._process.returncode
                # stderr was redirected to a log file; tail it for diagnostics.
                # 中文：标准错误已被重定向到一个日志文件；使用tail进行诊断。
                stderr = self._tail_stderr_log()[:500]
                logger.error(
                    "memory-tencentdb Gateway process exited with code %d during startup. "
                    "stderr_log=%s tail=%s",
                    rc, self._stderr_log_path or "<none>", stderr,
                )
                self._close_log_handles()
                return False

            try:
                result = self._client.health(timeout=2)
                if result.get("status") in ("ok", "degraded"):
                    logger.info(
                        "memory-tencentdb Gateway is ready (took %.1fs)",
                        time.monotonic() - start,
                    )
                    return True
            except Exception:
                pass

            time.sleep(HEALTH_CHECK_INTERVAL)

        logger.error(
            "memory-tencentdb Gateway did not become healthy within %ds",
            HEALTH_CHECK_MAX_WAIT,
        )
        return False

    def shutdown(self) -> None:
        """Shut down the managed Gateway process (if we started it).

        中文：关闭我们启动的托管网关进程（如果启用了它）。
        """
        if self._process is None:
            return

        logger.info("Shutting down memory-tencentdb Gateway...")

        try:
            # Send SIGTERM for graceful shutdown
            # 中文：发送SIGTERM以实现优雅关闭
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                logger.warning("memory-tencentdb Gateway did not exit in 10s, sending SIGKILL")
                self._process.kill()
                self._process.wait(timeout=5)
        except Exception as e:
            logger.warning("Error shutting down memory-tencentdb Gateway: %s", e)
        finally:
            self._process = None
            self._close_log_handles()

    @property
    def client(self) -> MemoryTencentdbSdkClient:
        """Get the HTTP client for making API calls.

        中文：获取用于发起API调用的HTTP客户端
        """
        return self._client
