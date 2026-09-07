#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/api/prove-prefix-frozen-drive.ts scripts/lib/fixtureApi.ts
# gate-watch: src/services/providers/anthropic/** src/services/providers/toolEconomy.ts src/constants/prompts.ts src/context.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/api-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ api-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/api/$name"
  if [ ! -e "$f" ]; then
    echo "❌ api-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── api-drives: $name"
  __t=$SECONDS
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || failed=1 ;;
    (*.sh) bash "$f" || failed=1 ;;
    (*) "$bun" "$f" || failed=1 ;;
  esac
  prover_mark "$f" "$__t"
done < "$here/members.txt"

exit "$failed"
