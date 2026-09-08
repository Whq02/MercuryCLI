#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/instructions/** src/constants/prompts.ts src/prompt/** CLAUDE.md AGENTS.md
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-root-guide-composition.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-root-guide-composition.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-instruction-excludes.ts || { __rc=$?; fail=1; }; prover_mark scripts/self-hosting/prove-instruction-excludes.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-project-local-owner.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-project-local-owner.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-instruction-capture.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-instruction-capture.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-capture-doctrine.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-capture-doctrine.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-effective-size.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-effective-size.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-static-section-names.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-static-section-names.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/self-hosting/prove-nested-external-imports.ts || { __rc=$?; fail=1; }; prover_mark "scripts/self-hosting/prove-nested-external-imports.ts" "$__t" "$__rc"
BOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/native-bom-home.XXXXXX")"
for model in claude-fable-5 claude-opus-5 claude-sonnet-5; do
  MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model "$model" --mode interactive >/dev/null 2>&1 || { echo "BOM smoke FAILED for $model"; fail=1; }
done
MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model claude-fable-5 --mode subagent >/dev/null 2>&1 || { echo "BOM smoke FAILED for subagent mode"; fail=1; }
rm -rf "$BOM_HOME"
exit "$fail"
