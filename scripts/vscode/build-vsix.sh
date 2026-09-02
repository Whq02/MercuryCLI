#!/usr/bin/env bash
# Build the Mercury VS Code bridge.vsix — a HAND-BUILT zip in
# the stable VSIX layout (no vsce download; the format is a decade-stable
# OPC zip). Sources: integrations/vscode/. Output: dist/mercury-vscode.vsix.
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC=integrations/vscode
OUT=dist/mercury-vscode.vsix
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/mercury-vsix.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

# The extension ships with ONE Mercury build and carries its version: the
# harness version is stamped into the staged manifest, so `mercury editor
# status`, the /ide install arm's up-to-date check and the bridge's own
# version-skew check all read the same number.
VERSION=$(node -p "require('./package.json').version")

mkdir -p "$STAGE/extension"
cp "$SRC/extension.js" "$SRC/README.md" "$SRC/LICENSE.txt" "$STAGE/extension/"
node -e '
const fs = require("node:fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
manifest.version = process.argv[2]
fs.writeFileSync(process.argv[3], JSON.stringify(manifest, null, 2) + "\n")
' "$SRC/package.json" "$VERSION" "$STAGE/extension/package.json"
mkdir -p "$STAGE/extension/media"
cp "$SRC/media/mercury.svg" "$STAGE/extension/media/"

cat > "$STAGE/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="mercury-vscode" Version="$VERSION" Publisher="mercury"/>
    <DisplayName>Mercury</DisplayName>
    <Description xml:space="preserve">Mercury in VS Code over the Agent Client Protocol (thin bridge, no second agent runtime).</Description>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
XML

cat > "$STAGE/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
XML

# Deterministic-friendly zip: fixed mtimes, no extra attrs, sorted walk.
find "$STAGE" -exec touch -t 202601010000 {} +
mkdir -p dist
rm -f "$OUT"
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -X -q -r -o "$OLDPWD/$OUT" "[Content_Types].xml" extension.vsixmanifest extension)
else
  # Windows runners' Git Bash ships unzip but NOT zip(1); 7-Zip is on the
  # image and Git Bash path-converts /c/… arguments for native exes.
  (cd "$STAGE" && 7z a -tzip -bso0 -bsp0 "$OLDPWD/$OUT" "[Content_Types].xml" extension.vsixmanifest extension >/dev/null)
fi
echo "built $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
