#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/proofAccountHome.ts
# gate-watch: sdk-py/README.md sdk/README.md
# gate-watch: src/utils/hooks/sessionHooks* src/guards/wardsGuard* src/utils/wards/wards*
# gate-watch: assets/splash/splash-core.mjs design-system/live/manifest.json docs/EXTENSIONS.md
# gate-watch: native/desktop/Cargo.lock scripts/builtin-tools/fixtures/tool-census.json
# gate-watch: scripts/gate/generated-assets.tsv scripts/settings/settings-schema.json
# gate-watch: scripts/skills/gen-bundled.ts scripts/splash/deploy.sh
# gate-watch: src/components/mercury-ui/sessionAccent.ts src/components/mercuryPalette.ts
# gate-watch: src/daemon/workerRecon.ts src/skills/bundled/mcp-smithy.ts
# gate-watch: src/skills/bundled/mcp-smithy/SKILL.md src/skills/bundled/updateConfig.ts
# gate-watch: src/substrate/flagRegistry.ts src/tools/**/*.{ts,tsx} src/utils/* src/utils/hooks/fire.ts src/guards/**
# gate-watch: src/guards/generatedAssets.ts src/services/tools/toolExecution.ts
# gate-watch: scripts/lib/linearGrowth.ts
# gate-watch: src/skills/bundled/** scripts/ui/lib/emojiProperties.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts
# gate-watch: docs/INSTALL.md
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# wards — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL WARDS PROOFS PASS"; else echo "# ❌ SOME WARDS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
