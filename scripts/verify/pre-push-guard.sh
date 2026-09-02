#!/usr/bin/env bash
# ============================================================================
#  scripts/verify/pre-push-guard.sh — the edited→pushed rail.
#
#  Until now the rail between "I edited files" and "those files are on main"
#  was operator discipline: no git hooks existed anywhere in the repository.
#  The standing directive forbids hosted checking on every push (paid minutes),
#  so the rail is LOCAL and the operator installs it deliberately:
#
#      git config core.hooksPath .githooks
#
#  Mercury's own safety plane intentionally refuses programmatic changes to
#  git's hooks path. does not change that and adds no exception — manual
#  enablement is the design, not a workaround.
#
#  What it does, in order:
#    1. LEDGER FAST PATH. If the pushed commit's codeTree already carries a
#       green verdict — committed (scripts/gate/gate-ledger.jsonl) or local — the push
#       passes in well under a second. Most pushes take this path.
#    2. Otherwise it verifies the PUSHED REF in a scratch worktree with a
#       scrubbed environment: typecheck, build, generated-file drift, workflow
#       and config validation, and the impact-selected suites that make no paid
#       calls. Never the working tree — machine-local state must not be able to
#       produce a false pass for content that is about to leave this machine.
#    3. An UNCLASSIFIED changed path REFUSES with instructions rather than
#       launching the full pool inside a git hook. A hook is the wrong place to
#       spend half an hour, and a hook that does is a hook people disable.
#
#  Stated plainly, because the guard should not be mistaken for a boundary:
#  git provides --no-verify, and a fresh clone starts with no hooks configured.
#  So THE LEDGER, NOT THE HOOK, IS THE RECORD. Each ledger row carries the
#  commit range it newly covers, which makes any unverified stretch visible at
#  the next hosted dispatch.
#
#  No paid model calls happen here, by construction: the guard runs typecheck,
#  build and local suites only, and never invokes a provider lane.
#
#  Env: MERCURY_PREPUSH_SKIP=1 documents an explicit operator override in the
#  hook's own vocabulary (still recorded as unverified by the ledger).
#
#  --dry-run prints the DECISION for each pushed commit and exits without
#  running the expensive leg. That is the prover's seam and the operator's
#  "what would this do?" — a guard whose decision cannot be inspected cheaply
#  is a guard nobody trusts.
# ============================================================================
set -uo pipefail

repo="$(git rev-parse --show-toplevel)"
cd "$repo" || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

say() { printf 'pre-push: %s\n' "$1" >&2; }

DRY_RUN=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

if [ "${MERCURY_PREPUSH_SKIP:-0}" = "1" ]; then
  say "SKIPPED by MERCURY_PREPUSH_SKIP=1 — the ledger will show this stretch as unverified"
  exit 0
fi

# ── which commits are actually being pushed ─────────────────────────────────
# stdin: <local ref> <local sha> <remote ref> <remote sha>, one line per ref.
targets=()
while read -r _localref localsha _remoteref _remotesha; do
  [ -z "${localsha:-}" ] && continue
  case "$localsha" in
    *[!0]*) targets+=("$localsha") ;;   # all-zero = a branch deletion
  esac
done
# Direct invocation (proofs, an operator running it by hand) checks HEAD.
if [ "${#targets[@]}" -eq 0 ]; then targets=("$(git rev-parse HEAD)"); fi

status=0
for sha in "${targets[@]}"; do
  short="${sha:0:12}"

  # ── 1. the ledger fast path ───────────────────────────────────────────────
  if "$bun" run scripts/gate/ledger.ts check --rev "$sha" >/dev/null 2>&1; then
    echo "decision $short verified-by-ledger"
    say "$short is already covered by a recorded green verdict ✓"
    continue
  fi

  # ── 2. verify the PUSHED REF in a scratch worktree ────────────────────────
  say "$short has no recorded verdict — verifying the pushed ref in a scratch worktree"

  work="$(mktemp -d "${TMPDIR:-/tmp}/mercury-prepush-XXXXXX")"
  tree="$work/tree"
  if ! git worktree add --detach -q "$tree" "$sha"; then
    say "REFUSED — could not create a scratch worktree for $short"
    rm -rf "$work"
    status=1
    continue
  fi
  cleanup() { git worktree remove --force "$tree" >/dev/null 2>&1; rm -rf "$work"; }

  # The impact plan is computed INSIDE the worktree, so it describes the pushed
  # commit rather than the desk. Reading it from the working tree would let
  # uncommitted local files decide the fate of a push that does not contain
  # them — and would make --dry-run report on state that is not being pushed.
  plan="$(cd "$tree" && "$bun" run scripts/verify/fast.ts --plan 2>&1)"
  if printf '%s' "$plan" | grep -q 'UNCLASSIFIED'; then
    echo "decision $short refused-unclassified"
    say "REFUSED — the push contains paths the impact manifest does not classify:"
    printf '%s\n' "$plan" | grep 'UNCLASSIFIED' >&2
    say "declare them with a '# gate-watch:' glob in the owning suite's run-all.sh,"
    say "or run the full pool yourself and record it:"
    say "  bash scripts/run-all-suites.sh && bun run gate:ledger record --kind local \\"
    say "    --verdict \"\$(bash scripts/lib/project-home.sh >/dev/null; echo …)/verdict.json\""
    cleanup
    status=1
    continue
  fi

  echo "decision $short verify-scratch"
  if [ "$DRY_RUN" = "1" ]; then cleanup; continue; fi

  # Env scrub: the scratch worktree must not inherit this shell's experiment state,
  # or the verdict describes the desk rather than the commit.
  (
    cd "$tree" || exit 1
    env -i \
      PATH="$PATH" HOME="$HOME" SHELL="${SHELL:-/bin/bash}" \
      TMPDIR="$work" LANG="${LANG:-en_US.UTF-8}" \
      BUN="$bun" \
      bash -c '
        set -uo pipefail
        fail=0
        bun run typecheck || fail=1
        bun run build.ts >/dev/null || fail=1
        bun run scripts/verify/fast.ts || fail=1
        exit $fail
      '
  )
  rc=$?
  cleanup

  if [ "$rc" -ne 0 ]; then
    say "REFUSED — $short did not verify in the scratch worktree (exit $rc)"
    status=1
  else
    say "$short verified in the scratch worktree ✓"
  fi
done

exit $status
