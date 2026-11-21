#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/video/**
# gate-watch: src/utils/**
# gate-watch: src/tasks/stopTask* src/tasks/taskOutcomeEnvelope*
# gate-watch: src/*
# gate-watch: src/cli/headless/controlHandlers.ts src/components/*
# gate-watch: src/daemon/*
# gate-watch: src/hooks/*
# gate-watch: src/services/providers/*
# gate-watch: src/services/providers/openai/*
# gate-watch: src/components/messages/AttachmentMessage.tsx src/components/messages/TranscriptNameplate.tsx
# gate-watch: src/utils/hooks/contract.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/remoteFiles/** src/services/privateChannel/vendoredRuntime.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/tools"
fail=0
drive_members tools 'scripts/tools/$name' "$here/members.txt" || fail=1
exit $fail
