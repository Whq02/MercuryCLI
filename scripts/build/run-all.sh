#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_SMOKE_LIVE
# gate-watch: bun.lock
# gate-watch: scripts/vendor/**
# gate-watch: src/tools/apollo-review/** src/tools/aseprite/** src/tools/ask-advisor/** src/tools/ask-question/** src/tools/ast-edit/** src/tools/ast-search/** src/tools/blender/** src/tools/browser/** src/tools/change-set/** src/tools/checkpoint/** src/tools/computer/** src/tools/context-left/** src/tools/crewmate/CrewmateTool.tsx src/tools/crewmate/agentPermissionPosture.ts src/tools/crewmate/agentToolRules.ts src/tools/crewmate/built-in/** src/tools/crewmate/builtInAgents.ts src/tools/crewmate/call/** src/tools/crewmate/continuationNote.ts src/tools/crewmate/crewmateColors.ts src/tools/crewmate/crewmateLifecycle.ts src/tools/crewmate/foregroundExecution.tsx src/tools/crewmate/frozenWorktreeNotice.ts src/tools/crewmate/liveAgentOwner.ts src/tools/crewmate/loadAgentsDir.ts src/tools/crewmate/prompt.ts src/tools/crewmate/refusalRetry.ts src/tools/crewmate/resumeCrewmate.ts src/tools/crewmate/reviewerPolicy.ts src/tools/crewmate/rows.tsx src/tools/crewmate/run/crewmateEnd.ts src/tools/crewmate/run/prepare.ts src/tools/crewmate/run/setup.ts src/tools/crewmate/run/watch.ts src/tools/crewmate/runCrewmate.ts src/tools/crewmate/scoutPolicy.ts src/tools/crewmate/worktreePrepareNotice.ts src/tools/cron/** src/tools/debug/** src/tools/document/** src/tools/edit/EditTool.ts src/tools/edit/call/call.ts src/tools/edit/call/callParts.ts src/tools/edit/call/exactMatch.ts src/tools/edit/call/fileFacts.ts src/tools/edit/call/readKnowledge.ts src/tools/edit/call/validate.ts src/tools/edit/editResult.ts src/tools/edit/otherSession.ts src/tools/edit/prompt.ts src/tools/edit/readThrough.ts src/tools/edit/rows.tsx src/tools/edit/schema.ts src/tools/edit/sectionEdit.ts src/tools/enter-worktree/** src/tools/eval/** src/tools/exit-worktree/** src/tools/git/** src/tools/glob/GlobTool.ts src/tools/glob/prompt.ts src/tools/glob/rows.tsx src/tools/godot/** src/tools/grep/** src/tools/inspect/** src/tools/jev-eval/** src/tools/journal/** src/tools/journey/** src/tools/kit/commandDisplay.ts src/tools/kit/documentText.ts src/tools/kit/gitOperationTracking.ts src/tools/kit/sessionEnvNotice.ts src/tools/kit/toolResultSummary.ts src/tools/kit/toolTable.ts src/tools/kit/toolUseIds.ts src/tools/launch/** src/tools/list-mcp-resources/** src/tools/lsp/** src/tools/mcp-auth/** src/tools/mcp/** src/tools/memory/** src/tools/monitor/** src/tools/notebook-edit/NotebookEditTool.ts src/tools/notebook-edit/constants.ts src/tools/notebook-edit/notebookText.ts src/tools/notebook-edit/prompt.ts src/tools/notebook-edit/rows.tsx src/tools/powershell/** src/tools/read-mcp-resource/** src/tools/read/ReadTool.ts src/tools/read/call/call.ts src/tools/read/call/callParts.ts src/tools/read/call/image.ts src/tools/read/call/multiRangeLane.ts src/tools/read/call/notebook.ts src/tools/read/call/pdfLane.ts src/tools/read/call/reminder.ts src/tools/read/call/resultBlock.ts src/tools/read/call/results.ts src/tools/read/call/richFormatLane.ts src/tools/read/call/schema.ts src/tools/read/call/serialize.ts src/tools/read/call/source.ts src/tools/read/call/target.ts src/tools/read/call/textLane.ts src/tools/read/call/validate.ts src/tools/read/call/window.ts src/tools/read/call/windowText.ts src/tools/read/jsonQueryOutput.ts src/tools/read/jsonQueryProcess.mjs src/tools/read/jsonQueryProvenance.ts src/tools/read/jsonQueryRuntime.ts src/tools/read/jsonQuerySource.ts src/tools/read/jsonQueryWorker.mjs src/tools/read/officeText.ts src/tools/read/outline.ts src/tools/read/profileJson.ts src/tools/read/profileModel.ts src/tools/read/profileParse.ts src/tools/read/profileStream.ts src/tools/read/readJson.ts src/tools/read/readProfiles.ts src/tools/read/readQuery.ts src/tools/read/readQueryTarget.ts src/tools/read/readRichFormats.ts src/tools/read/readTarget.ts src/tools/read/readViewPage.ts src/tools/read/readViewSource.ts src/tools/read/rows.tsx src/tools/read/sqliteQuery.ts src/tools/read/sqliteQueryProcess.ts src/tools/record-convention/** src/tools/resume-crewmate/** src/tools/rewind/** src/tools/schedule-wakeup/** src/tools/send-message/** src/tools/service/** src/tools/shell/** src/tools/skill/** src/tools/sleep/SleepTool.tsx src/tools/sleep/prompt.ts src/tools/structure/** src/tools/structured-output/** src/tools/task-create/** src/tools/task-get/** src/tools/task-list/** src/tools/task-stop/** src/tools/task-update/** src/tools/test/** src/tools/testing-permission/** src/tools/tool-search/** src/tools/transaction/** src/tools/unity/** src/tools/video/** src/tools/web-fetch/WebFetchTool.ts src/tools/web-fetch/extractHtml.ts src/tools/web-fetch/fetchContent.ts src/tools/web-fetch/fetchErrors.ts src/tools/web-fetch/fetchPacing.ts src/tools/web-fetch/fetchTransport.ts src/tools/web-fetch/pageAccess.ts src/tools/web-fetch/pageBudget.ts src/tools/web-fetch/preapproved.ts src/tools/web-fetch/privateHost.ts src/tools/web-fetch/prompt.ts src/tools/web-fetch/reader.ts src/tools/web-fetch/robots.ts src/tools/web-fetch/rows.tsx src/tools/web-fetch/structuredHosts.ts src/tools/web-fetch/tableRule.ts src/tools/web-search/** src/tools/write/SqliteDeletePermissionRequest.tsx src/tools/write/WriteTool.ts src/tools/write/call/** src/tools/write/parseCheck.ts src/tools/write/rows.tsx src/tools/write/structuredTargets.ts
# gate-watch: src/platform/network/caCerts.ts src/platform/network/caCertsConfig.ts
# gate-watch: src/boot/entrypoints/init.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 1
dist="$root/dist/mercury.mjs"
fail=0
ok() { echo "  [PASS] $1"; }
bad() { echo "  [FAIL] $1"; fail=1; }

echo "── build-integrity proof + crash-class smoke ──"

if [[ -f "$dist" ]]; then ok "dist/mercury.mjs present"; else
  bad "dist/mercury.mjs missing — run: bun run build.ts"
  echo "❌ build-integrity proofs FAILED"; exit 1
fi

drive_members build 'scripts/build/$name' "$here/members.txt" || fail=1

hits=$(grep -oE "(^|[^A-Za-z0-9_])feature\((['\"])" "$dist" | wc -l | tr -d ' ')
if [[ "$hits" == "0" ]]; then ok "no surviving feature('…') macro call in dist"; else
  bad "$hits surviving feature('…') macro call(s) in dist — the DCE transform missed a site"
  grep -oE "(^|[^A-Za-z0-9_]).{0,20}feature\((['\"])[^)]{0,28}" "$dist" | sort -u | head
fi

if grep -q "shouldIncludeFirstPartyOnlyBetas" "$dist"; then
  bad "experimental-betas fold symbol still in dist"
else
  ok "no experimental-betas fold symbol in dist"
fi

booted_version=$(node "$dist" --version 2>&1)
expected_version="Mercury $(node -p "require('./package.json').version")"
if [[ "$booted_version" == "$expected_version" ]]; then
  ok "BOOTED identity: --version → '$booted_version'"
else
  bad "booted --version printed '$booted_version' — expected '$expected_version'"
fi

CRASH='ReferenceError|is not a function|Uncaught (exception|error)|Cannot read properties of undefined|is not defined'
node_bin="$(command -v node)"
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"; fi
with_deadline() {
  if [[ -n "$TIMEOUT_BIN" ]]; then "$TIMEOUT_BIN" 120 "$@"; else "$@"; fi
}
run_smoke_cmd() {
  local __out_var="$1"; shift
  local __out __rc=0
  __out=$(with_deadline "$@" </dev/null 2>&1) || __rc=$?
  printf -v "$__out_var" '%s' "$__out"
  return "$__rc"
}
smoke() {
  local label="$1"; shift
  local out all="" rc
  for cmd in "--help" "--version" "mcp list"; do
    rc=0
    run_smoke_cmd out env "$@" "$node_bin" "$dist" $cmd || rc=$?
    if [[ "$rc" == "124" ]]; then bad "smoke TIMEOUT ($label): '$cmd' exceeded 120s"; return; fi
    all+="$out"$'\n'
  done
  local hit; hit=$(printf '%s' "$all" | grep -onE "$CRASH" | head -3 | tr '\n' ' ')
  if [[ -z "$hit" ]]; then ok "smoke clean: $label"; else bad "smoke CRASH ($label): $hit"; fi
}
smoke "normal"
smoke "substrate-off"    MERCURY_SUBSTRATE=0
smoke "antisyc+mcdigest" MERCURY_ANTISYC_ALWAYS_ON=1 MERCURY_MC_DIGEST=1
smoke "kill-switch"      MERCURY_KILL=1

fresh_home_smoke() {
  local fh; fh=$(mktemp -d) || { bad "fresh-home smoke: mktemp failed"; return; }
  local out rc
  for cmd in "--help" "--version" "mcp list"; do
    rc=0
    run_smoke_cmd out env HOME="$fh" CI=true TERM=dumb "$node_bin" "$dist" $cmd || rc=$?
    if [[ "$rc" == "124" ]]; then
      bad "smoke TIMEOUT (fresh-home): '$cmd' exceeded 120s on a brand-new HOME (first-run wedge class)"
      rm -rf "$fh"; return
    fi
    local hit; hit=$(printf '%s' "$out" | grep -onE "$CRASH" | head -2 | tr '\n' ' ')
    if [[ -n "$hit" ]]; then
      bad "smoke CRASH (fresh-home): '$cmd' — $hit"
      rm -rf "$fh"; return
    fi
  done
  rm -rf "$fh"
  ok "smoke clean: fresh-home (trio completed on a brand-new HOME under CI=true)"
}
fresh_home_smoke

if [[ "${MERCURY_SMOKE_LIVE:-0}" == "1" ]]; then
  live() { local label="$1"; shift
    local out; out=$(env "$@" "$node_bin" "$dist" run "reply with exactly: OK" --model claude-opus-4-8 </dev/null 2>&1)
    local hit; hit=$(printf '%s' "$out" | grep -onE "$CRASH" | head -2 | tr '\n' ' ')
    if [[ -z "$hit" ]]; then ok "live turn clean: $label"; else bad "live turn CRASH ($label): $hit"; fi
  }
  live "normal"
else
  ok "live run smoke skipped (MERCURY_SMOKE_LIVE=1 to enable turn-time coverage)"
fi

if [[ "$fail" == "0" ]]; then echo "✅ build-integrity proofs pass"; exit 0; else
  echo "❌ build-integrity proofs FAILED"; exit 1
fi
