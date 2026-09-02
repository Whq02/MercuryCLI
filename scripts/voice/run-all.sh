#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/voice/** src/commands/speak/** src/commands/voice/** scripts/vendor/build-voice.ts native/voice/** build.ts
# ============================================================================
#  scripts/voice/run-all.sh — the voice-input suite.
#  Pins the one capture owner, the one transcriber owner (the sign-in
#  ledger's order, the API-key slots only), the bounded in-memory take, the
#  wire shapes against a loopback transcriber, the doctor row, and the
#  vendored capture pack's build (cargo present ⇒ the addon loads and a
#  one-second take has the capture shape; absent ⇒ the loud skip). Globs
#  prove-*.ts so new legs auto-join; the suite itself auto-joins the green
#  gate (scripts/run-all-suites.sh globs scripts/*/run-all.sh). The PTY
#  journey on the built bundle lives in the ui suite.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# A proof never touches the operator's OS keychain: every prover and every
# child it boots runs on the file-backed credential store.
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
for f in scripts/voice/prove-*.ts; do
  [ -e "$f" ] || continue
  echo "▶ $f"
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ VOICE SUITE GREEN"; else echo "❌ VOICE SUITE RED"; fi
exit "$fail"
