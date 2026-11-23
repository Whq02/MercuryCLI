#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/screen/concourse/**
# gate-watch: src/daemon/switchboard/attachedSession.ts
# gate-watch: src/screen/chat/ChatKeys.tsx src/screen/chat/chatBottomSlot.tsx src/screen/chat/chatMessagesList.tsx src/screen/chat/chatStore.ts src/screen/chat/chatTree.tsx src/screen/chat/crashResume.ts src/screen/chat/focusedDialog.ts src/screen/chat/limits.ts src/screen/chat/screen.ts src/screen/chat/sessionShapes.ts src/screen/chat/useChatAsks.tsx src/screen/chat/useChatBoot.tsx src/screen/chat/useChatDialogs.tsx src/screen/chat/useChatDraft.ts src/screen/chat/useChatFocusedSeat.ts src/screen/chat/useChatScroll.ts src/screen/chat/useChatSearch.tsx src/screen/chat/useChatSelector.tsx src/screen/chat/useChatSession.ts src/screen/chat/useChatStatus.tsx src/screen/chat/useChatSubmit.ts src/screen/chat/useChatTitle.tsx src/screen/chat/useChatTools.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-6"

failed=0
drive_members switchboard-6 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
