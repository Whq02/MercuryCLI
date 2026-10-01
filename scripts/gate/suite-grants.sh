#!/usr/bin/env bash

suite_grant() {
  local suite="${1:?suite name required}" file="${2:?grant file required}"
  [ -r "$file" ] || return 0
  awk -F '\t' -v suite="$suite" '$1 == suite && $2 ~ /^[0-9]+$/ && $2 + 0 > 0 { print $2 + 0; exit }' "$file"
}
