#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/sessionHooks* src/utils/hooks/wardsHook* src/utils/wards/wards*
# gate-watch: assets/splash/splash-core.mjs design-system/live/manifest.json docs/EXTENSIONS.md
# gate-watch: native/desktop/Cargo.lock scripts/builtin-tools/fixtures/tool-census.json
# gate-watch: scripts/gate/generated-assets.tsv scripts/settings/settings-schema.json
# gate-watch: scripts/skills/gen-bundled.ts scripts/splash/deploy.sh
# gate-watch: src/components/mercury-ui/sessionAccent.ts src/components/mercuryPalette.ts
# gate-watch: src/constants/cyberRiskInstruction.ts src/daemon/workerRecon.ts src/skills/bundled/app-proof.ts
# gate-watch: src/skills/bundled/app-proof/SKILL.md src/skills/bundled/updateConfig.ts
# gate-watch: src/substrate/flagRegistry.ts src/tools/**/*.{ts,tsx} src/utils/* src/utils/hooks/engine.ts
# gate-watch: src/utils/hooks/generatedAssets.ts
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
