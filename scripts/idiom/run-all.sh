#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/sessionStorage/** src/utils/projectConfig* src/utils/json*
# gate-watch: src/utils/envUtils* src/services/tools/toolExecution*
# gate-watch: src/fabric/** scripts/lib/scratchSeat.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/fixtureApi.ts scripts/navigation/fixture1k.ts scripts/substrate/prove-coordination-server.ts src/components/Message.tsx src/services/api/client.ts src/services/api/errorUtils.ts
# gate-watch: src/services/api/errors.ts src/services/api/logging.ts src/services/api/sdkErrors.ts src/services/api/withRetry.ts src/services/providers/anthropic/cacheAndUsage.ts src/services/providers/anthropic/requestParams.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/services/providers/openai/responsesBridge.ts src/services/providers/zai/zaiCodec.ts src/services/rateLimitMocking.ts src/services/tokenEstimation.ts src/services/vcr.ts
# gate-watch: src/tasks.ts src/types/wire.ts src/utils/attachments/types.ts src/utils/messages/factories.ts src/utils/messages/streamBatcher.ts src/utils/messages/structuredOutputDialect.ts
# gate-watch: src/utils/model/validateModel.ts src/services/projectLocal/paths.ts src/utils/settings/managedPath.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1

failed=0
run() {
  echo "── idiom: $1"
  local __t=$SECONDS __rc=0
  if ! { bun "scripts/idiom/$2" ; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "scripts/idiom/$2" "$__t" "$__rc"
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
run "persisted body shapes: a registered kind whose body fails its shape is thinned and named" prove-body-shape-registry.ts
run "attachment registry: every member of the Attachment union has a body-shape row and a fixture, both ways" prove-attachment-registry.ts
run "persisted body shapes on the built seat: a malformed body never breaks the resume" prove-persisted-body-shape.ts

exit "$failed"
