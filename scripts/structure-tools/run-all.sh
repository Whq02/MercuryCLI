#!/usr/bin/env bash
# gate-class: cpu

# gate-watch: src/services/structure/** src/tools/StructureTool/**
# gate-watch: src/services/repoHost/** src/services/gitGraph/** src/tools/GitTool/**
# gate-watch: src/services/ide/projectRunners.ts src/services/ide/pythonTests.ts src/tools/TestTool/**
# gate-watch: src/services/resources/adapters/repo.ts src/services/resources/adapters/git.ts src/services/resources/adapters/structure.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MERCURY structure-tools — developer-tooling bridge suite"
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
