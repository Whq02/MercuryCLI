#!/usr/bin/env bash

suite_env_guard() {
  local runner="${1:?suite_env_guard: the path of the runner}" dir name line declared="" foreign=""
  local -a inputs
  suite_home_guard "$runner"
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
      MERCURY_CONFIG_DIR|MERCURY_HOME|MERCURY_CREDENTIAL_STORE|MERCURY_DAEMON_DIR|MERCURY_NODE|MERCURY_SUITE_ENV) continue ;;
      MERCURY_GATE_*|MERCURY_CI_*|MERCURY_SUITE_*|MERCURY_SLICE_*|MERCURY_VSHOT_*) continue ;;
      MERCURY_CUSTOM_OAUTH_URL|MERCURY_UPDATE_API_BASE_URL|MERCURY_*_BASE) continue ;;
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
  return 0
}
