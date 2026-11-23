#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/platform/remote-files/**
# gate-watch: src/tools/read/ReadTool.ts src/tools/read/call/call.ts src/tools/read/call/callParts.ts src/tools/read/call/image.ts src/tools/read/call/multiRangeLane.ts src/tools/read/call/notebook.ts src/tools/read/call/pdfLane.ts src/tools/read/call/reminder.ts src/tools/read/call/resultBlock.ts src/tools/read/call/results.ts src/tools/read/call/richFormatLane.ts src/tools/read/call/schema.ts src/tools/read/call/serialize.ts src/tools/read/call/source.ts src/tools/read/call/target.ts src/tools/read/call/textLane.ts src/tools/read/call/validate.ts src/tools/read/call/window.ts src/tools/read/call/windowText.ts src/tools/read/jsonQueryOutput.ts src/tools/read/jsonQueryProcess.mjs src/tools/read/jsonQueryProvenance.ts src/tools/read/jsonQueryRuntime.ts src/tools/read/jsonQuerySource.ts src/tools/read/jsonQueryWorker.mjs src/tools/read/officeText.ts src/tools/read/outline.ts src/tools/read/profileJson.ts src/tools/read/profileModel.ts src/tools/read/profileParse.ts src/tools/read/profileStream.ts src/tools/read/readJson.ts src/tools/read/readProfiles.ts src/tools/read/readQuery.ts src/tools/read/readQueryTarget.ts src/tools/read/readRichFormats.ts src/tools/read/readTarget.ts src/tools/read/readViewPage.ts src/tools/read/readViewSource.ts src/tools/read/rows.tsx src/tools/read/sqliteQuery.ts src/tools/read/sqliteQueryProcess.ts
# gate-watch: src/tools/write/SqliteDeletePermissionRequest.tsx src/tools/write/WriteTool.ts src/tools/write/call/** src/tools/write/parseCheck.ts src/tools/write/rows.tsx src/tools/write/structuredTargets.ts
# gate-watch: src/tools/glob/GlobTool.ts src/tools/glob/prompt.ts src/tools/glob/rows.tsx
# gate-watch: src/tools/grep/**
# gate-watch: src/tools/glob/glob.ts
# gate-watch: src/tools/glob/globPattern.ts
# gate-watch: src/permissions/cards/file-dialog/**
# gate-watch: src/permissions/cards/file-write/**
# gate-watch: src/tools/edit/EditDiff.tsx
# gate-watch: src/tools/write/FileEditToolUseRejectedMessage.tsx
# gate-watch: src/permissions/cards/RemotePathSubtitle.tsx
# gate-watch: src/tools/edit/EditTool.ts src/tools/edit/call/call.ts src/tools/edit/call/callParts.ts src/tools/edit/call/exactMatch.ts src/tools/edit/call/fileFacts.ts src/tools/edit/call/readKnowledge.ts src/tools/edit/call/validate.ts src/tools/edit/editResult.ts src/tools/edit/otherSession.ts src/tools/edit/prompt.ts src/tools/edit/readThrough.ts src/tools/edit/rows.tsx src/tools/edit/schema.ts src/tools/edit/sectionEdit.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/remote-files"
fail=0
drive_members remote-files 'scripts/remote-files/$name' "$here/members.txt" || fail=1
exit $fail
