#!/usr/bin/env bash
# gate-class: pure
# gate-watch: package.json scripts/identity/prove-no-lineage-vocabulary.ts scripts/identity/prove-dist-invariants.sh
# gate-watch: docs/** *.md **/*.md .github/**
# ============================================================================
#  scripts/origin/run-all.sh — the public-cut ratchet.
#
#  One prover: the tree that ships is the public cut and stays it — no cut
#  path is tracked again, no filed packet or sealed receipt survives, the
#  vocabulary ratchet carries no allow row for a path that left, the package
#  origin names no private repository, and no hand-written text spells an
#  operator's disk path. Every check reads the tracked tree: the suite runs
#  on the slice rung for its declared inputs (the doc and workflow estates
#  are impact-ignored elsewhere, but the disk-path law reads them too, so
#  they are watched here) and on every full pool. A red is residue — fix the
#  tree, never the pin. Auto-joins scripts/run-all-suites.sh via the
#  scripts/*/run-all.sh glob.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# origin — the public-cut ratchet"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-public-cut.ts" || fail=1; prover_mark "$here/prove-public-cut.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ORIGIN SUITE PASS"; else echo "# ❌ ORIGIN SUITE RED"; fi
echo "############################################################"
exit "$fail"
