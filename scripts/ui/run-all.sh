#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/**
# gate-env: MERCURY_UI_BILLED MERCURY_LOGINS_COPY_KEEP MERCURY_LOGINS_COPY_FRAMES MERCURY_RENDER_CWD MERCURY_CARD_FIT_CAPTURE_DIR MERCURY_MODE_BAND_DRIVE_CAPTURE_DIR
# gate-watch: scripts/providers/anthropicAccountsFixture.ts
# gate-watch: design-system/readme.md docs/ENGINES.md mercury-skills/provider-apis/SKILL.md
# gate-watch: scripts/cockpit-interaction/prove-action-graph.ts
# gate-watch: scripts/critters/prove-critter-mini-drive.ts
# gate-watch: scripts/engine-durability/harness.ts
# gate-watch: scripts/ink-runtime/prove-viewport-clamp.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/search/lib/bundle-for-node.ts
# gate-watch: scripts/host/runpodFixture.mjs scripts/providers/lib/llmhostFixture.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui"
fail=0
drive_members ui 'scripts/ui/$name' "$here/members.txt" '' run || fail=1
if [ "${UI_RENDER:-0}" = "1" ]; then
  for f in scripts/ui/render-*.ts scripts/ui/render-*.tsx; do
    [ -e "$f" ] || continue
    echo "▶ $f"
    __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
    echo
  done
fi
if [ "$fail" -eq 0 ]; then echo "✅ UI SUITE GREEN"; else echo "❌ UI SUITE RED"; fi
exit "$fail"
