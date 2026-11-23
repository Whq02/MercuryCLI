#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts
# gate-watch: *.md **/*.md .github/**
# gate-watch: src/** scripts/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/identity"
fail=0
echo "############################################################"
echo "# Identity suite"
echo "############################################################"

if [ ! -f "dist/mercury.mjs" ]; then
  printf '%s\n' 'identity: dist/mercury.mjs absent; run bun run build.ts before the suite'
  exit 1
fi

echo "## bun proofs"
drive_members identity 'scripts/identity/$name' "$here/members.txt" || fail=1

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL IDENTITY CHECKS PASS"; else echo "# ❌ IDENTITY CHECKS FAILED"; fi
echo "############################################################"
exit "$fail"
