#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/search/** src/tools/WebSearchTool/**
# gate-watch: src/services/providers/openai/openaiWire* src/services/providers/openai/responsesBridge*
# gate-watch: src/tools/WebFetchTool/utils* src/utils/http*
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/scriptedTurn.ts src/Tool.ts
# gate-watch: src/services/concourse/coordinatorTools.ts src/services/providers/routeLaw.ts
# gate-watch: src/tools/GlobTool/GlobTool.ts src/tools/GrepTool/GrepTool.ts src/utils/*
# gate-watch: src/utils/model/model.ts src/utils/router/providerSecrets.ts src/utils/settings/settingsCache.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
