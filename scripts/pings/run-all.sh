#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/attention/**
# gate-watch: scripts/lib/fixtureApi.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: src/components/HelpV2/commandDomains.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/services/crew/obligations.ts src/services/crew/obligationsBridge.ts
# gate-watch: src/utils/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# pings — one ping when a chat finishes its turn while you are away"
echo "############################################################"

claimed=$(cd "$repo" && cat scripts/pings-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for journey in "$here"/journey-*.ts; do
  [ -e "$journey" ] || continue
  printf '%s\n' "$claimed" | grep -qx "$(basename "$journey")" && continue
  echo
  echo "── $(basename "$journey") (machine-gated) ──"
  __t=$SECONDS; __rc=0
  (cd "$repo" && "$bun" run "$journey")
  got=$?; __rc=$got
  prover_mark "$journey" "$__t" "$__rc"
  if [ "$got" = "3" ]; then
    echo "⏭  $(basename "$journey") SKIP — machine gate honoured"
  elif [ "$got" != "0" ]; then
    echo "❌ $(basename "$journey") exited $got (0 = pass, 3 = machine-gate SKIP)"
    fail=1
  fi
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ pings PASS"; else echo "# ❌ pings FAILED"; fi
echo "############################################################"
exit "$fail"
