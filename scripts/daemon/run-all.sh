#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/utils/worktree.ts
# gate-watch: src/services/resources/adapters/health*
# gate-watch: src/tools/MonitorTool/** src/tools/ScheduleCronTool/**
# gate-watch: src/cli/run* src/services/saturn/** src/tools/ScheduleWakeupTool/**
# gate-watch: docs/SESSIONS.md scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: src/services/privateChannel/installLayout.ts
# gate-watch: src/rows/*
# gate-watch: src/components/Spinner/liveCounterWords.ts src/components/Spinner/spinnerHud.ts src/components/Spinner/SpinnerAnimationRow.tsx
# gate-watch: src/tasks/LocalAgentTask/* src/input-core/*
# gate-watch: src/services/providers/openaicompat/compatAdapter.ts
# gate-watch: src/commands/restart/* src/tasks/LocalShellTask/*
# gate-watch: src/services/providers/local/** src/services/providers/routeLaw.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Mercury daemon — proof harness"
echo "############################################################"
claimed=$(cat scripts/daemon-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ daemon: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAEMON PROOFS PASS"; else echo "# ❌ SOME DAEMON PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
