#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/** mercury-skills/** src/skills/bundled/** src/skills/bundledSkills*
# gate-watch: src/utils/permissions/filesystem* scripts/skills/**
# The bundled-skills suite: the skills compiled from mercury-skills/ register,
# carry real content, never double-register, and extract in isolation. Globs
# prove-*.ts so new legs auto-join; the suite auto-joins the green gate.
# gen-bundled.ts is the codegen tool (not a proof) and is not run here.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
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
