#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/desktop/pack.ts native/desktop/**
# gate-watch: src/tools/GrepTool/** src/tools/shared/documentText.ts src/tools/WebFetchTool/**
# gate-watch: src/services/providers/mistral/**
# gate-watch: src/services/providers/openai/** src/services/providers/gemini/** src/services/providers/zai/** src/services/providers/openaicompat/compatChatCallModel.ts src/services/providers/pdfBlock.ts
# gate-watch: src/tools/DocumentTool/** src/utils/ffmpeg.ts src/services/voice/** native/whisper/** vendor/whisper-models.lock.json
# gate-watch: src/tools/FileReadTool/** src/utils/pdf* vendor/pdfjs.lock.json scripts/vendor/pdfjs.ts scripts/vendor/fetch-pdfjs.ts build.ts package.json
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/document-read"
fail=0
drive_members document-read 'scripts/document-read/$name' "$here/members.txt" || fail=1
exit "$fail"
