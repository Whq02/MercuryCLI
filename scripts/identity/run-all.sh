#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/constants/product* src/prompt/mercuryContract*
# gate-watch: src/prompt/engineIdentity* package.json
# gate-watch: docs/** *.md **/*.md .github/**
# gate-watch: src/** scripts/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Identity suite"
echo "############################################################"

if [ ! -f "$root/dist/mercury.mjs" ]; then
  printf '%s\n' 'identity: dist/mercury.mjs absent; run bun run build.ts before the suite'
  exit 1
fi

echo "## bun proofs"
__t=$SECONDS; __rc=0; "$bun" run "$root/scripts/substrate/prove-health-self-recognition.ts" || { __rc=$?; fail=1; }; prover_mark "$root/scripts/substrate/prove-health-self-recognition.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$root/scripts/substrate/prove-no-telemetry-egress.ts" || { __rc=$?; fail=1; }; prover_mark "$root/scripts/substrate/prove-no-telemetry-egress.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crew-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crew-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-no-old-spelling-remains.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-no-old-spelling-remains.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-no-retired-theme-remains.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-no-retired-theme-remains.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-retired-keys-unknown.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-retired-keys-unknown.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-view-words-gone.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-view-words-gone.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crew-docs-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crew-docs-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-tree-hygiene.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-tree-hygiene.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-docs-altitude.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-docs-altitude.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-release-notes-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-release-notes-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-provider-neutral-vocabulary.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-provider-neutral-vocabulary.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-editor-prompt-file.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-editor-prompt-file.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-unknown-command-answer.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-unknown-command-answer.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-verb-help-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-verb-help-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-readme-headless-words.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-readme-headless-words.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-floor-delivery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-floor-delivery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-floor-under-pressure.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-floor-under-pressure.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-no-other-guide-reads.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-no-other-guide-reads.ts" "$__t" "$__rc"

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL IDENTITY CHECKS PASS"; else echo "# ❌ IDENTITY CHECKS FAILED"; fi
echo "############################################################"
exit "$fail"
