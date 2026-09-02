#!/usr/bin/env bash
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

targets=()
while read -r _localref localsha _remoteref _remotesha; do
  [ -z "${localsha:-}" ] && continue
  case "$localsha" in
    *[!0]*) targets+=("$localsha") ;;   # all-zero = a branch deletion
  esac
done
if [ "${#targets[@]}" -eq 0 ]; then targets=("$(git rev-parse HEAD)"); fi

status=0
for sha in "${targets[@]}"; do
  short="${sha:0:12}"

  if "$bun" run scripts/gate/ledger.ts check --rev "$sha" >/dev/null 2>&1; then
    echo "decision $short verified-by-ledger"
    say "$short is already covered by a recorded green verdict ✓"
    continue
  fi

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
