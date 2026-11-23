#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/session-graph/**
# gate-watch: src/screen/attention/actions.ts src/screen/attention/contracts.ts src/screen/attention/relations.ts src/screen/attention/statusFeed.ts src/screen/attention/store.ts src/screen/attention/viewModel.ts src/screen/attention/relations.ts
# gate-watch: src/screen/workbench/** src/integrations/acp/**
# gate-watch: src/sessions/artifacts/**
# gate-watch: scripts/lib/codeText.ts scripts/lib/shippedKeyForms.ts
# gate-watch: src/daemon/runner/runHeadless.ts src/commands/crew/index.ts
# gate-watch: src/screen/concourse/ConcourseRoute.tsx src/screen/prompts-panel/PromptsPanel.tsx
# gate-watch: src/screen/prompts-panel/rows.ts
# gate-watch: src/screen/concourse-model/concourseSnapshot.ts
# gate-watch: src/crew/crewmates/activity.ts src/crew/crewmates/adapters/** src/crew/crewmates/agentLaunchPlan.ts src/crew/crewmates/agentTranscriptReader.ts src/crew/crewmates/capabilities.ts src/crew/crewmates/channelCommand.ts src/crew/crewmates/conversations.ts src/crew/crewmates/crewAccountChange.ts src/crew/crewmates/crewWorktreeReminder.ts src/crew/crewmates/crewmateModelWord.ts src/crew/crewmates/crewmateRecord.ts src/crew/crewmates/descriptor.ts src/crew/crewmates/dispatch.ts src/crew/crewmates/engineDispatch.ts src/crew/crewmates/graph.ts src/crew/crewmates/identity.ts src/crew/crewmates/inbox.ts src/crew/crewmates/obligations.ts src/crew/crewmates/obligationsBridge.ts src/crew/crewmates/projection.ts src/crew/crewmates/seatBridge.ts src/crew/crewmates/targetPicker.ts
# gate-watch: src/daemon/session-seat/permissionAsks.ts src/daemon/control/controlServer.ts
# gate-watch: src/integrations/resources/registry.ts
# gate-watch: src/screen/messages/AttachmentMessage.tsx
# gate-watch: src/screen/widgets/faces/CrewView.tsx
# gate-watch: src/tools/send-message/SendMessageTool.ts src/engine/messages/attachmentText.ts
# gate-watch: src/engine/task-framework/tasks.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/session-graph-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'session-graph-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members session-graph-drives 'scripts/session-graph/$name' "$here/members.txt"
