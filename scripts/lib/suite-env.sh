#!/usr/bin/env bash

suite_env_guard() {
  local runner="${1:?suite_env_guard: the path of the runner}" dir name value foreign=""
  [ "${MERCURY_SUITE_ENV:-}" = "any" ] && return 0
  dir="$(cd "$(dirname "$runner")" && pwd)"
  for name in $(env | sed -n 's/^\(MERCURY_[A-Z0-9_]*\)=.*/\1/p' | sort -u); do
    case "$name" in
      MERCURY_CONFIG_DIR|MERCURY_HOME|MERCURY_CREDENTIAL_STORE|MERCURY_DAEMON_DIR|MERCURY_NODE|MERCURY_SUITE_ENV) continue ;;
      MERCURY_GATE_*|MERCURY_CI_*|MERCURY_SUITE_*|MERCURY_SLICE_*|MERCURY_VSHOT_*) continue ;;
      MERCURY_CUSTOM_OAUTH_URL|MERCURY_UPDATE_API_BASE_URL|MERCURY_*_BASE) continue ;;
    esac
    if [ -n "$(grep -rlF -- "$name" "$dir" 2>/dev/null | head -1)" ]; then continue; fi
    value="$(printenv "$name")"
    foreign="$foreign $name=$value"
  done
  [ -z "$foreign" ] && return 0
  echo "suite $(basename "$dir"): refusing to start — foreign MERCURY_* in the environment:$foreign" >&2
  echo "  a proof never reads the machine: unset them (a Mercury session's tool shell scrubs its own stamps by default), or MERCURY_SUITE_ENV=any for a deliberate run" >&2
  exit 78
}
