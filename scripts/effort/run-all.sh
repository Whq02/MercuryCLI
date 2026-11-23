#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/attachment-shapes/* src/engine/messages/attachmentText.ts src/models/effort/*
# gate-watch: src/platform/config/**
# gate-watch: src/platform/settings/* src/screen/composer/Composer.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/effort"
fail=0
echo "############################################################"
echo "# effort — effort-module proofs"
echo "############################################################"
drive_members effort 'scripts/effort/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "effort suite: RED"
  exit 1
fi
echo "effort suite: green"
