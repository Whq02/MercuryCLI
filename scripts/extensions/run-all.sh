#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_EXTUI_CAPTURE_DIR MERCURY_EXTUI_ONLY
# gate-watch: src/extensions/** src/skills/loadSkillsDir* src/utils/hooks/**
# gate-watch: docs/EXTENSIONS.md docs/templates/extension-source-README.md
# gate-watch: mercury-skills/extension-maker/SKILL.md
# gate-watch: mercury-skills/extension-maker/references/README-template.md scripts/lib/captureDriver.ts
# gate-watch: scripts/lib/firstRunSeed.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/Tool.ts
# gate-watch: src/bootstrap/state.ts src/commands.ts src/commands/extensions/**
# gate-watch: src/components/HelpV2/commandDomains.ts src/components/extensions/**
# gate-watch: src/keybindings/defaultBindings.ts src/keybindings/schema.ts src/services/mcp/*
# gate-watch: src/skills/bundled/extension-maker/SKILL.md
# gate-watch: src/skills/bundled/extension-maker/references/README-template.md
# gate-watch: src/utils/config/globalConfig.ts src/utils/config/projectConfig.ts src/utils/env.ts
# gate-watch: src/utils/permissions/permissions.ts src/utils/secureStorage/index.ts
# gate-watch: src/utils/sessionStoragePortable.ts src/utils/settings/changeDetector.ts
# gate-watch: src/utils/settings/settings.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# extensions — proof suite"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EXTENSIONS PROOFS PASS"; else echo "# ❌ SOME EXTENSIONS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
