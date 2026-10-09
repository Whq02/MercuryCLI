#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/hermetic.ts scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/providers/lib/xai-usage-fixture.ts scripts/providers/lib/xai-auth-fixture.ts scripts/ui/face-logins-stills.ts
# gate-watch: scripts/providers/lib/mistral-fixture.ts src/services/providers/mistral/**
# gate-watch: scripts/providers/lib/zen-fixture.ts src/services/providers/zen/**
# gate-watch: src/components/mercury-ui/parity/AccountView* src/services/api/errors* src/utils/** src/services/wallet/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
for f in scripts/accounts/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ ACCOUNTS SUITE GREEN"; else echo "❌ ACCOUNTS SUITE RED"; fi
exit "$fail"
