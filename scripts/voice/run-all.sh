#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/voice/** src/commands/speak/** src/commands/voice/** scripts/vendor/build-voice.ts native/voice/** build.ts
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
for f in scripts/voice/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ VOICE SUITE GREEN"; else echo "❌ VOICE SUITE RED"; fi
exit "$fail"
