#!/usr/bin/env bash
# gate-class: pty
# (this suite drives the BUILT dist through vshot (real PTY product boots); the class annotation lives on this line: the gate registry parses the header line as the bare class)
# gate-watch: src/extensions/** src/skills/loadSkillsDir* src/utils/hooks/**
# scripts/extensions/run-all.sh — the extensions proof suite.
# Every prover runs in a scratch config home set BEFORE any product import,
# with a scratch cwd, network-free (a local git repository over file://
# stands in for a remote; a loopback fixture stands in for a wire), and
# leaves nothing behind. Auto-joins scripts/run-all-suites.sh via the
# scripts/*/run-all.sh glob; new prove-*.ts files auto-join via the inner glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# extensions — proof suite"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EXTENSIONS PROOFS PASS"; else echo "# ❌ SOME EXTENSIONS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
