#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/tools/ComputerTool/** src/services/desktop/** src/components/permissions/ComputerPermissionRequest/** src/components/PromptInput/PromptInputFooterLeftSide* scripts/computer/prove-computer-*-drive.ts build.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/computer-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ computer-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/computer/$name"
  if [ ! -e "$f" ]; then
    echo "❌ computer-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── computer-drives: $name"
  __t=$SECONDS; __rc=0
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || { __rc=$?; failed=1; } ;;
    (*.sh) bash "$f" || { __rc=$?; failed=1; } ;;
    (*) "$bun" "$f" || { __rc=$?; failed=1; } ;;
  esac
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
