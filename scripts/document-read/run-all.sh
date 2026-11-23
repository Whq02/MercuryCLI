#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: native/desktop/** src/integrations/desktop/pack.ts
# gate-watch: src/integrations/media-video/ffmpeg.ts src/integrations/voice/** src/models/roads/gemini/**
# gate-watch: src/models/roads/mistral/**
# gate-watch: src/models/roads/openai/** src/models/roads/openaicompat/compatChatCallModel.ts src/models/roads/pdfBlock.ts src/models/roads/zai/** src/tools/document/**
# gate-watch: native/whisper/** vendor/whisper-models.lock.json src/tools/grep/** src/tools/kit/* src/tools/read/**
# gate-watch: vendor/pdfjs.lock.json scripts/vendor/pdfjs.ts scripts/vendor/fetch-pdfjs.ts build.ts package.json src/tools/web-fetch/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/document-read"
fail=0
drive_members document-read 'scripts/document-read/$name' "$here/members.txt" || fail=1
exit "$fail"
