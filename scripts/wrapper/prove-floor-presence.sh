#!/usr/bin/env bash
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

eq() {
  local n; n=$(grep -c -- "$2" "$dist" 2>/dev/null || true)
  if [ "$n" = "$3" ]; then echo "  ✓ dist x$3: $1"; else echo "  ✗ dist x$n (want $3): $1"; fail=1; fi
}
ge() {
  local n; n=$(grep -c -- "$2" "$dist" 2>/dev/null || true)
  if [ "$n" -ge 1 ]; then echo "  ✓ dist present: $1"; else echo "  ✗ dist MISSING: $1"; fail=1; fi
}
src() {
  if grep -qF -- "$3" "$2"; then echo "  ✓ src: $1"; else echo "  ✗ src MISSING: $1  (needle: $3)"; fail=1; fi
}

echo "############################################################"
echo "# Mercury FLOOR presence — dist + assembly-seam invariants (#5)"
echo "############################################################"

eq "floor identity line"         "this command-line coding harness and the agent running in it" 1
eq "floor precedence tie-break"  "safety and honesty first, then the operator" 1
ge "floor harm-bound clause"     "bypass a real safety, permission, or"
ge "identity reconcile (tail)"   "Identity, final word"
eq "proactive branch absent"     "You are an autonomous agent" 0

src "main-path contract splice"  "$prompts" "getMercuryContractSections"
src "simple-path floor fallback" "$prompts" "MERCURY_IDENTITY_FLOOR"
src "#9 conditional reconcile"   "$prompts" "modeSections.length > 0"
src "#11 simple-path floor head" "$prompts" "simpleHead"
src "floor precedence in source" "$wrap"    "safety and honesty first, then the operator"

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ FLOOR PRESENCE OK"; else echo "# ❌ FLOOR PRESENCE FAILED"; fi
echo "############################################################"
exit "$fail"
