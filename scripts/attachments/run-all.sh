#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/attachments/**
# gate-watch: src/utils/imageResizer* src/utils/imagePaste* src/utils/imageStore* src/utils/imageValidation*
# gate-watch: src/constants/apiLimits* src/tools/FileReadTool/imageProcessor* src/hooks/usePasteHandler* src/hooks/useClipboardImageHint*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── context-assembly proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-attachments-parity.ts" || fail=1; prover_mark "$here/prove-attachments-parity.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-image-road.ts" || fail=1; prover_mark "$here/prove-image-road.ts" "$__t"
if [[ "$fail" == "0" ]]; then echo "✅ ATTACHMENTS SUITE GREEN"; exit 0; else
  echo "❌ ATTACHMENTS SUITE RED"; exit 1; fi
