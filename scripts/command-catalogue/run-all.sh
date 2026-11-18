#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/HelpV2/** src/components/mercury-ui/** src/main* src/utils/processUserInput/**
# gate-watch: src/types/message.ts
# gate-watch: src/utils/secureStorage/**
# gate-watch: src/services/repoHost/** src/services/privateChannel/ghRelease.ts .github/ISSUE_TEMPLATE/**
# gate-watch: package.json
# gate-watch: src/rows/* src/runner/wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-effective-catalogue.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-effective-catalogue.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-no-literal-disabled-branches.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-no-literal-disabled-branches.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-command-privacy.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-command-privacy.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-surface-truth.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-surface-truth.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-feedback-encoding.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-feedback-encoding.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-readme-roster.ts" "$@" || { __rc=$?; fail=1; }; prover_mark "$here/prove-readme-roster.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-unavailable-honesty.ts" "$@" || { __rc=$?; fail=1; }; prover_mark "$here/prove-unavailable-honesty.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-builtins-unshadowable.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-builtins-unshadowable.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-swarm-channel-completion.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-swarm-channel-completion.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-settings-popup-commands.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-settings-popup-commands.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-export-json.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-export-json.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-export-masking.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-export-masking.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-merged-verbs.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-merged-verbs.ts" "$__t" "$__rc"
exit $fail
