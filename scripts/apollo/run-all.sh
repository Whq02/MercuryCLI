#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/apolloMode* src/tools/ApolloReviewTool/**
# gate-watch: src/tools/AskUserQuestionTool/apolloLetters* src/types/permissions*
# gate-watch: src/utils/permissions/getNextPermissionMode* src/utils/permissions/PermissionMode*
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/components/permissions/ApolloReviewPermissionRequest/** src/utils/settings/types*
# apollo — the pre-flight interview station proof suite. Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# apollo — station · pack · letters · review handoff · faces"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-apollo-mode.ts" || fail=1; prover_mark "$here/prove-apollo-mode.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/render-apollo-faces.ts" || fail=1; prover_mark "$here/render-apollo-faces.ts" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "apollo suite: RED"
  exit 1
fi
echo "apollo suite: green"
