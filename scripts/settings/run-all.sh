#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/bootstrap/state* src/services/remoteManagedSettings/syncCacheState*
# gate-watch: src/utils/settings/**
# gate-watch: src/components/Settings/** src/services/providers/providerUsage* src/commands/usage/**
# gate-watch: src/services/providers/accountSlots* src/components/mercury-ui/parity/AccountView*
# ============================================================================
#  scripts/settings/run-all.sh — the settings/configuration proof suite.
#  Pins the load→parse→validate→merge→cache→persist pipeline (precedence,
#  merge shapes, Mercury-value validation, invalid-file taxonomy, write
#  semantics, cache isolation), the settings hot-reload journey (the real
#  chokidar watcher: attribution, internal-write suppression, deletion
#  grace, dispose), and the provider-neutral settings surfaces (
#  /config·/usage·/accounts row sets derive from the provider catalogue;
#  the /usage any-provider-credential gate). Globs prove-*.ts so the owned-pipeline oracles
#  auto-join; the suite auto-joins the green gate via
#  scripts/run-all-suites.sh's glob.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# settings — configuration pipeline proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
