#!/usr/bin/env bash
# ============================================================================
# live-repogen.sh — the BILLED live E2E for the DAEDALUS workflow. NOT part of
# run-all.sh (the gate stays API-free): this drives ONE real headless Mercury
# turn on your credentials that launches the daedalus workflow end-to-end —
# architects → CTO → dev lanes (worktrees) → integrator → QA → finalize —
# generating a small real repo in a scratch dir.
#
# OPERATOR-RUN ONLY (the operator-run live-script precedent). Models are YOUR call
# per the standing ask-the-operator rule — both arguments are REQUIRED, there
# are no defaults:
#
#   bash scripts/repo-generation/live-repogen.sh <model> <executorModel>
#   e.g. bash scripts/repo-generation/live-repogen.sh opus sonnet
#
# Cost: one orchestrating turn + ~10-15 subagent turns (4 architects, 2 CTO
# calls, dev/integrator lanes, 2+ QA sweeps). Budget accordingly.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

MODEL="${1:-}"
EXEC_MODEL="${2:-}"
case "$MODEL" in opus|sonnet|fable|fable51) ;; *)
  echo "usage: bash scripts/repo-generation/live-repogen.sh <model> <executorModel>"
  echo "       both REQUIRED, each one of: opus | sonnet | fable | fable51 (the operator picks — no defaults)"
  exit 2 ;;
esac
case "$EXEC_MODEL" in opus|sonnet|fable|fable51) ;; *)
  echo "executorModel '$EXEC_MODEL' invalid — one of: opus | sonnet | fable | fable51"
  exit 2 ;;
esac

dist="$repo/dist/mercury.mjs"
if [ ! -f "$dist" ]; then
  echo "dist/mercury.mjs missing — build first: bun run build.ts"
  exit 2
fi

# PROFILE=tiny (default) | small — the two live E2E profiles.
PROFILE="${PROFILE:-tiny}"
scratch="$(mktemp -d /tmp/daedalus-live.XXXXXX)"
target="$scratch/target-repo"
mkdir -p "$target"
echo "############################################################"
echo "# DAEDALUS live repo generation — BILLED E2E (profile: $PROFILE)"
echo "# target: $target"
echo "# models: model=$MODEL executorModel=$EXEC_MODEL"
echo "############################################################"

# An initialized repo with a baseline commit so lane worktrees can branch.
git -C "$target" init -q -b main
if [ "$PROFILE" = "small" ]; then
cat > "$target/REQUIREMENTS.md" <<'SMALLEOF'
# notekeep — a small note-keeping http service with a client

## Storage module
Notes persist as JSON lines in notes.jsonl; the storage module must expose
append(note) and list() and must never lose a note on concurrent appends.

## Service
An http service module must expose POST /notes (adds) and GET /notes
(lists); invalid bodies must return 400 with a JSON error.

## Client
A command-line client must add and list notes against the service and print
human-readable output.

## Tests
node:test coverage must cover storage append/list and the two endpoints.
SMALLEOF
else
cat > "$target/REQUIREMENTS.md" <<'EOF'
# tinycalc — a minimal calculator CLI

## Core
Provide a calculator core exposing add, sub, mul, div (div refuses division
by zero with a clear error).

## Formatting
Results print as "<expr> = <value>" through a single formatting helper.

## CLI
`node cli.js "2 + 3"` prints the formatted result and exits 0; malformed
input prints a usage line to stderr and exits 1.

## Tests
Ship node:test coverage for the core operations and the formatter.
EOF
fi
git -C "$target" add -A
git -C "$target" -c user.email=daedalus@local -c user.name=daedalus commit -qm 'baseline: requirements'

# One headless turn: the model is instructed to launch the daedalus workflow
# with the operator-chosen models. THEMIS at warn (audit, never deny) is the
# interactive posture; enforce is the lane posture you can flip to later.
#
# Permission posture (two REAL failure modes from the first live run,
# both wedge-classes in headless auto):
#   1. The Workflow tool's launch wants an interactive review ("Review
#      dynamic workflow before running") — headless has no reviewer, so the
#      call is refused. RULE-ALLOWS bypass the ask (and the classifier), so
#      the whole tool surface the run needs is enumerated below.
#   2. The auto-mode classifier rides the SESSION model; a model-availability
#      blip fail-closes every unenumerated call. --model opus pins the
#      orchestrating turn + classifier to a stable tier (any command outside
#      the allowlist still classifies — on opus, not on a blipping default).
# Preview-first: the first launch returns the deterministic preflight
# (size class · roster · spend band) with ZERO agents; accept:true is the
# explicit launch action. The live E2E exercises BOTH: preview, then accept.
prompt="Launch the bundled 'daedalus' workflow via the Workflow tool. FIRST call it WITHOUT accept to get the preflight preview and print it: Workflow({ name: 'daedalus', args: { requirements: <the full text of ./REQUIREMENTS.md>, model: '$MODEL', executorModel: '$EXEC_MODEL' } }). THEN relaunch with the SAME args plus accept: true, wait for completion, and report the final result verbatim as JSON. Read REQUIREMENTS.md yourself first. Do not edit any file outside the workflow."

set -x
cd "$target"
MERCURY_THEMIS=warn MERCURY_DAEDALUS=1 \
  node "$dist" -p "$prompt" --permission-mode flow --model opus \
  --allowedTools 'Workflow' 'Read' 'Glob' 'Grep' 'Write' 'Edit' \
    'Bash(git:*)' 'Bash(node:*)' 'Bash(mkdir:*)' 'Bash(rm:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(echo:*)' 'Bash(cd:*)'
set +x

echo
echo "── verify ─────────────────────────────────────────────────"
fail=0
check() { if [ "$2" -eq 0 ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1"; fail=1; fi }
themis_dir=""; for h in .mercury .claude; do [ -d "$target/$h/themis" ] && themis_dir="$target/$h/themis" && break; done; test -n "$themis_dir" ; check "THEMIS audit rows written" $?
git -C "$target" log --oneline | grep -q "daedalus(" ; check "per-file daedalus(<owner>) commits landed" $?
ls "$target"/*.js >/dev/null 2>&1 || ls "$target"/src/*.js >/dev/null 2>&1 ; check "generated sources exist" $?
git -C "$target" branch --list 'daedalus/*' | grep -q daedalus ; check "lane branches preserved" $?
echo
echo "target repo: $target  (inspect, then rm -rf $scratch)"
echo "audit chain: ${themis_dir:-$target/.mercury/themis}/"
[ "$fail" -eq 0 ] && echo "✅ daedalus live repogen: ALL CHECKS PASS" || { echo "❌ daedalus live repogen: FAILURES"; exit 1; }
