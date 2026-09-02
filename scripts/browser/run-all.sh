#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/browser/** src/tools/BrowserTool/** src/commands/browser/**
# gate-watch: scripts/browser/**
# ============================================================================
#  scripts/browser/run-all.sh — the Browser tool's DRIVING surface.
#
#  Members (globbed — new proofs auto-join):
#    prove-browser-drive.ts      cpu — the driving surface against the REAL
#                            resolved headless engine over LOCAL fixture
#                            origins (in-process 127.0.0.1 servers): the
#                            origin-grant grammar (first visit asks, crossings
#                            re-ask with a bypass-immune safetyCheck, judged
#                            origins travel check-to-act, non-web schemes are
#                            a closed default, reads free, close AND crash
#                            wipe grants), the selector grammar round trip
#                            (aria/text/xpath/pierce), auto-waiting acts with
#                            actionability refusals (hidden/absent/disabled/
#                            covered/wrong-focus), select/press/hover + the
#                            input zoo, the credential zoo + mid-act re-probe,
#                            waitFor visibility states + RAF text waits, the
#                            navigation race + HTTP status truth, dialogs that
#                            can never wedge, the net+console+dialog ring,
#                            popups named + frames diagnosed, viewport +
#                            screenshot budget + extract pager, the engine-
#                            chain rule/bypass legs, the owner rekey (per-
#                            owner sessions/grants, two-owner isolation,
#                            per-owner reap, the children cap + race), and
#                            the reap census.
#                            No drivable browser: SKIP by name locally
#                            (__SUITE_SKIPPED marker), RED under the hosted
#                            gate — a browserless shard is a broken lane.
#    prove-browser-provision.ts  cpu — the provisioning road, hermetic (no
#                            network, no engine): the cache-layout round trip
#                            for EVERY BrowserPlatform derived from the
#                            vendored package's own path math (the arm64
#                            class), the persisted two-step consent token
#                            (expired vs absent), pinned no-network plans,
#                            bad-token refusals, and the structural download-
#                            deny/deadline/remedy teeth.
#    prove-browser-lifecycle.ts  cpu — the child's lifecycle seams, hermetic
#                            (a fixture driver stands in for the engine; the
#                            store, launch body and disposer are real): a
#                            teardown during the launch closes the landing
#                            child and refuses the caller, the relaunch behind
#                            it leaves ONE child, a setup failure after the
#                            spawn closes it, a flight holds a cap slot, close
#                            and the shutdown sweep wait for a landing, the
#                            open op names the teardown, and an operator
#                            interrupt releases the waiter but never the
#                            launch (the slot holds until it lands).
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# browser — the driving surface suite"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  echo ""
  echo "== $name =="
  __t=$SECONDS; if ! "$bun" "$f"; then
    echo "RED: $name"
    fail=1
  fi
  prover_mark "$f" "$__t"
done
exit "$fail"
