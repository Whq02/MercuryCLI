#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/mercury-ui/toolCardGrammar* src/ink/**
# gate-watch: src/services/agentResults/normalize* src/services/changeTransaction/receipts*
# gate-watch: src/services/changeTransaction/snapshotAnchor* src/services/dap/dapClient*
# gate-watch: src/services/lsp/LSPServerInstance* src/services/primitives/**
# gate-watch: src/services/projectServices/executionProjection*
# gate-watch: src/services/projectServices/serviceManager*
# gate-watch: src/services/resources/adapters/service* src/services/resources/contracts*
# gate-watch: src/services/resources/registry* src/services/run/** src/services/workshop/**
# gate-watch: src/utils/task/executionProjection* src/utils/task/framework*
# gate-watch: src/utils/verification/verificationState*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/primitives-kernel-drives"
export UI_RENDER=1

if [ ! -f dist/mercury.mjs ]; then
  echo "❌ primitives-kernel-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi

failed=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/primitives-kernel/$name"
  if [ ! -e "$f" ]; then
    echo "❌ primitives-kernel-drives: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    failed=1
    continue
  fi
  echo "── primitives-kernel-drives: $name"
  __t=$SECONDS; __rc=0
  case "$name" in
    (*.py) /usr/bin/python3 "$f" || { __rc=$?; failed=1; } ;;
    (*.sh) bash "$f" || { __rc=$?; failed=1; } ;;
    (*) "$bun" "$f" || { __rc=$?; failed=1; } ;;
  esac
  prover_mark "$f" "$__t" "$__rc"
done < "$here/members.txt"

exit "$failed"
