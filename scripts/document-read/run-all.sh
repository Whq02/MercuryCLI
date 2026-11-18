#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/desktop/pack.ts native/desktop/**
# gate-watch: src/tools/GrepTool/** src/utils/documentText.ts src/tools/WebFetchTool/**
# gate-watch: src/services/providers/mistral/**
# gate-watch: src/services/providers/openai/** src/services/providers/gemini/** src/services/providers/zai/** src/services/providers/openaicompat/compatChatCallModel.ts src/services/providers/pdfBlock.ts
# gate-watch: src/tools/DocumentTool/** src/utils/ffmpeg.ts src/services/voice/** native/whisper/** vendor/whisper-models.lock.json
# gate-watch: src/tools/FileReadTool/** src/utils/pdf* vendor/pdfjs.lock.json scripts/vendor/pdfjs.ts scripts/vendor/fetch-pdfjs.ts build.ts package.json
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
for proof in "$here"/prove-*.ts; do
  bun "$proof" || fail=1
done
exit "$fail"
