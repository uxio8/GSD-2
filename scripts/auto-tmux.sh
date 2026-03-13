#!/bin/zsh
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/auto-tmux.sh start <project-path>
  scripts/auto-tmux.sh status <project-path>
  scripts/auto-tmux.sh attach <project-path>
  scripts/auto-tmux.sh stop <project-path>
  scripts/auto-tmux.sh kill <project-path>

What it does:
  - starts a persistent tmux session running the local headless auto runner
  - stores runner metadata under ~/.gsd/runtime/
  - lets you inspect or attach later without depending on this terminal
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

subcommand="${1}"
project_path="$(cd "${2}" && pwd)"
project_name="$(basename "${project_path}")"
gsd_root="$(cd "$(dirname "${0}")/.." && pwd)"
state_file="${project_path}/.gsd/STATE.md"
lock_file="${project_path}/.gsd/auto.lock"
log_file="${project_path}/.gsd/tmux-auto.log"
headless_log_file="${project_path}/.gsd/auto-run.log"
safe_project_key="$(echo "${project_path}" | tr '/:' '__' | tr -cs '[:alnum:]_-' '_')"
runtime_dir="${HOME}/.gsd/runtime/${safe_project_key}"
pid_file="${runtime_dir}/headless-auto.pid"
session_file="${runtime_dir}/tmux-auto.session"
derived_state_script="${gsd_root}/scripts/derived-state-summary.mjs"
derived_state_resolver="${gsd_root}/src/resources/extensions/gsd/tests/resolve-ts.mjs"
sanitized_name="$(echo "${project_name}" | tr -cs '[:alnum:]' '-' | sed 's/^-*//; s/-*$//')"
session_name="gsd-auto-${sanitized_name}"

mkdir -p "${project_path}/.gsd"
mkdir -p "${runtime_dir}"
echo "${session_name}" > "${session_file}"

has_session() {
  tmux has-session -t "${session_name}" 2>/dev/null
}

pane_text() {
  tmux capture-pane -p -t "${session_name}:0.0" 2>/dev/null || true
}

print_state_summary() {
  echo "project: ${project_name}"
  echo "path: ${project_path}"
  echo "tmux-session: ${session_name}"
  echo "tmux-log: ${log_file}"

  if has_session; then
    echo "runner: running in tmux"
  else
    echo "runner: stopped"
  fi

  if [[ -f "${lock_file}" ]]; then
    echo "auto-lock: present"
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

count_missing_optional_keys() {
  return 0
}

case "${subcommand}" in
  start)
    if has_session; then
      echo "tmux session ${session_name} already exists"
      print_state_summary
      exit 0
    fi

    : > "${log_file}"
    tmux new-session -d -s "${session_name}" -c "${gsd_root}" "node ${gsd_root}/scripts/headless-auto.mjs '${project_path}' '${headless_log_file}'"
    tmux pipe-pane -o -t "${session_name}:0.0" "cat >> ${log_file}"
    sleep 1
    pane_pid="$(tmux list-panes -t "${session_name}:0.0" -F '#{pane_pid}' | head -n 1)"
    if [[ -n "${pane_pid}" ]]; then
      echo "${pane_pid}" > "${pid_file}"
    fi

    echo "started tmux session ${session_name}"
    print_state_summary
    echo
    echo "attach with: tmux attach -t ${session_name}"
    ;;
  status)
    print_state_summary
    echo
    if has_session; then
      echo "recent pane output:"
      tmux capture-pane -p -t "${session_name}:0.0" | tail -n 20
    fi
    ;;
  attach)
    tmux attach -t "${session_name}"
    ;;
  stop)
    if ! has_session; then
      echo "tmux session ${session_name} is not running"
      exit 0
    fi
    pane_pid="$(tmux list-panes -t "${session_name}:0.0" -F '#{pane_pid}' | head -n 1)"
    if [[ -n "${pane_pid}" ]]; then
      kill "${pane_pid}" 2>/dev/null || true
    fi
    sleep 1
    if has_session; then
      tmux kill-session -t "${session_name}"
    fi
    rm -f "${pid_file}"
    echo "stopped ${session_name}"
    ;;
  kill)
    if ! has_session; then
      echo "tmux session ${session_name} is not running"
      exit 0
    fi
    tmux kill-session -t "${session_name}"
    rm -f "${pid_file}"
    echo "killed tmux session ${session_name}"
    ;;
  *)
    usage
    exit 1
    ;;
esac
