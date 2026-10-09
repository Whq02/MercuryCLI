#!/usr/bin/env bash
# gate-class: pty
# gate-watch: Dockerfile .dockerignore build.ts package.json bun.lock bunfig.toml vendor/*.lock.json
# gate-watch: scripts/distribution/prove-headless-image-drive.ts scripts/lib/fixtureApi.ts
# gate-watch: scripts/vendor/** src/services/privateChannel/vendoredRuntime.ts src/services/privateChannel/releaseTarget.ts
# gate-watch: src/cli/run.ts src/utils/permissions/rootNotice.ts src/entrypoints/cli.tsx src/main.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/distribution-drives"

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/distribution/$name"
  if [ ! -e "$f" ]; then
    echo "❌ distribution-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── distribution-drives: $name"
  __t=$SECONDS; __rc=0
  "$bun" "$f" || { __rc=$?; failed=1; }
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
