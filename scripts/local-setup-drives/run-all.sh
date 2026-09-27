#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/local-setup/prove-local-setup-drive.ts scripts/local-setup/fixtures/**
# gate-watch: src/services/localSetup/** src/commands/localsetup/** src/components/LocalSetupDialog.tsx
# gate-watch: src/services/localServer/** src/services/providers/local/** scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/local-setup-drives"
dist="${MERCURY_DIST:-dist/mercury.mjs}"
if [ ! -f "$dist" ]; then
  echo "── local-setup-drives: no bundle at $dist — building it (the drive proves the BUILT product)"
  "$bun" run build.ts >/dev/null || { echo "❌ local-setup-drives: the build failed"; exit 1; }
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/local-setup/$name"
  if [ ! -e "$f" ]; then
    echo "❌ local-setup-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── local-setup-drives: $name"
  __t=$SECONDS; __rc=0
  "$bun" "$f" --dist "$dist" || { __rc=$?; failed=1; }
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
