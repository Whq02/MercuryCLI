#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/commands.ts src/commands/** src/components/HelpV2/** src/components/mercury-ui/** src/types/command* src/main* src/utils/processUserInput/** README.md
# gate-watch: src/components/Feedback.tsx src/services/repoHost/** src/services/privateChannel/ghRelease.ts .github/ISSUE_TEMPLATE/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
__t=$SECONDS; "$bun" run "$here/prove-effective-catalogue.ts" || fail=1; prover_mark "$here/prove-effective-catalogue.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-beta-journey-matrix.ts" || fail=1; prover_mark "$here/prove-beta-journey-matrix.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-no-literal-disabled-branches.ts" || fail=1; prover_mark "$here/prove-no-literal-disabled-branches.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-command-privacy.ts" || fail=1; prover_mark "$here/prove-command-privacy.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-surface-truth.ts" || fail=1; prover_mark "$here/prove-surface-truth.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-feedback-issue-road.ts" || fail=1; prover_mark "$here/prove-feedback-issue-road.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-readme-roster.ts" || fail=1; prover_mark "$here/prove-readme-roster.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-unavailable-honesty.ts" || fail=1; prover_mark "$here/prove-unavailable-honesty.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-builtins-unshadowable.ts" || fail=1; prover_mark "$here/prove-builtins-unshadowable.ts" "$__t"
exit $fail
