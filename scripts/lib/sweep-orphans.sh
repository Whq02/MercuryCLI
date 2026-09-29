#!/usr/bin/env bash
set -u
. "$(dirname "$0")/process-ledger.sh"

dry=0
for arg in "$@"; do
  case "$arg" in
    (--dry-run) dry=1 ;;
    (*) echo "sweep-orphans: unknown argument '$arg' (usage: sweep-orphans.sh [--dry-run])" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in (MINGW* | MSYS* | CYGWIN*) echo "orphan sweep: POSIX process semantics only; nothing read"; exit 0 ;; esac

me=$$
uid=$(id -u)
only="${MERCURY_SWEEP_ONLY:-}"
only_pids=" ${MERCURY_SWEEP_ONLY_PIDS:-} "
scratch_roots="${MERCURY_SWEEP_SCRATCH_ROOTS:-}"
for root in "${TMPDIR:-}" "${RUNNER_TEMP:-}" /private/tmp /tmp /var/folders /private/var/folders; do
  [ -n "$root" ] && scratch_roots="$scratch_roots:${root%/}"
done

master_minors=""
if [ "$(uname -s)" = Darwin ]; then
  master_minors=$(lsof -n /dev/ptmx 2>/dev/null | awk 'NR>1 && $5=="CHR" {print $6}' | sort -u | tr '\n' ' ')
  master_minors=" $master_minors "
fi

terminal_gone() {
  local slave minor
  [ "$(uname -s)" = Darwin ] || return 1
  slave=$(lsof -a -n -p "$1" -d 0,1,2 2>/dev/null | awk 'NR>1 && $5=="CHR" && $6 ~ /^16,/ {print $6; exit}')
  [ -n "$slave" ] || return 1
  minor=${slave#16,}
  case "$master_minors" in (*" 15,$minor "*) return 1 ;; esac
  return 0
}

cwd_of() {
  if [ -r "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
    return
  fi
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

under_scratch() {
  local path=$1 root
  local IFS=':'
  for root in $scratch_roots; do
    [ -n "$root" ] || continue
    case "$path" in ("$root"/*) return 0 ;; esac
  done
  return 1
}

is_ancestor_of_me() {
  local p=$me
  while [ "$p" -gt 1 ] 2>/dev/null; do
    [ "$p" = "$1" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$p" ] || return 1
  done
  return 1
}

ledger_runner_of() {
  local dir entry pid runner started rest
  for dir in "$(process_ledger_dir)" "${MERCURY_SWEEP_LEDGER_DIRS:-}"; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    for entry in "$dir"/"$1".*.entry; do
      [ -f "$entry" ] || continue
      IFS=$'\t' read -r pid runner started rest <"$entry" || continue
      [ "$pid" = "$1" ] || continue
      [ -z "$started" ] || [ "$started" = "$(process_started_at "$1")" ] || continue
      printf '%s' "$runner"
      return 0
    done
  done
  return 1
}

read_count=0
ended=0
kept=0
while IFS= read -r line; do
  set -- $line
  pid=$1; ppid=$2; puid=$3; stat=$4
  shift 4
  command="$*"
  case "$command" in
    (mercury | mercury\ * | *mercury.mjs* | *mercury-daemon*) ;;
    (*) continue ;;
  esac
  case "$command" in (*sweep-orphans.sh*) continue ;; esac
  if [ -n "$only" ]; then case "$command" in (*"$only"*) ;; (*) continue ;; esac; fi
  if [ "$only_pids" != "  " ]; then case "$only_pids" in (*" $pid "*) ;; (*) continue ;; esac; fi
  [ "$puid" = "$uid" ] || continue
  [ "$pid" -gt 1 ] || continue
  [ "$pid" = "$me" ] && continue
  is_ancestor_of_me "$pid" && continue
  case "$stat" in (Z*) continue ;; esac
  read_count=$((read_count + 1))
  reason=""
  why_kept=""
  if [ "$ppid" = 1 ]; then
    cwd=$(cwd_of "$pid")
    if [ -z "$cwd" ]; then
      why_kept="its working folder could not be read"
    elif [ ! -d "$cwd" ] && under_scratch "$cwd"; then
      reason="its runner is gone and its scratch folder $cwd is deleted"
    elif [ ! -d "$cwd" ]; then
      why_kept="its folder $cwd is deleted but is not a scratch folder"
    else
      why_kept="its folder $cwd is present"
    fi
    if [ -z "$reason" ] && terminal_gone "$pid"; then
      reason="its runner is gone and nobody holds the other side of its terminal"
    fi
  fi
  if [ -z "$reason" ]; then
    runner=$(ledger_runner_of "$pid" || true)
    if [ -n "$runner" ] && ! process_alive "$runner"; then
      reason="the process ledger names runner $runner, which is gone"
    fi
  fi
  if [ -z "$reason" ]; then
    if [ "$ppid" = 1 ]; then
      kept=$((kept + 1))
      echo "orphan sweep: kept $pid ($command) — parent gone but $why_kept, its terminal is held, and no ledger names a dead runner"
    fi
    continue
  fi
  if [ "$dry" = 1 ]; then
    echo "orphan sweep: would end $pid ($command) — $reason"
    continue
  fi
  process_end_tree "$pid"
  sleep 0.3
  if process_alive "$pid"; then
    echo "orphan sweep: signalled $pid ($command) — $reason; still present in state $(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ') (the kill lands when its kernel wait ends)"
  else
    echo "orphan sweep: ended $pid ($command) — $reason"
  fi
  ended=$((ended + 1))
done < <(ps -axo pid=,ppid=,uid=,stat=,command= 2>/dev/null)

echo "orphan sweep: $ended ended, $kept left alone, $read_count mercury processes read${only:+ (only those naming $only)}$([ "$only_pids" != "  " ] && printf ' (only pids%s)' "$only_pids")"
exit 0
