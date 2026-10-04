#!/usr/bin/env bash

suite_env_guard() {
  local runner="${1:?suite_env_guard: the path of the runner}" dir name line declared="" foreign=""
  local -a inputs
  suite_home_guard "$runner"
  suite_scratch_init "$runner"
  export MERCURY_LOCAL_PROBE_TARGETS="${MERCURY_LOCAL_PROBE_TARGETS:-none}"
  [ "${MERCURY_SUITE_ENV:-}" = "any" ] && return 0
  if [ ! -r "$runner" ]; then
    echo "suite environment: cannot read runner declarations: $runner" >&2
    exit 78
  fi
  dir="$(cd "$(dirname "$runner")" && pwd)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '# gate-env:'*)
        read -r -a inputs <<<"${line#\# gate-env:}"
        for name in "${inputs[@]}"; do
          if [[ ! "$name" =~ ^MERCURY_[A-Z0-9_]+$ ]]; then
            echo "suite environment: invalid declaration in $runner (exact MERCURY_* names required)" >&2
            exit 78
          fi
          declared="$declared $name"
        done ;;
      '#'*|'') ;;
      *) break ;;
    esac
  done <"$runner"
  for name in $(env | sed -n 's/^\(MERCURY_[A-Z0-9_]*\)=.*/\1/p' | sort -u); do
    case "$name" in
      MERCURY_CONFIG_DIR|MERCURY_HOME|MERCURY_CREDENTIAL_STORE|MERCURY_DAEMON_DIR|MERCURY_NODE|MERCURY_SUITE_ENV|MERCURY_PROCESS_LEDGER_DIR) continue ;;
      MERCURY_LOCAL_PROBE_TARGETS) [ "${MERCURY_LOCAL_PROBE_TARGETS:-}" = none ] && continue ;;
      MERCURY_TMPDIR) [ "${MERCURY_TMPDIR:-}" = "${MERCURY_SUITE_TMPDIR:-}" ] && continue ;;
      MERCURY_GATE_*|MERCURY_CI_*|MERCURY_SUITE_*|MERCURY_SLICE_*|MERCURY_VSHOT_*) continue ;;
      MERCURY_UPDATE_API_BASE_URL|MERCURY_*_BASE) continue ;;
    esac
    case " $declared " in *" $name "*) continue ;; esac
    foreign="$foreign $name"
  done
  [ -z "$foreign" ] && return 0
  echo "suite $(basename "$dir"): refusing to start — foreign MERCURY_* in the environment:$foreign" >&2
  echo "  a proof never reads the machine: unset them (a Mercury session's tool shell scrubs its own stamps by default), or MERCURY_SUITE_ENV=any for a deliberate run" >&2
  exit 78
}

suite_home_guard() {
  local runner="${1:?suite_home_guard: the path of the runner}" suite root pin own p o cand base was bun seeded temp
  pin="${MERCURY_CONFIG_DIR:-}"
  own=""
  [ -n "${HOME:-}" ] && own="${HOME%/}/.mercury"
  was=""
  if [ -z "$pin" ]; then
    was="was unset"
  elif [ -n "$own" ]; then
    p="$(cd -P -- "$pin" 2>/dev/null && pwd -P)" || p=""
    o="$(cd -P -- "$own" 2>/dev/null && pwd -P)" || o=""
    for cand in "${pin%/}" "$p"; do
      for base in "$own" "$o"; do
        [ -n "$cand" ] && [ -n "$base" ] && case "$cand" in "$base"|"$base"/*) was="named the operator's own home" ;; esac
      done
    done
  fi
  [ -n "$was" ] || return 0
  suite="$(basename "$(cd "$(dirname -- "$runner")" 2>/dev/null && pwd)")"
  root="$(cd "$(dirname -- "$runner")/../.." 2>/dev/null && pwd)"
  temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  __suite_home_scratch="$(mktemp -d "${temp%/}/mercury-suite-home-$suite.XXXXXX")" || {
    echo "suite $suite: cannot make a scratch config home under $temp" >&2
    exit 78
  }
  trap suite_home_cleanup EXIT
  export MERCURY_CONFIG_DIR="$__suite_home_scratch"
  export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
  bun="${BUN:-${HOME:-}/.bun/bin/bun}"
  [ -x "$bun" ] || bun="$(command -v bun 2>/dev/null || true)"
  seeded=""
  if [ -n "$bun" ] && [ -n "$root" ] && [ -r "$root/scripts/lib/firstRunSeed.ts" ] && "$bun" run "$root/scripts/lib/firstRunSeed.ts" "$MERCURY_CONFIG_DIR" "$root"; then
    seeded=", seeded for $root"
  fi
  echo "suite $suite: MERCURY_CONFIG_DIR $was; this run's config home is $MERCURY_CONFIG_DIR$seeded; removed at exit" >&2
}

suite_home_cleanup() {
  [ -n "${__suite_home_scratch:-}" ] && rm -rf "$__suite_home_scratch"
  if [ -n "${__suite_temp_scratch:-}" ]; then
    suite_browser_cleanup >&2
    process_ledger_reap "${MERCURY_PROCESS_LEDGER_DIR:-}" >&2
    rm -rf "$__suite_temp_scratch"
  fi
  return 0
}

suite_browser_cleanup() {
  local ledger="${MERCURY_SUITE_TMPDIR:-}/browser-ledger"
  [ -d "$ledger" ] || return 0
  MERCURY_SUITE_BROWSER_CLEANER=1 "${MERCURY_NODE:-node}" "$(dirname "${BASH_SOURCE[0]}")/proofBrowser.cjs" "$ledger"
}

suite_socket_bound=100

suite_scratch_base() {
  local pair label cand canon probe bytes tried=""
  __suite_scratch_base="${TMPDIR:-/tmp}"
  __suite_scratch_note="TMPDIR as inherited; no socket bound on this host"
  case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) return 0 ;; esac
  for pair in "TMPDIR=${TMPDIR:-}" "fallback=/tmp"; do
    label=${pair%%=*}
    cand=${pair#*=}
    [ -n "$cand" ] || continue
    canon="$(cd -P -- "$cand" 2>/dev/null && pwd -P)" || continue
    probe="$canon/mercury-proof-run.XXXXXX/config-home/daemon/control.sock"
    bytes=$(printf '%s' "$probe" | wc -c | tr -d ' ')
    if [ "$bytes" -le "$suite_socket_bound" ]; then
      __suite_scratch_base="$canon"
      __suite_scratch_note="${tried:+$tried; }$label $cand keeps the daemon socket path at $bytes bytes, within the $suite_socket_bound-byte bound"
      return 0
    fi
    tried="${tried:+$tried; }$label $cand would put the daemon socket path at $bytes bytes, past the $suite_socket_bound-byte bound"
  done
  __suite_scratch_base=/tmp
  __suite_scratch_note="$tried; no temp root keeps the daemon socket within the bound, the run root stays under /tmp"
  return 0
}

suite_scratch_init() {
  local subject="${1:-$0}"
  if [ "${MERCURY_SUITE_SCRIPT:-}" != "$subject" ] || [ -z "${MERCURY_SUITE_TMPDIR:-}" ] || [ ! -d "$MERCURY_SUITE_TMPDIR" ]; then
    suite_scratch_base
    __suite_temp_scratch=$(command mktemp -d "${__suite_scratch_base%/}/mercury-proof-run.XXXXXX") || {
      printf 'suite: cannot create temporary proof root under %s\n' "$__suite_scratch_base" >&2
      exit 78
    }
    export MERCURY_SUITE_TMPDIR="$__suite_temp_scratch"
    export MERCURY_SUITE_TMPDIR_NOTE="$__suite_scratch_note"
    export MERCURY_SUITE_SCRIPT="$subject"
    export MERCURY_SUITE_RUNNER_PID="$$"
    export MERCURY_PROCESS_LEDGER_DIR="$__suite_temp_scratch/process-ledger"
    . "$(dirname "${BASH_SOURCE[0]}")/process-ledger.sh" || exit 78
    trap suite_home_cleanup EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap 'exit 129' HUP
  fi
  export TMPDIR="$MERCURY_SUITE_TMPDIR"
  export MERCURY_TMPDIR="$MERCURY_SUITE_TMPDIR"
  local preload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/proofScratch.cjs"
  case "${NODE_OPTIONS:-}" in
    *"$preload"*) ;;
    *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$preload\"" ;;
  esac
  export -f mktemp
}

mktemp() {
  local arg root="${MERCURY_SUITE_TMPDIR:-}"
  local -a args=()
  for arg in "$@"; do
    if [ -n "$root" ]; then
      case "$arg" in
        "$root"/*|"/private$root"/*|"${root#/private}"/*) ;;
        /private/tmp/mw/*|/tmp/mw/*) arg="$root/${arg##*/}" ;;
      esac
    fi
    args+=("$arg")
  done
  command mktemp "${args[@]}"
}
