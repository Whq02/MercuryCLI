#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/engine-connector/**
# gate-watch: src/daemon/runner/runHeadless.ts src/daemon/session-seat/sessionSeat.ts
# gate-watch: src/engine/connector/** src/permissions/cards/**
# gate-watch: src/screen/composer/** src/screen/focused-session/useSessionConnector.ts
# gate-watch: scripts/lib/*
# gate-watch: src/screen/frame-chips/MercuryFrame.tsx src/screen/model-picker/useDisplayedSessionModel.ts src/sessions/transcripts/writer.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export BUSY_STALL_DRIVE=1
here="scripts/engine-connector-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'engine-connector-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

MERCURY_SUITE_JOBS=1 drive_members engine-connector-drives 'scripts/engine-connector/$name' "$here/members.txt"
