#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/switchboard/**
# gate-watch: src/screen/concourse/**
# gate-watch: src/daemon/switchboard/attachedSession.ts
# gate-watch: src/sessions/transcripts/branchSelection.ts src/sessions/transcripts/builtInCommands.ts src/sessions/transcripts/chain.ts src/sessions/transcripts/clearedSessions.ts src/sessions/transcripts/fileWatch.ts src/sessions/transcripts/fold.ts src/sessions/transcripts/historyParts.ts src/sessions/transcripts/loading.ts src/sessions/transcripts/materialize.ts src/sessions/transcripts/mirrorRecord.ts src/sessions/transcripts/paths.ts src/sessions/transcripts/resumeMiss.ts src/sessions/transcripts/resumeSnapshot.ts src/sessions/transcripts/rowGraph.ts src/sessions/transcripts/sessionHomePin.ts src/sessions/transcripts/sessionIndex.ts src/sessions/transcripts/sessionListings.ts src/sessions/transcripts/sessionMeta.ts src/sessions/transcripts/sessionWriter.ts src/sessions/transcripts/settledSidechainMessages.ts src/sessions/transcripts/streamFold.ts src/sessions/transcripts/transcriptBytes.ts src/sessions/transcripts/transcriptProjector.ts src/sessions/transcripts/transcriptReader.ts src/sessions/transcripts/vnext.ts src/sessions/transcripts/writer.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-4"

failed=0
drive_members switchboard-4 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
