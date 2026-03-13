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
  - writes runner metadata under ~/.gsd/runtime/
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
safe_project_key="$(echo "${project_path}" | tr '/:' '__' | tr -cs '[:alnum:]_-' '_')"
runtime_dir="${HOME}/.gsd/runtime/${safe_project_key}"
pid_file="${runtime_dir}/headless-auto.pid"
stdout_file="${runtime_dir}/headless-auto.stdout.log"
label_file="${runtime_dir}/launchctl.label"
state_file="${project_path}/.gsd/STATE.md"
lock_file="${project_path}/.gsd/auto.lock"
derived_state_script="${gsd_root}/scripts/derived-state-summary.mjs"
derived_state_resolver="${gsd_root}/src/resources/extensions/gsd/tests/resolve-ts.mjs"
runner_script="${gsd_root}/scripts/headless-auto.mjs"
supervisor_script="${gsd_root}/scripts/headless-auto-supervisor.mjs"
launchctl_label="com.gsd.auto.${safe_project_key}"
launch_agents_dir="${HOME}/Library/LaunchAgents"
launchctl_plist="${launch_agents_dir}/${launchctl_label}.plist"

mkdir -p "${project_path}/.gsd"
mkdir -p "${runtime_dir}"

supports_launchctl() {
  [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1
}

shell_quote() {
  printf '%q' "$1"
}

build_launch_env_prefix() {
  local vars=(
    HOME USER LOGNAME SHELL PATH TMPDIR SSH_AUTH_SOCK
    LANG LC_ALL TERM COLORTERM CODEX_HOME NODE_PATH
    GSD_CODING_AGENT_DIR PI_PACKAGE_DIR PI_SKIP_VERSION_CHECK
  )
  local parts=()
  local name value
  for name in "${vars[@]}"; do
    value="${(P)name-}"
    if [[ -n "${value}" ]]; then
      parts+=("${name}=$(shell_quote "${value}")")
    fi
  done
  printf '%s ' "${parts[@]}"
}

xml_escape() {
  local value="${1}"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "${value}"
}

write_launchctl_plist() {
  mkdir -p "${launch_agents_dir}"
  local command
  command="cd $(shell_quote "${gsd_root}") && exec node $(shell_quote "${supervisor_script}") $(shell_quote "${runner_script}") $(shell_quote "${project_path}") $(shell_quote "${log_file}") $(shell_quote "${runtime_dir}")"
  cat > "${launchctl_plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "${launchctl_label}")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>$(xml_escape "${command}")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${gsd_root}")</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${stdout_file}")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${stdout_file}")</string>
  <key>EnvironmentVariables</key>
  <dict>
EOF

  local vars=(
    HOME USER LOGNAME SHELL PATH TMPDIR SSH_AUTH_SOCK
    LANG LC_ALL TERM COLORTERM CODEX_HOME NODE_PATH
    GSD_CODING_AGENT_DIR PI_PACKAGE_DIR PI_SKIP_VERSION_CHECK
  )
  local name value
  for name in "${vars[@]}"; do
    value="${(P)name-}"
    if [[ -n "${value}" ]]; then
      cat >> "${launchctl_plist}" <<EOF
    <key>$(xml_escape "${name}")</key>
    <string>$(xml_escape "${value}")</string>
EOF
    fi
  done

  cat >> "${launchctl_plist}" <<EOF
  </dict>
</dict>
</plist>
EOF
}

write_launchctl_label() {
  echo "${launchctl_label}" > "${label_file}"
}

read_launchctl_label() {
  if [[ -f "${label_file}" ]]; then
    tr -d '[:space:]' < "${label_file}"
  fi
}

is_launchctl_running() {
  local label="${1:-}"
  [[ -n "${label}" ]] || return 1
  launchctl print "gui/$(id -u)/${label}" 2>/dev/null | grep -q "state = running"
}

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

is_terminal_state_file() {
  [[ -f "${state_file}" ]] || return 1
  if grep -Eq '^\*\*Phase:\*\* (complete|blocked)$' "${state_file}"; then
    return 0
  fi
  grep -Eq '^\*\*Next Action:\*\* All milestones complete\.$' "${state_file}"
}

print_state_summary() {
  echo "project: ${project_name}"
  echo "path: ${project_path}"
  echo "log: ${log_file}"
  echo "pid-file: ${pid_file}"
  echo "launchctl-label-file: ${label_file}"

  local pid
  pid="$(read_pid || true)"
  local lock_pid
  lock_pid="$(read_lock_pid || true)"
  local label
  label="$(read_launchctl_label || true)"
  if [[ -n "${label}" ]] && is_launchctl_running "${label}"; then
    echo "runner: running via launchctl (${label})"
  elif [[ -n "${pid}" ]] && is_pid_running "${pid}"; then
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
  if is_terminal_state_file; then
    echo "project ${project_name} is already in a terminal state; not starting auto runner"
    return 0
  fi

  local stale_lock_pid
  stale_lock_pid="$(read_lock_pid || true)"
  if [[ -f "${lock_file}" ]] && { [[ -z "${stale_lock_pid}" ]] || ! is_pid_running "${stale_lock_pid}"; }; then
    clear_lock_file
  fi

  local label
  label="$(read_launchctl_label || true)"
  if supports_launchctl; then
    if [[ -z "${label}" ]]; then
      write_launchctl_label
      label="${launchctl_label}"
    fi

    if is_launchctl_running "${label}"; then
      echo "auto runner already running for ${project_name} via launchctl (${label})"
      return 0
    fi

    write_launchctl_plist
    launchctl bootout "gui/$(id -u)" "${launchctl_plist}" >/dev/null 2>&1 || true
    launchctl remove "${label}" >/dev/null 2>&1 || true
    : > "${stdout_file}"
    launchctl bootstrap "gui/$(id -u)" "${launchctl_plist}"
    sleep 1

    if ! is_launchctl_running "${label}"; then
      if is_terminal_state_file; then
        echo "project ${project_name} reached a terminal state; auto runner exited cleanly"
        return 0
      fi
      echo "failed to start auto runner for ${project_name} via launchctl/LaunchAgent" >&2
      exit 1
    fi

    echo "started auto runner for ${project_name} via LaunchAgent (${label})"
    return 0
  fi

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

  nohup node "${supervisor_script}" "${runner_script}" "${project_path}" "${log_file}" "${runtime_dir}" >> "${stdout_file}" 2>&1 &
  pid="$!"
  echo "${pid}" > "${pid_file}"
  sleep 1

  if ! is_pid_running "${pid}"; then
    if is_terminal_state_file; then
      echo "project ${project_name} reached a terminal state; auto runner exited cleanly"
      return 0
    fi
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
    label="$(read_launchctl_label || true)"
    if [[ -n "${label}" ]] && { is_launchctl_running "${label}" || [[ -f "${launchctl_plist}" ]]; }; then
      launchctl bootout "gui/$(id -u)" "${launchctl_plist}" >/dev/null 2>&1 || launchctl remove "${label}" >/dev/null 2>&1 || true
      rm -f "${launchctl_plist}"
      rm -f "${pid_file}"
      sleep 1
      lock_pid="$(read_lock_pid || true)"
      if [[ -z "${lock_pid}" ]] || ! is_pid_running "${lock_pid}"; then
        clear_lock_file
      fi
      echo "stopped auto runner for ${project_name} via LaunchAgent (${label})"
      exit 0
    fi

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
