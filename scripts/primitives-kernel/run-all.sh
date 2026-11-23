#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/engine/run/**
# gate-watch: src/engine/runtime-kernel/**
# gate-watch: src/integrations/resources/adapters/*
# gate-watch: src/screen/renderer/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/primitives-kernel"
fail=0
echo "############################################################"
echo "# primitives-kernel — proof harness"
echo "############################################################"
drive_members primitives-kernel 'scripts/primitives-kernel/$name' "$here/members.txt" || fail=1
echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL primitives-kernel PROOFS PASS"; else echo "# ❌ SOME primitives-kernel PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
