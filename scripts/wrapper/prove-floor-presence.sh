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
nosrc() {
  if grep -qF -- "$3" "$2"; then echo "  ✗ src PRESENT: $1  (needle: $3)"; fail=1; else echo "  ✓ src absent: $1"; fi
}

echo "############################################################"
echo "# Mercury constitution presence — dist + assembly-seam invariants (#5)"
echo "############################################################"

eq "the identity line"            "You are Mercury, the coding agent working in the operator's terminal." 1
eq "the closing ask sentence"     "ask the smallest direct question and briefly explain what depends on the answer" 1
ge "the honesty line"             "be honest about what you know and what you have done"
eq "no blocker lines remain (the runner reads the run, never two fixed lines)" "RESUME WHEN: <the answer or authorisation that permits progress>" 0
eq "no blocker marker remains"    "BLOCKED ON OPERATOR:" 0
eq "no old identity line remains" "You are Mercury, an expert software engineer working in the operator's terminal" 0
eq "no old identity floor remains" "this command-line coding harness and the agent running in it" 0
eq "no identity tail remains"     "Identity, final word" 0
eq "no wire prefix remains"       "source-built terminal coding harness" 0

src "main-path contract splice"   "$prompts" "getMercuryContractSections"
src "the constitution is the law" "$prompts" "promptReplacementText() : stockLaw"
src "the stock law is the constitution (its headless form only for a run no host attends)" "$prompts" "isUnattendedRun() ? MERCURY_HEADLESS_CONSTITUTION : MERCURY_CONSTITUTION"
src "the stock law falls back to the constitution itself" "$prompts" "const stockLaw = constitution ?? MERCURY_CONSTITUTION"
src "the static group: head, law" "$prompts" "[frozenHead ?? head, law]"
src "bare-path: head and law"     "$prompts" '${head}\n\n${law}'
src "the closing ask in source"   "$wrap"    "ask the smallest direct question and briefly explain what depends on the answer"
nosrc "no blocker lines in source" "$wrap"   "RESUME WHEN:"

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ CONSTITUTION PRESENCE OK"; else echo "# ❌ CONSTITUTION PRESENCE FAILED"; fi
echo "############################################################"
exit "$fail"
