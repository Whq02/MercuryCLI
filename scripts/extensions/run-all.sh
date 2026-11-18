#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/extensions/** src/skills/loadSkillsDir* src/utils/hooks/**
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: scripts/ui/renderScenarios.ts scripts/ui/vshot.py
# gate-watch: src/commands/extensions/**
# gate-watch: src/components/extensions/**
# gate-watch: src/keybindings/defaultBindings.ts src/keybindings/schema.ts src/services/mcp/*
# gate-watch: src/utils/sessionStoragePortable.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# extensions — proof suite"
echo "############################################################"
shopt -s nullglob
claimed=$(cat "$here"/../extensions-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EXTENSIONS PROOFS PASS"; else echo "# ❌ SOME EXTENSIONS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
