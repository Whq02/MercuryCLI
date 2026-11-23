#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/integrations/desktop/pack.ts native/desktop/**
# gate-watch: src/tools/grep/** src/tools/kit/documentText.ts src/tools/web-fetch/WebFetchTool.ts src/tools/web-fetch/extractHtml.ts src/tools/web-fetch/fetchContent.ts src/tools/web-fetch/fetchErrors.ts src/tools/web-fetch/fetchPacing.ts src/tools/web-fetch/fetchTransport.ts src/tools/web-fetch/pageAccess.ts src/tools/web-fetch/pageBudget.ts src/tools/web-fetch/preapproved.ts src/tools/web-fetch/privateHost.ts src/tools/web-fetch/prompt.ts src/tools/web-fetch/reader.ts src/tools/web-fetch/robots.ts src/tools/web-fetch/rows.tsx src/tools/web-fetch/structuredHosts.ts src/tools/web-fetch/tableRule.ts
# gate-watch: src/models/roads/mistral/**
# gate-watch: src/models/roads/openai/** src/models/roads/gemini/** src/models/roads/zai/** src/models/roads/openaicompat/compatChatCallModel.ts src/models/roads/pdfBlock.ts
# gate-watch: src/tools/document/** src/integrations/media-video/ffmpeg.ts src/integrations/voice/** native/whisper/** vendor/whisper-models.lock.json
# gate-watch: src/tools/read/ReadTool.ts src/tools/read/call/call.ts src/tools/read/call/callParts.ts src/tools/read/call/image.ts src/tools/read/call/multiRangeLane.ts src/tools/read/call/notebook.ts src/tools/read/call/pdfLane.ts src/tools/read/call/reminder.ts src/tools/read/call/resultBlock.ts src/tools/read/call/results.ts src/tools/read/call/richFormatLane.ts src/tools/read/call/schema.ts src/tools/read/call/serialize.ts src/tools/read/call/source.ts src/tools/read/call/target.ts src/tools/read/call/textLane.ts src/tools/read/call/validate.ts src/tools/read/call/window.ts src/tools/read/call/windowText.ts src/tools/read/jsonQueryOutput.ts src/tools/read/jsonQueryProcess.mjs src/tools/read/jsonQueryProvenance.ts src/tools/read/jsonQueryRuntime.ts src/tools/read/jsonQuerySource.ts src/tools/read/jsonQueryWorker.mjs src/tools/read/officeText.ts src/tools/read/outline.ts src/tools/read/profileJson.ts src/tools/read/profileModel.ts src/tools/read/profileParse.ts src/tools/read/profileStream.ts src/tools/read/readJson.ts src/tools/read/readProfiles.ts src/tools/read/readQuery.ts src/tools/read/readQueryTarget.ts src/tools/read/readRichFormats.ts src/tools/read/readTarget.ts src/tools/read/readViewPage.ts src/tools/read/readViewSource.ts src/tools/read/rows.tsx src/tools/read/sqliteQuery.ts src/tools/read/sqliteQueryProcess.ts src/tools/kit/pdf.ts src/tools/kit/pdfText.ts src/tools/kit/pdfTextWorker.mjs vendor/pdfjs.lock.json scripts/vendor/pdfjs.ts scripts/vendor/fetch-pdfjs.ts build.ts package.json
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/document-read"
fail=0
drive_members document-read 'scripts/document-read/$name' "$here/members.txt" || fail=1
exit "$fail"
