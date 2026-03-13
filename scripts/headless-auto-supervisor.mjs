import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isTerminalState, parseStateSnapshot } from "./headless-auto-state.mjs";

const runnerScript = process.argv[2] ? resolve(process.argv[2]) : null;
const projectPath = process.argv[3] ? resolve(process.argv[3]) : null;
const logFile = process.argv[4] ? resolve(process.argv[4]) : null;
const runtimeDir = process.argv[5] ? resolve(process.argv[5]) : null;

if (!runnerScript || !projectPath || !logFile || !runtimeDir) {
  console.error("usage: node scripts/headless-auto-supervisor.mjs <runner-script> <project-path> <log-file> <runtime-dir>");
  process.exit(1);
}

const lockFile = join(projectPath, ".gsd", "auto.lock");
const stateFile = join(projectPath, ".gsd", "STATE.md");
const pidFile = join(runtimeDir, "headless-auto.pid");
const repoRoot = resolve(dirname(runnerScript), "..");
const checkIntervalMs = 5000;
const restartDelayMs = 2000;
const startupLockTimeoutMs = 2 * 60 * 1000;
const silenceTimeoutMs = 2 * 60 * 1000;
const killGraceMs = 10 * 1000;

let stopRequested = false;
let activeChild = null;

function log(message) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[${new Date().toISOString()}] supervisor ${message}\n`, "utf8");
}

function isPidRunning(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid() {
  if (!existsSync(lockFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
    return typeof parsed?.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function clearStaleLock(expectedPid = null) {
  if (!existsSync(lockFile)) return;
  const lockPid = readLockPid();
  if (expectedPid && lockPid === expectedPid) {
    try {
      unlinkSync(lockFile);
    } catch {
    }
    return;
  }
  if (!lockPid || !isPidRunning(lockPid)) {
    try {
      unlinkSync(lockFile);
    } catch {
    }
  }
}

function writePidFile(pid) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(pidFile, `${pid}\n`, "utf8");
}

function clearPidFile() {
  try {
    unlinkSync(pidFile);
  } catch {
  }
}

function readLogMtimeMs() {
  try {
    return statSync(logFile).mtimeMs;
  } catch {
    return 0;
  }
}

function readStateSnapshot() {
  if (!existsSync(stateFile)) return null;
  try {
    return parseStateSnapshot(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function isTerminalProjectState() {
  return isTerminalState(readStateSnapshot());
}

function requestStop(signalName) {
  if (stopRequested) return;
  stopRequested = true;
  log(signalName);
  clearPidFile();
  const child = activeChild;
  if (!child?.pid || !isPidRunning(child.pid)) return;
  try {
    child.kill("SIGTERM");
  } catch {
  }
  setTimeout(() => {
    if (!activeChild?.pid || activeChild.pid !== child.pid) return;
    if (!isPidRunning(child.pid)) return;
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }, killGraceMs).unref?.();
}

process.on("SIGTERM", () => requestStop("sigterm"));
process.on("SIGINT", () => requestStop("sigint"));

function startChild(reason) {
  clearStaleLock();
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=8192", runnerScript, projectPath, logFile],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (!child.pid) {
    throw new Error("failed to spawn headless-auto child");
  }
  activeChild = child;
  writePidFile(child.pid);
  log(`child-start pid=${child.pid} reason=${reason}`);
  return child;
}

function monitorChild(child) {
  const startedAt = Date.now();
  let lastProgressAt = Math.max(startedAt, readLogMtimeMs());
  let pendingRestartReason = null;
  let restartSignalSentAt = 0;

  return new Promise((resolveMonitor) => {
    const finish = (reason) => {
      clearInterval(interval);
      child.removeAllListeners("exit");
      if (activeChild?.pid === child.pid) activeChild = null;
      clearPidFile();
      clearStaleLock(child.pid);
      resolveMonitor(reason);
    };

    child.on("exit", (code, signal) => {
      const reason = pendingRestartReason ?? `exit code=${code ?? "null"} signal=${signal ?? "none"}`;
      log(`child-exit pid=${child.pid} reason=${reason}`);
      finish(stopRequested ? "stopped" : reason);
    });

    child.on("error", (error) => {
      pendingRestartReason = pendingRestartReason ?? `spawn-error ${error.message}`;
      log(`child-error pid=${child.pid ?? "unknown"} message=${error.message}`);
    });

    const interval = setInterval(() => {
      if (stopRequested) return;

      const now = Date.now();
      const currentLogMtime = readLogMtimeMs();
      if (currentLogMtime > lastProgressAt) {
        lastProgressAt = currentLogMtime;
      }

      const lockPresent = existsSync(lockFile);
      const referenceAt = Math.max(startedAt, lastProgressAt);
      const silenceMs = now - referenceAt;

      if (!pendingRestartReason) {
        if (!lockPresent && now - startedAt >= startupLockTimeoutMs) {
          pendingRestartReason = "startup-no-lock-timeout";
        } else if (silenceMs >= silenceTimeoutMs) {
          pendingRestartReason = lockPresent ? "silent-worker-timeout" : "silent-startup-timeout";
        }

        if (pendingRestartReason) {
          log(`child-timeout pid=${child.pid} reason=${pendingRestartReason} silence_ms=${silenceMs}`);
          clearStaleLock(child.pid);
          restartSignalSentAt = now;
          try {
            child.kill("SIGTERM");
          } catch {
          }
          return;
        }
      }

      if (pendingRestartReason && now - restartSignalSentAt >= killGraceMs && isPidRunning(child.pid)) {
        log(`child-kill pid=${child.pid} reason=${pendingRestartReason}`);
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    }, checkIntervalMs);
    interval.unref?.();
  });
}

async function main() {
  log(`start project=${projectPath}`);
  let startReason = "initial";

  while (!stopRequested) {
    if (isTerminalProjectState()) {
      log("terminal-state-detected before-start");
      break;
    }

    let result = "unknown";
    try {
      const child = startChild(startReason);
      result = await monitorChild(child);
    } catch (error) {
      result = `supervisor-error ${error instanceof Error ? error.message : String(error)}`;
      log(result);
    }
    if (stopRequested || result === "stopped") break;
    if (isTerminalProjectState()) {
      log(`terminal-state-detected after-child reason=${result}`);
      break;
    }
    startReason = `restart-after-${result}`;
    log(`restart-scheduled reason=${startReason}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, restartDelayMs));
  }

  clearPidFile();
  clearStaleLock();
  log("exit");
}

await main();
