#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/integrations/blender/** src/tools/blender/**
# gate-watch: src/permissions/capability/**
# gate-watch: src/platform/processes/execFileNoThrow.ts
# gate-watch: src/tools/read/ReadTool.ts src/tools/read/call/call.ts src/tools/read/call/callParts.ts src/tools/read/call/image.ts src/tools/read/call/multiRangeLane.ts src/tools/read/call/notebook.ts src/tools/read/call/pdfLane.ts src/tools/read/call/reminder.ts src/tools/read/call/resultBlock.ts src/tools/read/call/results.ts src/tools/read/call/richFormatLane.ts src/tools/read/call/schema.ts src/tools/read/call/serialize.ts src/tools/read/call/source.ts src/tools/read/call/target.ts src/tools/read/call/textLane.ts src/tools/read/call/validate.ts src/tools/read/call/window.ts src/tools/read/call/windowText.ts src/tools/read/jsonQueryOutput.ts src/tools/read/jsonQueryProcess.mjs src/tools/read/jsonQueryProvenance.ts src/tools/read/jsonQueryRuntime.ts src/tools/read/jsonQuerySource.ts src/tools/read/jsonQueryWorker.mjs src/tools/read/officeText.ts src/tools/read/outline.ts src/tools/read/profileJson.ts src/tools/read/profileModel.ts src/tools/read/profileParse.ts src/tools/read/profileStream.ts src/tools/read/readJson.ts src/tools/read/readProfiles.ts src/tools/read/readQuery.ts src/tools/read/readQueryTarget.ts src/tools/read/readRichFormats.ts src/tools/read/readTarget.ts src/tools/read/readViewPage.ts src/tools/read/readViewSource.ts src/tools/read/rows.tsx src/tools/read/sqliteQuery.ts src/tools/read/sqliteQueryProcess.ts src/platform/images/imageResizer.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
echo "############################################################"
echo "# blender-bridge — proof harness"
echo "############################################################"

if [ -f "$here/regen-bridge.mjs" ]; then
  echo
  echo ">>> regen-bridge --check"
  __t=$SECONDS; __rc=0; node "$here/regen-bridge.mjs" --check || { __rc=$?; fail=1; }; prover_mark "$here/regen-bridge.mjs" "$__t" "$__rc"
fi

drive_members blender-bridge 'scripts/blender-bridge/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BLENDER-BRIDGE PROOFS PASS"; else echo "# ❌ SOME BLENDER-BRIDGE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
