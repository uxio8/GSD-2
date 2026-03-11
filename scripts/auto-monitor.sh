#!/bin/zsh
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/auto-monitor.sh start <project-path>
  scripts/auto-monitor.sh status <project-path>
  scripts/auto-monitor.sh tail <project-path>
  scripts/auto-monitor.sh stop <project-path>

Defaults:
  If no subcommand is provided, "start" is used.

What it does:
  - starts GSD auto mode headless in the background
  - writes a pid file at .gsd/headless-auto.pid
  - logs execution to .gsd/auto-run.log
  - lets you inspect or tail the same run later
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

case "${1}" in
  start|status|tail|stop)
    subcommand="${1}"
    shift
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    subcommand="start"
    ;;
esac

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

project_path="$(cd "${1}" && pwd)"
project_name="$(basename "${project_path}")"
gsd_root="$(cd "$(dirname "${0}")/.." && pwd)"
log_file="${project_path}/.gsd/auto-run.log"
pid_file="${project_path}/.gsd/headless-auto.pid"
stdout_file="${project_path}/.gsd/headless-auto.stdout.log"
state_file="${project_path}/.gsd/STATE.md"
lock_file="${project_path}/.gsd/auto.lock"
derived_state_script="${gsd_root}/scripts/derived-state-summary.mjs"
derived_state_resolver="${gsd_root}/src/resources/extensions/gsd/tests/resolve-ts.mjs"

mkdir -p "${project_path}/.gsd"

is_pid_running() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1
}

read_pid() {
  if [[ -f "${pid_file}" ]]; then
    tr -d '[:space:]' < "${pid_file}"
  fi
}

read_lock_pid() {
  if [[ ! -f "${lock_file}" ]]; then
    return 0
  fi

  node -e '
    const fs = require("fs");
    try {
      const raw = fs.readFileSync(process.argv[1], "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.pid) process.stdout.write(String(parsed.pid));
    } catch {}
  ' "${lock_file}"
}

clear_lock_file() {
  node -e '
    const fs = require("fs");
    try {
      fs.unlinkSync(process.argv[1]);
    } catch {}
  ' "${lock_file}"
}

print_state_summary() {
  echo "project: ${project_name}"
  echo "path: ${project_path}"
  echo "log: ${log_file}"
  echo "pid-file: ${pid_file}"

  local pid
  pid="$(read_pid || true)"
  local lock_pid
  lock_pid="$(read_lock_pid || true)"
  if [[ -n "${pid}" ]] && is_pid_running "${pid}"; then
    echo "runner: running (pid ${pid})"
  elif [[ -n "${lock_pid}" ]] && is_pid_running "${lock_pid}"; then
    echo "runner: running via lock pid ${lock_pid}"
  elif [[ -n "${pid}" ]]; then
    echo "runner: stale pid ${pid}"
  else
    echo "runner: stopped"
  fi

  if [[ -f "${lock_file}" ]]; then
    if [[ -n "${lock_pid}" ]] && is_pid_running "${lock_pid}"; then
      echo "auto-lock: present"
    else
      echo "auto-lock: stale"
    fi
  else
    echo "auto-lock: absent"
  fi

  if node --import "${derived_state_resolver}" --experimental-strip-types "${derived_state_script}" "${project_path}" 2>/dev/null; then
    :
  elif [[ -f "${state_file}" ]]; then
    echo "derived-state: unavailable, falling back to STATE.md cache"
    sed -n '/^\*\*Active Milestone:\*\*/p;/^\*\*Active Slice:\*\*/p;/^\*\*Active Task:\*\*/p;/^\*\*Phase:\*\*/p;/^\*\*Next Action:\*\*/p' "${state_file}"
  else
    echo "state: missing ${state_file}"
  fi
}

start_runner() {
  local pid
  pid="$(read_pid || true)"
  if [[ -n "${pid}" ]] && is_pid_running "${pid}"; then
    echo "auto runner already running for ${project_name} (pid ${pid})"
    return 0
  fi

  local lock_pid
  lock_pid="$(read_lock_pid || true)"
  if [[ -n "${lock_pid}" ]] && is_pid_running "${lock_pid}"; then
    echo "${lock_pid}" > "${pid_file}"
    echo "auto runner already running for ${project_name} via lock pid ${lock_pid}"
    return 0
  fi

  nohup node "${gsd_root}/scripts/headless-auto.mjs" "${project_path}" "${log_file}" >> "${stdout_file}" 2>&1 &
  pid="$!"
  echo "${pid}" > "${pid_file}"
  sleep 1

  if ! is_pid_running "${pid}"; then
    echo "failed to start auto runner for ${project_name}" >&2
    exit 1
  fi

  echo "started auto runner for ${project_name} (pid ${pid})"
}

tail_logs() {
  touch "${log_file}"
  echo
  echo "tailing ${log_file}"
  echo "Ctrl+C to stop tailing. The runner keeps going in background."
  echo
  tail -n 80 -f "${log_file}"
}

case "${subcommand}" in
  start)
    start_runner
    print_state_summary
    tail_logs
    ;;
  status)
    print_state_summary
    ;;
  tail)
    tail_logs
    ;;
  stop)
    pid="$(read_pid || true)"
    lock_pid="$(read_lock_pid || true)"
    if [[ -z "${pid}" ]]; then
      if [[ -n "${lock_pid}" ]] && is_pid_running "${lock_pid}"; then
        kill "${lock_pid}"
        echo "stopped auto runner for ${project_name} via lock pid ${lock_pid}"
        rm -f "${pid_file}"
        sleep 1
        if ! is_pid_running "${lock_pid}"; then
          clear_lock_file
        fi
        exit 0
      fi
      if [[ -f "${lock_file}" ]]; then
        clear_lock_file
        echo "cleared stale auto-lock for ${project_name}"
      fi
      echo "no pid file for ${project_name}"
      exit 0
    fi
    if ! is_pid_running "${pid}"; then
      if [[ -n "${lock_pid}" ]] && is_pid_running "${lock_pid}"; then
        echo "${lock_pid}" > "${pid_file}"
        kill "${lock_pid}"
        echo "stopped auto runner for ${project_name} via lock pid ${lock_pid}"
        rm -f "${pid_file}"
        sleep 1
        if ! is_pid_running "${lock_pid}"; then
          clear_lock_file
        fi
        exit 0
      fi
      echo "runner not running; removing stale pid ${pid}"
      rm -f "${pid_file}"
      clear_lock_file
      exit 0
    fi
    kill "${pid}"
    echo "stopped auto runner for ${project_name} (pid ${pid})"
    rm -f "${pid_file}"
    sleep 1
    if ! is_pid_running "${pid}"; then
      clear_lock_file
    fi
    ;;
esac
