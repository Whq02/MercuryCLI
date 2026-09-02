#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/cli/print* src/utils/process.ts src/utils/crashReport* src/ink/components/ErrorOverview* src/ink/components/App.tsx src/components/SentryErrorBoundary* src/main.tsx src/ink/launcherAltHold.ts src/entrypoints/cli.tsx scripts/ops/launcher-mercury.sh
# scripts/terminal-boundary/run-all.sh — proof suite (presentation boundary ·
# byte-clean protocols · crash surfaces).
# Globs prove-*.ts; auto-joins the pooled gate. Requires the
# prebuilt dist for the artifact legs.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "############################################################"
echo "# terminal-boundary — presentation boundary + machine-output contracts"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ terminal-boundary suite GREEN"; exit 0; else
  echo "❌ terminal-boundary suite RED"; exit 1; fi
