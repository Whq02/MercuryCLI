#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/mneme/**
# gate-watch: src/services/eval/evalBridge.ts src/services/instructions/sourceText.ts
# gate-watch: src/query/stopHooks.ts
# gate-watch: src/components/mercury-ui/useFlatList.ts
# gate-watch: scripts/lib/spawnCapture.ts
# gate-watch: scripts/ui/**
# gate-watch: src/services/jev/jevClient.ts
# gate-watch: src/utils/permissions/decision/engine.ts src/utils/permissions/permissions.ts src/utils/permissions/PermissionMode.ts src/cli/run.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: src/services/samples/**
# gate-watch: native/embed/**
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Memory — proof harness"
echo "############################################################"
claimed=$(cd "$here/../.." && members_cat scripts/memory-*/members.txt)
for f in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$f")" && continue
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MEMORY PROOFS PASS"; else echo "# ❌ SOME MEMORY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
