#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/interaction/**
# gate-watch: src/boot/*
# gate-watch: src/boot/first-run/*
# gate-watch: src/commands/** src/engine/user-input/*
# gate-watch: src/integrations/skill-watch/* src/models/sign-in/** src/models/usage/*
# gate-watch: src/permissions/cards/ask-user-question/**
# gate-watch: src/screen/** src/tools/crewmate/*
# gate-watch: src/tools/edit/*
# gate-watch: src/tools/kit/*
# gate-watch: src/tools/notebook-edit/*
# gate-watch: src/tools/write/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interaction-pure"

fail=0
drive_members interaction-pure 'scripts/interaction/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION-PURE SUITE GREEN"; else echo "❌ INTERACTION-PURE SUITE RED"; fi
exit "$fail"
