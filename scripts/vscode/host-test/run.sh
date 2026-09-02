#!/usr/bin/env bash
# The REAL extension-host journey — runs the packaged bridge
# inside an INSTALLED VS Code (never downloads one; downloads are never
# implicit). Exit 3 = named skip when no VS Code exists on this machine.
set -euo pipefail
cd "$(dirname "$0")/../../.."

CODE=""
for candidate in code /usr/local/bin/code /opt/homebrew/bin/code \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  if command -v "$candidate" >/dev/null 2>&1; then CODE="$candidate"; break; fi
done
if [ -z "$CODE" ]; then
  echo "SKIP: no installed VS Code found (the host journey needs one; downloads are never implicit)" >&2
  exit 3
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/mercury-host-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
"$CODE" \
  --extensionDevelopmentPath="$PWD/integrations/vscode" \
  --extensionTestsPath="$PWD/scripts/vscode/host-test/suite.cjs" \
  --user-data-dir="$TMP/user" --extensions-dir="$TMP/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --wait
echo "extension-host journey green"
