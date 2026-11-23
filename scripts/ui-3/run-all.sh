#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_RENDER_CWD
# gate-watch: scripts/ui/**
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui-3"

fail=0
drive_members ui-3 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

echo "▶ scripts/ui/prove-window-kept.ts --poison --sizes=80x21"
__t=$SECONDS; __rc=0
if "$BUN" run scripts/ui/prove-window-kept.ts --poison --sizes=80x21 >/dev/null 2>&1; then
  echo "❌ ui-3: prove-window-kept.ts --poison exited 0 — the negative control lost its teeth"
  __rc=1; fail=1
fi
prover_mark "scripts/ui/prove-window-kept.ts --poison" "$__t" "$__rc"
echo

if [ "$fail" -eq 0 ]; then echo "✅ UI-3 SUITE GREEN"; else echo "❌ UI-3 SUITE RED"; fi
exit "$fail"
