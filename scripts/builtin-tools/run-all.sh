#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/ink/**
# gate-watch: src/services/gitGraph/**
# gate-watch: src/services/primitives/**
# gate-watch: src/services/resources/adapters/**
# gate-watch: src/services/structure/**
# gate-watch: src/tools/**
# gate-watch: scripts/lib/* src/ink.ts
# gate-watch: src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/permissions/**
# gate-watch: src/guards/**
# gate-watch: src/services/search/htmlText.ts
# gate-watch: build.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# builtin-tools — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL builtin-tools PROOFS PASS"; else echo "# ❌ SOME builtin-tools PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
