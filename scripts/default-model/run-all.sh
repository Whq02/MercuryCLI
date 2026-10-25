#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/model/computedDefault* src/utils/accounts/signInLedger* src/utils/accounts/signInRefusal* src/services/providers/zai/zaiCatalogue.ts
# gate-watch: scripts/lib/hermetic.ts src/bootstrap/state.ts src/commands/model/*
# gate-watch: src/services/providers/routeLaw.ts src/services/providers/zai/zaiLogin.ts src/utils/config.ts
# gate-watch: src/utils/envUtils.ts src/utils/model/* src/services/providers/providerSecrets.ts
# gate-watch: src/state/onChangeAppState.ts src/state/AppStateStore.ts
# gate-watch: src/services/providers/gemini/geminiCatalogue.ts
# gate-watch: src/services/providers/idSpaces.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in scripts/default-model/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ DEFAULT-MODEL SUITE GREEN"; else echo "❌ DEFAULT-MODEL SUITE RED"; fi
exit "$fail"
