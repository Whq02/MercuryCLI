#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/structure/** src/tools/StructureTool/** build.ts
# gate-watch: vendor/grammars.lock.json scripts/vendor/fetch-grammars.ts
# gate-watch: src/services/lsp/webSidecar/** src/services/lsp/sidecarFraming.ts src/services/lsp/serverCatalogue.ts
# gate-watch: src/services/browser/** src/tools/BrowserTool/** src/commands/browser/**
# gate-watch: src/services/visual/** src/services/lsp/builtinServers.ts src/services/lsp/pyrightLane.ts
# gate-watch: scripts/language-sidecars/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# language-sidecars — native IDE payload suite"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo ""
  echo "== $name =="
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done
exit "$fail"
