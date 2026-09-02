#!/usr/bin/env bash
set -u
fail=0
tmp="$(mktemp -d)"
cd "$tmp" || exit 1
git init -q
git config user.email proof@fable.local
git config user.name fable-proof
git commit -q --allow-empty -m "base" 2>/dev/null
base="$(git rev-parse HEAD)"

echo
echo "=== PROOF 2b — verify && commit: red blocks, green passes ==="
echo

echo "change" > f.txt && git add f.txt
false && git commit -q -m "should NOT land"   # `false` = failing build/test
after_red="$(git rev-parse HEAD)"
if [ "$base" = "$after_red" ]; then
  echo "  [PASS] failing verify (false &&) → commit did NOT run (HEAD unchanged)"
else
  echo "  [FAIL] commit ran despite failing verify"; fail=1
fi

true && git commit -q -m "lands on green"      # `true` = passing build/test
after_green="$(git rev-parse HEAD)"
if [ "$base" != "$after_green" ]; then
  echo "  [PASS] passing verify (true &&) → commit landed (HEAD advanced)"
else
  echo "  [FAIL] commit did not land on green"; fail=1
fi

cd / && rm -rf "$tmp"
echo
if [ "$fail" = "0" ]; then echo "✅ ALL PASS — proof 2b"; else echo "❌ FAILED — proof 2b"; fi
echo
exit "$fail"
