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
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/builtin-tools"
fail=0
echo "############################################################"
echo "# builtin-tools — proof harness"
echo "############################################################"
drive_members builtin-tools 'scripts/builtin-tools/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL builtin-tools PROOFS PASS"; else echo "# ❌ SOME builtin-tools PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
