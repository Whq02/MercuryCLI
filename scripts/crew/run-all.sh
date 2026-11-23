#!/usr/bin/env bash
# gate-watch: src/boot/** src/commands/**
# gate-watch: src/crew/**
# gate-class: cpu
# gate-watch: src/daemon/** src/engine/**
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/renderScenarios.ts src/integrations/desktop/* src/integrations/event-hooks/* src/integrations/extensions/load/* src/integrations/ide/* src/integrations/lsp/*
# gate-watch: src/integrations/mcp/*
# gate-watch: src/integrations/media-video/*
# gate-watch: src/models/catalogue/computedDefault.ts
# gate-watch: src/models/effort/*
# gate-watch: src/models/facts/builtInModelTable.ts src/models/roads/*
# gate-watch: src/models/roads/local/ollamaChatTransport.ts
# gate-watch: src/models/roads/openaicompat/compatChatCallModel.ts
# gate-watch: src/models/sign-in/**
# gate-watch: src/models/usage/*
# gate-watch: src/permissions/capability/declarations.ts
# gate-watch: src/permissions/rules/*
# gate-watch: src/platform/async/* src/platform/editor/*
# gate-watch: src/platform/environment/*
# gate-watch: src/platform/errors/*
# gate-watch: src/platform/files/*
# gate-watch: src/platform/git/**
# gate-watch: package.json scripts/project-services/fixtures/inventory.json
# gate-watch: src/platform/health/* src/platform/host-os/*
# gate-watch: src/platform/images/* src/platform/logs/* src/platform/network/*
# gate-watch: src/platform/observability/* src/platform/primitives/*
# gate-watch: src/platform/processes/* src/platform/product/* src/platform/secrets/*
# gate-watch: src/platform/settings/**
# gate-watch: src/platform/shell/*
# gate-watch: docs/CREW.md docs/ENGINES.md README.md src/platform/storage/* src/platform/substrate/operationJournal.ts
# gate-watch: src/platform/text/*
# gate-watch: src/screen/**
# gate-watch: src/sessions/**
# gate-watch: src/tools/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/crew"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
unset MERCURY_DAEMON_PERMISSION_MODE MERCURY_WORKER_RECON_ALLOW 2>/dev/null || true
trap 'rm -rf "$scratch_home"; suite_home_cleanup' EXIT
echo "############################################################"
echo "# Crewmates — proof harness"
echo "############################################################"
drive_members crew 'scripts/crew/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CREW PROOFS PASS"; else echo "# ❌ SOME CREW PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
