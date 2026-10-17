#!/usr/bin/env bash

SCREEN_SLOTS_DIR="${SCREEN_SLOTS_DIR:-/private/tmp/mw/screen-slots}"
SCREEN_SLOT=""
SCREEN_SLOT_DIR=""

screen_slot_alive() {
  local pid="$1"
  ps -p "$pid" -o pid= >/dev/null 2>&1 || [ -d "/proc/$pid" ]
}

screen_slot_claim() {
  local n="$1" pid="$2" dir="$SCREEN_SLOTS_DIR/slot-$n" holder
  if mkdir "$dir" 2>/dev/null; then
    printf '%s\n' "$pid" >"$dir/pid"
    return 0
  fi
  [ -f "$dir/pid" ] || return 1
  holder="$(cat "$dir/pid" 2>/dev/null)"
  [[ "$holder" =~ ^[0-9]+$ ]] || return 1
  screen_slot_alive "$holder" && return 1
  rm -f "$dir/pid" && rmdir "$dir" 2>/dev/null || return 1
  mkdir "$dir" 2>/dev/null || return 1
  printf '%s\n' "$pid" >"$dir/pid"
  echo "screen slot $n: the claim of pid $holder is gone — taken"
  return 0
}

screen_slot_take() {
  local count="${1:-8}" pid="${2:-$$}" n polls=0
  mkdir -p "$SCREEN_SLOTS_DIR"
  while :; do
    n=1
    while [ "$n" -le "$count" ]; do
      if screen_slot_claim "$n" "$pid"; then
        SCREEN_SLOT="$n"
        SCREEN_SLOT_DIR="$SCREEN_SLOTS_DIR/slot-$n"
        return 0
      fi
      n=$((n + 1))
    done
    polls=$((polls + 1))
    if [ "${SCREEN_SLOT_POLL_LIMIT:-0}" -gt 0 ] && [ "$polls" -ge "${SCREEN_SLOT_POLL_LIMIT}" ]; then
      echo "screen slot: none of $count free after $polls wait(s)" >&2
      return 1
    fi
    sleep "${SCREEN_SLOT_POLL_SECONDS:-15}"
  done
}

screen_slot_free() {
  [ -n "$SCREEN_SLOT_DIR" ] || return 0
  rm -f "$SCREEN_SLOT_DIR/pid"
  rmdir "$SCREEN_SLOT_DIR" 2>/dev/null
  SCREEN_SLOT=""
  SCREEN_SLOT_DIR=""
}
