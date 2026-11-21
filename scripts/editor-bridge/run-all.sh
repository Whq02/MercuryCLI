#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/workbench/** src/services/resources/adapters/workbench.ts
# gate-watch: src/services/acp/**
# gate-watch: src/utils/artifacts/** src/components/diff/** src/components/prompts-panel/**
# gate-watch: LICENSE.md NOTICE
# gate-watch: src/cli/run.ts
# gate-watch: src/services/mcp/client.ts src/services/run/*
# gate-watch: src/utils/*
# gate-watch: scripts/idiom/prove-body-shape-registry.ts src/fabric/validate.ts
# gate-watch: src/services/attachments/mentionResolvers.ts src/utils/attachments/types.ts
# gate-watch: src/services/messages/attachmentText.ts
# gate-watch: src/rows/* src/runner/wire/* src/tools/AskUserQuestionTool/**
# gate-watch: scripts/lib/ptyRecorder.ts
# gate-watch: src/services/engine-connector/midTurnText.ts src/utils/sessionStorage/*
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/editor-bridge"

red=0
drive_members editor-bridge 'scripts/editor-bridge/$name' "$here/members.txt" '' run || red=1

exit "$red"
