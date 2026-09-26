"""Modal app ``midas-engine``: the Node.js MIDAS engine (apps/engine) as an always-on service.

    modal secret create midas-engine GEMINI_API_KEY=... MIDAS_STDB_URI=... MIDAS_STDB_TOKEN=... ...
    modal deploy modal/engine_app.py                        # URL printed = engine control API
    MIDAS_ENGINE_WORKERS=4 modal deploy modal/engine_app.py # + 4 horizontal task workers

Layout:
  Engine          1 container (min=max=1), @modal.web_server(8080): the leader (MIDAS_ROLE=all by
                  default) runs under a supervisor that restarts it with backoff if it exits.
  worker          MIDAS_ROLE=worker; pulls tasks from the SpacetimeDB ledger, so N copies
                  parallelise without coordination. Runs up to ~23.5 h per call, then exits.
  keep_workers    every 15 min: keeps exactly MIDAS_ENGINE_WORKERS worker calls running
                  (spawns replacements before the 24 h function limit; cancels extras).
                  min_containers cannot do this: warm containers never run a function body.

Verified against modal 1.5.5: Image.from_registry(tag, add_python=), Image.add_local_dir(
local_path, remote_path, copy=, ignore=[dockerignore patterns]), Image.run_commands, Image.env,
modal.web_server(port, startup_timeout=) (Modal waits for the port on eth0, so the engine must
listen on 0.0.0.0, not 127.0.0.1), App.cls/function(min_containers, max_containers, timeout,
schedule=modal.Period), modal.concurrent, modal.exit, Function.spawn, FunctionCall.from_id/
get(timeout=0)/cancel, Dict.from_name(create_if_missing=True).
"""

import os
import signal
import subprocess
import threading
import time
from pathlib import Path

import modal

APP_NAME = "midas-engine"
PORT = 8080
REMOTE_ROOT = "/app"
REPO_ROOT = Path(__file__).resolve().parent.parent  # only read at build time (local deploy)
ENGINE_CMD = ["node", "--import", "tsx", "apps/engine/src/index.ts"]
WORKER_RUN_HOURS = 23.5  # Modal caps a call at 24 h (timeout=86400)
WORKER_REPLACE_AFTER_S = 23 * 3600  # keeper spawns the successor this early

app = modal.App(APP_NAME)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    return float(raw) if raw else default


# Deploy-time knobs, forwarded into containers so re-imports there agree with the deploy.
_KNOBS = ("MIDAS_ENGINE_WORKERS", "MIDAS_ENGINE_CPU", "MIDAS_ENGINE_MEMORY", "MIDAS_LEADER_ROLE")
FORWARDED_ENV = {k: os.environ[k] for k in _KNOBS if os.environ.get(k)}
WORKERS = int(_env_float("MIDAS_ENGINE_WORKERS", 0))
CPU = _env_float("MIDAS_ENGINE_CPU", 1.0)  # physical cores requested per container
MEMORY = int(_env_float("MIDAS_ENGINE_MEMORY", 1024))  # MiB
LEADER_ROLE = os.environ.get("MIDAS_LEADER_ROLE", "all")  # all | leader

# Everything the engine needs is in the monorepo; secrets never enter the image.
IGNORE = [
    ".git",
    "**/node_modules",
    "**/.next",
    "**/dist",
    "**/out",
    "**/coverage",
    "**/*.tsbuildinfo",
    "**/.venv",
    "**/__pycache__",
    "**/*.pyc",
    "**/.DS_Store",
    "**/.env",
    "**/.env.*",
    "**/.midas-engine-token",
    "modal",
    "docs",
]

# `npm ci -w @midas/engine` installs only the engine's production deps (tsx included) and
# links the @midas/* workspace packages; Next.js and dev tooling are skipped (~180 MB).
image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.11")
    .add_local_dir(REPO_ROOT, REMOTE_ROOT, copy=True, ignore=IGNORE)
    .run_commands(f"cd {REMOTE_ROOT} && npm ci --omit=dev -w @midas/engine --no-audit --no-fund")
    .env({"NODE_ENV": "production", "MIDAS_HTTP_PORT": str(PORT)})
)
keeper_image = modal.Image.debian_slim(python_version="3.11")
engine_secret = modal.Secret.from_name("midas-engine")


class Supervisor:
    """Runs the engine as a child process and restarts it (exponential backoff) when it exits."""

    def __init__(self, role: str) -> None:
        self.role = role
        self.proc: subprocess.Popen[bytes] | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, name=f"engine-{role}", daemon=True)

    def start(self) -> "Supervisor":
        self._thread.start()
        return self

    def _run(self) -> None:
        backoff = 1.0
        env = {**os.environ, "MIDAS_ROLE": self.role, "MIDAS_HTTP_PORT": str(PORT)}
        while not self._stop.is_set():
            with self._lock:
                if self._stop.is_set():
                    return
                started = time.monotonic()
                self.proc = subprocess.Popen(ENGINE_CMD, cwd=REMOTE_ROOT, env=env)  # logs go to Modal
            code = self.proc.wait()
            if self._stop.is_set():
                return
            if time.monotonic() - started > 300:
                backoff = 1.0  # it ran for a while: treat as a fresh failure
            print(f"[supervisor] engine ({self.role}) exited with {code}; restart in {backoff:.0f}s", flush=True)
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 60.0)

    def stop(self, grace: float = 20.0) -> None:
        """SIGTERM the engine (graceful shutdown), SIGKILL after ``grace`` seconds."""
        self._stop.set()
        with self._lock:
            proc = self.proc
        if proc is not None and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                proc.kill()


@app.cls(
    image=image,
    secrets=[engine_secret],
    env=FORWARDED_ENV or None,
    cpu=CPU,
    memory=MEMORY,
    min_containers=1,  # always on: the leader loops run whether or not anyone calls the API
    max_containers=1,  # exactly one leader
    timeout=86400,
)
@modal.concurrent(max_inputs=100)  # the control API must not queue behind one slow request
class Engine:
    @modal.web_server(port=PORT, startup_timeout=120)
    def serve(self) -> None:
        # Called once at container start; Modal then waits for 0.0.0.0:8080 and proxies to it.
        self.supervisor = Supervisor(LEADER_ROLE).start()

    @modal.exit()
    def shutdown(self) -> None:
        if hasattr(self, "supervisor"):
            self.supervisor.stop()


@app.function(image=image, secrets=[engine_secret], env=FORWARDED_ENV or None, cpu=CPU, memory=MEMORY, timeout=86400)
def worker(hours: float = WORKER_RUN_HOURS) -> None:
    """One ledger task worker (MIDAS_ROLE=worker) for up to ``hours``; cancel-safe."""
    sup = Supervisor("worker").start()
    try:
        deadline = time.monotonic() + hours * 3600
        while time.monotonic() < deadline:
            time.sleep(15)
    finally:  # also runs on cancellation (keep_workers scale-down) and container shutdown
        sup.stop()


def _still_running(call_id: str) -> bool:
    try:
        modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:  # builtin TimeoutError: no output yet, i.e. queued or running
        return True
    except Exception:  # finished with an error, expired (OutputExpiredError) or unknown id
        return False
    return False  # returned normally


Call = tuple[str, float]  # (function call id, spawn time)


def plan_workers(running: list[Call], now: float, target: int) -> tuple[list[Call], int]:
    """Pure reconcile step -> (calls to cancel, number to spawn).

    Calls older than WORKER_REPLACE_AFTER_S are about to exit on their own, so they do not
    count toward ``target`` (their successors start early); surplus fresh calls are
    cancelled newest-first, and scaling to 0 cancels everything.
    """
    fresh = sorted((c for c in running if now - c[1] < WORKER_REPLACE_AFTER_S), key=lambda c: c[1])
    ageing = [c for c in running if c not in fresh]
    cancel = fresh[target:] + (ageing if target == 0 else [])
    return cancel, max(0, target - len(fresh))


@app.function(
    image=keeper_image, env=FORWARDED_ENV or None, schedule=modal.Period(minutes=15), max_containers=1, timeout=120
)
def keep_workers() -> dict[str, int]:
    """Reconcile running worker calls to MIDAS_ENGINE_WORKERS (state in a modal.Dict)."""
    state = modal.Dict.from_name("midas-engine-workers", create_if_missing=True)
    now = time.time()
    running = [(cid, ts) for cid, ts in state.get("calls", []) if _still_running(cid)]
    extra, spawn = plan_workers(running, now, WORKERS)
    for cid, _ in extra:
        modal.FunctionCall.from_id(cid).cancel()
    kept = [c for c in running if c not in extra]
    kept += [(worker.spawn().object_id, now) for _ in range(spawn)]
    state["calls"] = kept
    summary = {"target": WORKERS, "running": len(running), "spawned": spawn, "cancelled": len(extra)}
    print(f"[keep_workers] {summary}", flush=True)
    return summary
