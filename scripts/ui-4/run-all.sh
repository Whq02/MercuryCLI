#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/ui/** scripts/ui-4/**
# gate-watch: src/bootstrap/state* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useLayoutTier* src/ink/**
# gate-watch: src/services/run/** src/state/AppState* src/utils/**
# The UI estate, sub-suite N of the ruled split: the provers LIVE
# in scripts/ui/ — this runner executes exactly the members named in
# members.txt so no single suite can wedge a CI shard past the hang law's
# ceiling. New provers join the PARENT suite automatically (the complement
# runner); the render-*.ts/.tsx pixel proofs stay the parent's UI_RENDER=1
# opt-in arm. Membership moves only by editing member lists.
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui-4"

fail=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/ui/$name"
  if [ ! -e "$f" ]; then
    echo "❌ ui-4: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done < "$here/members.txt"

if [ "$fail" -eq 0 ]; then echo "✅ UI-4 SUITE GREEN"; else echo "❌ UI-4 SUITE RED"; fi
exit "$fail"
