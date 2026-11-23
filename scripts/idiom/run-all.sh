#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/sessions/transcripts/branchSelection.ts src/sessions/transcripts/builtInCommands.ts src/sessions/transcripts/chain.ts src/sessions/transcripts/clearedSessions.ts src/sessions/transcripts/fileWatch.ts src/sessions/transcripts/fold.ts src/sessions/transcripts/historyParts.ts src/sessions/transcripts/loading.ts src/sessions/transcripts/materialize.ts src/sessions/transcripts/mirrorRecord.ts src/sessions/transcripts/paths.ts src/sessions/transcripts/resumeMiss.ts src/sessions/transcripts/resumeSnapshot.ts src/sessions/transcripts/rowGraph.ts src/sessions/transcripts/sessionHomePin.ts src/sessions/transcripts/sessionIndex.ts src/sessions/transcripts/sessionListings.ts src/sessions/transcripts/sessionMeta.ts src/sessions/transcripts/sessionWriter.ts src/sessions/transcripts/settledSidechainMessages.ts src/sessions/transcripts/streamFold.ts src/sessions/transcripts/transcriptBytes.ts src/sessions/transcripts/transcriptProjector.ts src/sessions/transcripts/transcriptReader.ts src/sessions/transcripts/vnext.ts src/sessions/transcripts/writer.ts src/sessions/transcripts/writer/** src/platform/storage/json.ts src/platform/storage/jsonRead.ts
# gate-watch: src/platform/environment/envUtils.ts src/engine/tool-dispatch/toolExecution.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
# gate-watch: src/models/roads/anthropic/anthropicClientFactory.ts src/engine/requests/apiErrorDetails.ts
# gate-watch: src/engine/requests/apiErrorRows.ts src/engine/requests/apiCallLogging.ts src/engine/requests/withRetry.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/requestParams.ts
# gate-watch: src/models/roads/anthropic/streamCore.ts src/models/roads/anthropic/rateLimitMocking.ts src/models/facts/tokenEstimation.ts src/models/roads/anthropic/fixtureReplay.ts
# gate-watch: src/models/roads/validateModel.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/idiom"

failed=0
drive_members idiom 'scripts/idiom/$name' "$here/members.txt" || failed=1

exit "$failed"
