#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/config/** src/utils/effort* src/utils/settings/settings*
# gate-watch: src/commands/effort/EffortSlider.tsx src/commands/effort/effort.tsx
# gate-watch: src/components/MercuryFrame.tsx src/components/PromptInput/PromptInput.tsx src/main.tsx
# gate-watch: src/utils/attachments/* src/utils/config.ts src/utils/messages/attachmentText.ts
# gate-watch: src/utils/model/seatSlots.ts src/utils/settings/types.ts src/utils/thinking.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# deepthink — effort-module proofs"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
if [ "$fail" -ne 0 ]; then
  echo "deepthink suite: RED"
  exit 1
fi
echo "deepthink suite: green"
