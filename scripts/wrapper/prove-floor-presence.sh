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
echo "# Mercury constitution presence — dist + assembly-seam invariants (#5)"
echo "############################################################"

eq "the identity line"            "You are Mercury, an expert software engineer working in the operator's terminal, with an IDE's tools beside the shell." 1
eq "the blocker lines"            "RESUME WHEN: <the answer or authorisation that permits progress>" 1
ge "the honesty line"             "without jargon, and never mislead."
eq "no old identity floor remains" "this command-line coding harness and the agent running in it" 0
eq "no identity tail remains"     "Identity, final word" 0
eq "no wire prefix remains"       "source-built terminal coding harness" 0

src "main-path contract splice"   "$prompts" "getMercuryContractSections"
src "the constitution is the law" "$prompts" "promptReplacementText() : MERCURY_CONSTITUTION"
src "the static group: head, law" "$prompts" "[frozenHead ?? head, law]"
src "bare-path: head and law"     "$prompts" '${head}\n\n${law}'
src "the blocker lines in source" "$wrap"    "RESUME WHEN: <the answer or authorisation that permits progress>"

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ CONSTITUTION PRESENCE OK"; else echo "# ❌ CONSTITUTION PRESENCE FAILED"; fi
echo "############################################################"
exit "$fail"
