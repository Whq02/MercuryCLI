#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/tensorfold/prove-tensorfold-drive.ts scripts/tensorfold/fixtures/**
# gate-watch: src/services/tensorfold/** src/commands/tensorfold/** src/commands.ts src/services/localSetup/setupProve.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/tensorfold-drives"
dist="${MERCURY_DIST:-dist/mercury.mjs}"
if [ ! -f "$dist" ]; then
  printf 'tensorfold-drives: bundle absent at %s; run bun run build.ts before the suite\n' "$dist"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/tensorfold/$name"
  if [ ! -e "$f" ]; then
    echo "❌ tensorfold-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── tensorfold-drives: $name"
  __t=$SECONDS; __rc=0
  "$bun" "$f" --dist "$dist" || { __rc=$?; failed=1; }
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
