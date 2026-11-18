#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/ApolloReviewTool/**
# gate-watch: src/utils/permissions/PermissionUpdate*
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/cli/headless/*
# gate-watch: src/screens/chat/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# apollo — station · pack · letters · review handoff · the one door · faces"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-apollo-carousel.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-apollo-carousel.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-apollo-mode.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-apollo-mode.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-apollo-exit.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-apollo-exit.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-apollo-review-model-schema.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-apollo-review-model-schema.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/render-apollo-faces.ts" || { __rc=$?; fail=1; }; prover_mark "$here/render-apollo-faces.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "apollo suite: RED"
  exit 1
fi
echo "apollo suite: green"
