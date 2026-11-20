#!/usr/bin/env bash
drive_member_jobs() {
  local jobs="${MERCURY_SUITE_JOBS:-1}"
  case "$jobs" in ('' | *[!0-9]*) jobs=1 ;; esac
  [ "$jobs" -lt 1 ] && jobs=1
  printf '%s' "$jobs"
}

members_cat() {
  local list
  for list in "$@"; do
    [ -f "$list" ] || continue
    grep -v -e '^#' -e '^$' "$list" || true
  done
  return 0
}

drive_member_run() {
  local suite="$1" f="$2" name="$3" skip="${4:-}" rest="${5:-}" form="${6:-}" bun="${BUN:-$HOME/.bun/bin/bun}" t0=$SECONDS rc=0
  local root="$PWD" i var
  local -a words=()
  read -r -a words <<<"$rest"
  for i in "${!words[@]}"; do
    [[ "${words[$i]}" =~ ^(.*)\$([A-Za-z_][A-Za-z0-9_]*)(.*)$ ]] || continue
    var="${BASH_REMATCH[2]}"
    words[$i]="${BASH_REMATCH[1]}${!var-}${BASH_REMATCH[3]}"
  done
  printf '── %s: %s\n' "$suite" "$name${rest:+ $rest}"
  case "$name" in
    (*.py) /usr/bin/python3 "$f" ${words[@]+"${words[@]}"} || rc=$? ;;
    (*.sh) bash "$f" ${words[@]+"${words[@]}"} || rc=$? ;;
    (*) "$bun" ${form:+"$form"} "$f" ${words[@]+"${words[@]}"} || rc=$? ;;
  esac
  local p="$f"
  case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac
  printf '── %s  %ss rc=%s\n' "$p${rest:+ $rest}" "$(( SECONDS - t0 ))" "$rc"
  if [ -n "$skip" ] && [ "$rc" = "$skip" ]; then
    printf '⏭  %s SKIP — machine gate honoured (exit %s is the skip code of %s)\n' "$name" "$rc" "$suite"
    return 0
  fi
  return "$rc"
}

drive_members() {
  local suite="$1" template="$2" members="$3" skip="${4:-}" form="${5:-}" jobs
  jobs=$(drive_member_jobs)
  local failed=0 name rest f only="${MERCURY_SUITE_MEMBER:-}"
  local -a names=() files=() rests=()
  while read -r name rest; do
    case "$name" in (''|'#'*) continue ;; esac
    [ -n "$only" ] && [ "$name" != "$only" ] && continue
    case "${name%%/*}" in (scripts) f="$name" ;; (*) f="${template//\$name/$name}" ;; esac
    if [ ! -e "$f" ]; then
      printf '❌ %s: member %s has no file at %s — a stale member row is a red, never a silent skip\n' "$suite" "$name" "$f"
      failed=1
      continue
    fi
    names+=("$name"); files+=("$f"); rests+=("$rest")
  done < "$members"
  if [ -n "$only" ]; then
    if [ "${#names[@]}" -eq 0 ] && [ "$failed" -eq 0 ]; then
      printf '❌ %s: MERCURY_SUITE_MEMBER names %s, which is no member in %s — one member runs alone only by the name its list holds\n' "$suite" "$only" "$members"
      return 1
    fi
    printf '── %s: one member alone by MERCURY_SUITE_MEMBER (%s); the rest of the suite is not run\n' "$suite" "$only"
  fi
  if [ "$jobs" -le 1 ] || [ "${#names[@]}" -le 1 ]; then
    local i
    for i in "${!names[@]}"; do
      drive_member_run "$suite" "${files[$i]}" "${names[$i]}" "$skip" "${rests[$i]}" "$form" || failed=1
    done
    return "$failed"
  fi
  local out
  out=$(mktemp -d "${TMPDIR:-/tmp}/drive-members-${suite}.XXXXXX") || return 1
  printf '── %s: %s members, %s at a time (MERCURY_SUITE_JOBS)\n' "$suite" "${#names[@]}" "$jobs"
  local -a pids=() idxs=()
  local i j running=0 next=0 total=${#names[@]}
  collect() {
    cat "$out/$1.out"
    [ "$(cat "$out/$1.rc" 2>/dev/null || echo 1)" = 0 ] || failed=1
  }
  while [ "$next" -lt "$total" ] || [ "$running" -gt 0 ]; do
    while [ "$next" -lt "$total" ] && [ "$running" -lt "$jobs" ]; do
      i=$next
      ( drive_member_run "$suite" "${files[$i]}" "${names[$i]}" "$skip" "${rests[$i]}" "$form" > "$out/$i.out" 2>&1; echo "$?" > "$out/$i.rc" ) &
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
