#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/AskUserQuestionTool/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/messages/attachmentText.ts
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: src/components/CustomSelect/* src/components/mercury-ui/glyphs.ts
# gate-watch: src/services/acp/**
# gate-watch: src/substrate/flagRegistry.ts src/utils/*
# gate-watch: src/utils/messages/rejectionText.ts
# gate-watch: src/rows/* src/runner/wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# INTERVIEW — the evidence-first design-conversation lane"
echo "############################################################"

claimed=$(cd "$here/../.." && cat scripts/interview-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$proof") || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done

for repro in "$here"/repro-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$repro")" && continue
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; __rc=0; (cd "$repo" && "$bun" run "$repro") || { __rc=$?; fail=1; }; prover_mark "$repro" "$__t" "$__rc"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ INTERVIEW PASS"; else echo "# ❌ INTERVIEW FAILED"; fi
echo "############################################################"
exit "$fail"
