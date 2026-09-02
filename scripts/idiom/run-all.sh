#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/sessionStorage/** src/utils/projectConfig* src/utils/json*
# gate-watch: src/utils/envUtils* src/services/tools/toolExecution*
# All four expect-red reproducers have flipped and
# run here as permanent invariant provers (ER-1/2 settlement, ER-3 homes,
# ER-4 read accounting) beside the domain + hygiene ratchets.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."

failed=0
run() {
  echo "── idiom: $1"
  local __t=$SECONDS
  if ! bun "scripts/idiom/$2" ; then
    failed=1
  fi
  prover_mark "scripts/idiom/$2" "$__t"
}

run "census-zero hygiene (C14/C18/C19/C21)" prove-idiom-hygiene.ts
run "provider-SDK import fence (B01/B03/B04/B07/E01)" prove-import-fence.ts
run "direct provider-codec laws (B05/B06/B08)" prove-provider-codecs.ts
run "fabric domain: model + validators + lossless entry codec" prove-fabric-domain.ts
run "immutable settlement (ER-1/ER-2 flipped)" prove-immutable-settlement.ts
run "canonical write home + adoption (ER-3 flipped)" prove-canonical-write-home.ts
run "transcript read accounting (ER-4 flipped)" prove-transcript-read-accounting.ts
run "append cost O(new) (win c)" prove-append-cost.ts
run "resume snapshot-plus-tail (win b)" prove-resume-snapshot.ts
run "transcript vNext: header + records + restart ordinals + lineage (C01/C02/C09/C11/A09)" prove-transcript-vnext.ts
run "cross-surface identity + headless per-client policy (E02/E07)" prove-identity-and-headless.ts
run "managed-policy precedence: native outranks imported (D12)" prove-managed-precedence.ts
run "bounded subscribers + batched deltas (A10/F04)" prove-bounded-subscribers.ts

exit "$failed"
