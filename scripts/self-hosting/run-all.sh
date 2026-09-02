#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/instructions/** src/constants/prompts.ts src/prompt/** CLAUDE.md AGENTS.md
# The native-instruction suite: how the engine composes a repository's root
# guide, plus the request-context bill-of-materials smoke for each model.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"
fail=0
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-root-guide-composition.ts || fail=1; prover_mark scripts/self-hosting/prove-root-guide-composition.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-instruction-excludes.ts || fail=1; prover_mark scripts/self-hosting/prove-instruction-excludes.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-project-local-owner.ts || fail=1; prover_mark "scripts/self-hosting/prove-project-local-owner.ts" "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-instruction-capture.ts || fail=1; prover_mark "scripts/self-hosting/prove-instruction-capture.ts" "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-capture-doctrine.ts || fail=1; prover_mark "scripts/self-hosting/prove-capture-doctrine.ts" "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-effective-size.ts || fail=1; prover_mark "scripts/self-hosting/prove-effective-size.ts" "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-static-section-names.ts || fail=1; prover_mark "scripts/self-hosting/prove-static-section-names.ts" "$__t"
__t=$SECONDS; "$BUN" run scripts/self-hosting/prove-nested-external-imports.ts || fail=1; prover_mark "scripts/self-hosting/prove-nested-external-imports.ts" "$__t"
# BOM smoke: the bill-of-materials composes and reports for each gen-5 model.
# Hermetic home: the smoke must not read the operator's config.
BOM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/native-bom-home.XXXXXX")"
for model in claude-fable-5 claude-opus-5 claude-sonnet-5; do
  MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model "$model" --mode interactive >/dev/null 2>&1 || { echo "BOM smoke FAILED for $model"; fail=1; }
done
MERCURY_CONFIG_DIR="$BOM_HOME" "$BUN" run scripts/self-hosting/bom.ts --model claude-fable-5 --mode subagent >/dev/null 2>&1 || { echo "BOM smoke FAILED for subagent mode"; fail=1; }
rm -rf "$BOM_HOME"
exit "$fail"
