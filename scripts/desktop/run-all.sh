#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/desktop/** scripts/vendor/build-desktop.ts native/desktop/** build.ts scripts/release/package.mjs
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
for f in scripts/desktop/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ DESKTOP SUITE GREEN"; else echo "❌ DESKTOP SUITE RED"; fi
exit "$fail"
