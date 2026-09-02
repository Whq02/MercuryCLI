#!/usr/bin/env bash
# ============================================================================
#  scripts/wrapper/prove-floor-presence.sh — the stamp-independent FLOOR-PRESENCE
#  proof (#5, cycle-1 hardening).
#
#  The always-on identity + honesty/safety FLOOR (MERCURY_IDENTITY_FLOOR) is
#  unconditional; a regression that
#  drops the splice would still evaporate it with ZERO runtime signal. This asserts the floor (and its #13 precedence tie-break)
#  actually LAND in the built dist (feature() folded, the splice
#  live-true for THIS dist), and that the assembly SEAMS are structurally intact.
#
#  Floor CONTENT byte-equality is owned by scripts/substrate/prove-wrapper.ts;
#  this is PRESENCE + the assembly seams (#11 simple-path, #9 conditional
#  reconcile), NOT a re-prove of the text. Pure grep — requires a build first
#  (mirrors scripts/identity/prove-dist-invariants.sh). Invoked by run-all.sh.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
dist="$root/dist/mercury.mjs"
prompts="$root/src/constants/prompts.ts"
wrap="$root/src/prompt/mercuryContract.ts"
fail=0

if [ ! -f "$dist" ]; then
  echo "  ✗ dist/mercury.mjs not found — run: ~/.bun/bin/bun run build.ts"
  exit 1
fi

# eq LABEL NEEDLE N — exactly N occurrences of the literal in the built dist.
eq() {
  local n; n=$(grep -c -- "$2" "$dist" 2>/dev/null || true)
  if [ "$n" = "$3" ]; then echo "  ✓ dist x$3: $1"; else echo "  ✗ dist x$n (want $3): $1"; fail=1; fi
}
# ge LABEL NEEDLE — at least one occurrence in the built dist.
ge() {
  local n; n=$(grep -c -- "$2" "$dist" 2>/dev/null || true)
  if [ "$n" -ge 1 ]; then echo "  ✓ dist present: $1"; else echo "  ✗ dist MISSING: $1"; fail=1; fi
}
# src LABEL FILE NEEDLE — a structural assertion against the source.
src() {
  if grep -qF -- "$3" "$2"; then echo "  ✓ src: $1"; else echo "  ✗ src MISSING: $1  (needle: $3)"; fail=1; fi
}

echo "############################################################"
echo "# Mercury FLOOR presence — dist + assembly-seam invariants (#5)"
echo "############################################################"

# (i) dist-grep — the floor + its #13 precedence tie-break LAND in the stamped dist.
eq "floor identity line"         "this command-line coding harness and the agent running in it" 1
eq "floor precedence tie-break"  "safety and honesty first, then the operator" 1
ge "floor harm-bound clause"     "bypass a real safety, permission, or"
ge "identity reconcile (tail)"   "Identity, final word"
# The dropped proactive/assistant early-return is feature()-DCE'd — it must NEVER ship.
eq "proactive branch absent"     "You are an autonomous agent" 0

# (ii) structural source — the assembly seams around the floor splice.
src "main-path contract splice"  "$prompts" "getMercuryContractSections"
src "simple-path floor fallback" "$prompts" "MERCURY_IDENTITY_FLOOR"
src "#9 conditional reconcile"   "$prompts" "modeSections.length > 0"
src "#11 simple-path floor head" "$prompts" "simpleHead"
src "floor precedence in source" "$wrap"    "safety and honesty first, then the operator"

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ FLOOR PRESENCE OK"; else echo "# ❌ FLOOR PRESENCE FAILED"; fi
echo "############################################################"
exit "$fail"
