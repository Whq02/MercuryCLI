#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/daemon/**
# gate-watch: src/daemon/**
# gate-watch: src/engine/rows/*
# gate-watch: docs/DURABILITY.md
# gate-watch: src/engine/tasks/local-agent/* src/integrations/resources/adapters/*
# gate-watch: src/screen/composer/input-core/* src/tools/cron/**
# gate-watch: docs/SESSIONS.md scripts/dap/mock-dap-adapter.mjs scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/* scripts/staleness/prove-stale-registry.ts
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: scripts/ops/deploy-runtime.sh scripts/ops/launcher-mercury.sh scripts/ops/deploy-launcher.sh scripts/splash/deploy.sh docs/TERMINAL-RUNTIME.md
# gate-watch: package.json src/tools/monitor/**
# gate-watch: src/tools/schedule-wakeup/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon-3"

fail=0
drive_members daemon-3 'scripts/daemon/$name' "$here/members.txt" '' run || fail=1
exit "$fail"
