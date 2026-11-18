#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_PROOF_DIST
# gate-watch: src/services/mcp/** src/utils/Shell*
# gate-watch: src/commands/mcp/* src/components/mcp/*
# gate-watch: src/utils/projectConfig.ts
# gate-watch: src/utils/staticRender.tsx src/ink/components/TerminalSizeContext.tsx
# gate-watch: src/utils/readiness.ts
# gate-watch: src/rows/* sdk/src/** src/cli/headless/projectQuery.ts
# gate-watch: src/types/message.ts src/utils/attachments/types.ts
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MCP hardening — proof harness"
echo "############################################################"
shopt -s nullglob
claimed=$(members_cat scripts/mcp-*/members.txt)

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MCP PROOFS PASS"; else echo "# ❌ SOME MCP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
