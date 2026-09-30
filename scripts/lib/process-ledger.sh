#!/usr/bin/env bash

process_ledger_dir() {
  if [ -n "${MERCURY_PROCESS_LEDGER_DIR:-}" ]; then
    printf '%s' "$MERCURY_PROCESS_LEDGER_DIR"
  else
    printf '%s/mercury-process-ledger-%s' "${TMPDIR:-/tmp}" "$(id -u)"
  fi
}

process_started_at() {
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'
}

process_alive() {
  local stat
  stat=$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')
  [ -n "$stat" ] && [ "${stat#Z}" = "$stat" ]
}

process_end_tree() {
  local p=$1 c
  [ "$p" -gt 1 ] 2>/dev/null || return 0
  [ "$p" != "$$" ] && [ "$p" != "${BASHPID:-}" ] || return 0
  kill -STOP "$p" 2>/dev/null
  for c in $(pgrep -P "$p" 2>/dev/null); do process_end_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}

process_ledger_read() {
  local line="" tab=$'\t' n=0
  local -a fields=()
  [ -f "$1" ] || return 1
  IFS= read -r line <"$1" || [ -n "$line" ] || return 1
  while [ "$n" -lt 4 ]; do
    case "$line" in
      (*"$tab"*) fields+=("${line%%"$tab"*}"); line=${line#*"$tab"} ;;
      (*) fields+=("$line"); line="" ;;
    esac
    n=$((n + 1))
  done
  fields+=("$line")
  pid=${fields[0]}
  runner=${fields[1]}
  started=${fields[2]}
  cwd=${fields[3]}
  command=${fields[4]}
  case "$started" in ('?') started="" ;; esac
  return 0
}

process_ledger_reap() {
  local dir=${1:-$(process_ledger_dir)} entry pid runner started cwd command now ended=0
  [ -d "$dir" ] || return 0
  for entry in "$dir"/*.entry; do
    [ -f "$entry" ] || continue
    process_ledger_read "$entry" || { rm -f "$entry"; continue; }
    case "$pid" in ('' | *[!0-9]*) rm -f "$entry"; continue ;; esac
    if ! process_alive "$pid"; then rm -f "$entry"; continue; fi
    now=$(process_started_at "$pid")
    if [ -n "$started" ] && [ "$now" != "$started" ]; then rm -f "$entry"; continue; fi
    if [ -n "${2:-}" ] && [ "$2" = "--only-dead-runners" ] && [ -n "$runner" ] && process_alive "$runner"; then continue; fi
    process_end_tree "$pid"
    ended=$((ended + 1))
    printf 'process ledger: ended %s (%s) — its runner %s is %s\n' "$pid" "${command:-?}" "${runner:-?}" "$( [ -n "$runner" ] && process_alive "$runner" && echo alive || echo gone)"
    rm -f "$entry"
  done
  return 0
}
