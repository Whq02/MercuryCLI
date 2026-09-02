#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/** mercury-skills/** src/skills/bundled/** src/skills/bundledSkills*
# gate-watch: src/utils/permissions/filesystem* scripts/skills/**
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/skills/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ SKILLS SUITE GREEN"; else echo "❌ SKILLS SUITE RED"; fi
exit "$fail"
