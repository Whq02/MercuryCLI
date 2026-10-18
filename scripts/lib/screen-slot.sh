#!/usr/bin/env bash

SCREEN_SLOTS_DIR="${SCREEN_SLOTS_DIR:-/private/tmp/mw/screen-slots}"
SCREEN_SLOT=""
SCREEN_SLOT_DIR=""

screen_slot_proc() {
  ps -p "$1" -o lstart=,comm= 2>/dev/null
}

screen_slot_write() {
  local dir="$1" pid="$2" proc
  printf '%s\n' "$pid" >"$dir/pid"
  proc="$(screen_slot_proc "$pid")"
  [ -n "$proc" ] && printf '%s\n' "$proc" >"$dir/proc"
}

screen_slot_alive() {
  local pid="$1" dir="${2:-}" recorded current
  if ! (ps -p "$pid" -o pid= >/dev/null 2>&1 || [ -d "/proc/$pid" ]); then
    return 1
  fi
  if [ -n "$dir" ] && [ -f "$dir/proc" ]; then
    recorded="$(cat "$dir/proc" 2>/dev/null)"
    current="$(screen_slot_proc "$pid")"
    [ -n "$recorded" ] && [ -n "$current" ] && [ "$recorded" != "$current" ] && return 1
  fi
  return 0
}

screen_slot_claim() {
  local n="$1" pid="$2" dir="$SCREEN_SLOTS_DIR/slot-$n" holder
  if mkdir "$dir" 2>/dev/null; then
    screen_slot_write "$dir" "$pid"
    return 0
  fi
  [ -f "$dir/pid" ] || return 1
  holder="$(cat "$dir/pid" 2>/dev/null)"
  [[ "$holder" =~ ^[0-9]+$ ]] || return 1
  screen_slot_alive "$holder" "$dir" && return 1
  rm -f "$dir/pid" "$dir/proc" && rmdir "$dir" 2>/dev/null || return 1
  mkdir "$dir" 2>/dev/null || return 1
  screen_slot_write "$dir" "$pid"
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
  rm -f "$SCREEN_SLOT_DIR/pid" "$SCREEN_SLOT_DIR/proc"
  rmdir "$SCREEN_SLOT_DIR" 2>/dev/null
  SCREEN_SLOT=""
  SCREEN_SLOT_DIR=""
}
