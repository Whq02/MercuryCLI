#!/usr/bin/env bash
drive_member_jobs() {
  local jobs="${MERCURY_DRIVE_JOBS:-1}"
  case "$jobs" in ('' | *[!0-9]*) jobs=1 ;; esac
  [ "$jobs" -lt 1 ] && jobs=1
  printf '%s' "$jobs"
}

drive_member_run() {
  local suite="$1" f="$2" name="$3" bun="${BUN:-$HOME/.bun/bin/bun}" t0=$SECONDS rc=0
  printf '── %s: %s\n' "$suite" "$name"
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || rc=$? ;;
    (*.sh) bash "$f" || rc=$? ;;
    (*) "$bun" "$f" || rc=$? ;;
  esac
  local p="$f"
  case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac
  printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - t0 ))" "$rc"
  return "$rc"
}

drive_members() {
  local suite="$1" template="$2" members="$3" jobs
  jobs=$(drive_member_jobs)
  local failed=0 name f
  local -a names=() files=()
  while IFS= read -r name; do
    case "$name" in (''|'#'*) continue ;; esac
    f="${template//\$name/$name}"
    if [ ! -e "$f" ]; then
      printf '❌ %s: member %s has no file at %s — a stale member row is a red, never a silent skip\n' "$suite" "$name" "$f"
      failed=1
      continue
    fi
    names+=("$name"); files+=("$f")
  done < "$members"
  if [ "$jobs" -le 1 ] || [ "${#names[@]}" -le 1 ]; then
    local i
    for i in "${!names[@]}"; do
      drive_member_run "$suite" "${files[$i]}" "${names[$i]}" || failed=1
    done
    return "$failed"
  fi
  local out
  out=$(mktemp -d "${TMPDIR:-/tmp}/drive-members-${suite}.XXXXXX") || return 1
  printf '── %s: %s members, %s at a time (MERCURY_DRIVE_JOBS)\n' "$suite" "${#names[@]}" "$jobs"
  local -a pids=() idxs=()
  local i j running=0 next=0 total=${#names[@]}
  collect() {
    cat "$out/$1.out"
    [ "$(cat "$out/$1.rc" 2>/dev/null || echo 1)" = 0 ] || failed=1
  }
  while [ "$next" -lt "$total" ] || [ "$running" -gt 0 ]; do
    while [ "$next" -lt "$total" ] && [ "$running" -lt "$jobs" ]; do
      i=$next
      ( drive_member_run "$suite" "${files[$i]}" "${names[$i]}" > "$out/$i.out" 2>&1; echo "$?" > "$out/$i.rc" ) &
      pids+=("$!"); idxs+=("$i"); running=$(( running + 1 )); next=$(( next + 1 ))
    done
    sleep 1
    local -a keep_pids=() keep_idxs=()
    for j in "${!pids[@]}"; do
      if kill -0 "${pids[$j]}" 2>/dev/null; then
        keep_pids+=("${pids[$j]}"); keep_idxs+=("${idxs[$j]}")
      else
        wait "${pids[$j]}" 2>/dev/null
        collect "${idxs[$j]}"
        running=$(( running - 1 ))
      fi
    done
    pids=(${keep_pids[@]+"${keep_pids[@]}"}); idxs=(${keep_idxs[@]+"${keep_idxs[@]}"})
  done
  rm -rf "$out"
  return "$failed"
}
