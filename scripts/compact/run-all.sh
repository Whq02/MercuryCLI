#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/run-core/turn/**
# gate-watch: src/tools/CheckpointTool/** src/tools/RewindTool/**
# gate-watch: scripts/lib/*
# gate-watch: src/*
# gate-watch: src/components/*
# gate-watch: src/constants/betas.ts
# gate-watch: src/services/api/*
# gate-watch: src/services/providers/*
# gate-watch: src/services/providers/anthropic/*
# gate-watch: src/services/providers/openai/*
# gate-watch: src/utils/*
# gate-watch: src/utils/attachments/*
# gate-watch: src/utils/messages/*
# gate-watch: src/services/instructions/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/types/message.ts
# gate-watch: src/mneme/*
# gate-watch: src/utils/fileReadLimits.ts
# gate-watch: src/commands/context/context-noninteractive.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/compact"
fail=0
echo "############################################################"
echo "# compact — context maintenance proofs"
echo "############################################################"
drive_members compact 'scripts/compact/$name' "$here/members.txt" || fail=1
exit "$fail"
