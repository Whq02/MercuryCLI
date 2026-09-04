#!/usr/bin/env bash
# ============================================================================
#  prove-dist-invariants — the built artifact carries Mercury's identity and
#  no other product's.
#
#  Most identity surfaces are not bun-unit-testable (Ink/OTEL graphs), so this
#  script makes the dist-grep verification REPEATABLE against a freshly built
#  dist/mercury.mjs: (a) the Mercury-identity strings shipped, and (b) external
#  product references are absent or bounded to enumerated wire identifiers and
#  service endpoints, each with its reason beside the bound. Pure dist-grep —
#  requires a build first. Needles for the other product's name are composed
#  from parts so this file never matches itself.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../../dist/mercury.mjs"
fail=0

if [ ! -f "$dist" ]; then
  echo "✗ dist/mercury.mjs not found — run: ~/.bun/bin/bun run build.ts"
  exit 1
fi

# The other product's name, composed so this script never matches itself.
foreign_slug="claude""-code"
cc_spaced="Claude"" Code"

# present LABEL NEEDLE — assert the Mercury-identity string shipped (count >= 1)
present() {
  local n; n=$(grep -c -- "$2" "$dist" 2>/dev/null)
  if [ "$n" -ge 1 ]; then echo "  ✓ present: $1"; else echo "  ✗ MISSING: $1  (needle: $2)"; fail=1; fi
}
# bounded LABEL NEEDLE MAX — assert an external reference is absent/bounded (count <= MAX)
bounded() {
  local n; n=$(grep -c -- "$2" "$dist" 2>/dev/null)
  if [ "$n" -le "$3" ]; then echo "  ✓ bounded ($n<=$3): $1"; else echo "  ✗ OVER ($n>$3): $1  (needle: $2)"; fail=1; fi
}

echo "============================================================"
echo " Mercury dist invariants — identity shipped, nothing borrowed"
echo "============================================================"

echo "[1] Mercury-identity strings shipped"
present "health self-recognition"        "Mercury source build"
present "health install-provenance row" "install-provenance"
present "health install guidance (managed)" 'update with `mercury update`'
present "health search fallback honesty" "Mercury vendored ripgrep unavailable"
present "system-prompt feedback → /feedback" "report the issue with /feedback"
present "self-adopt install verb (user-local)" "Install this extracted release archive user-locally"
present "uninstall preserves user state" "uninstalling never deletes user state"
present "spinner continue tip"           "mercury --continue"
present "release-notes fallback"         "No bundled release notes in this build"
present "bundled Mercury changelog"      "this bundled changelog is the only source"
present "rate-limit Mercury upsell"      "raise your Claude plan limits"
present "feedback title prompt (Mercury)" "bug report for Mercury"

echo "[2] no other product's name in shipped copy (wire identifiers enumerated)"
# The spaced display spelling ships as the keychain service identifier plus
# the foreign-writer recognizer's attribution label (knownAgentClis.ts names
# the external product it detects by that product's own display name)
# (one template literal in macOsKeychainHelpers; the keychain is where the
# credential lives, so Mercury must spell the service name to read it).
bounded "display spelling (keychain identifier + the foreign-writer attribution label)" "$cc_spaced" 2
# The hyphenated identifier family ships only as wire identifiers: OAuth app
# ids + client-metadata URL, the API beta header, the API user agents, the
# settings-schema URL, the JetBrains plugin dir, marketplace ids, the
# plugin-mirror GCS path, hint-protocol tags, the keychain account, the
# GitHub-Action path marker, and the foreign-daemon detection pattern.
bounded "hyphenated wire identifiers"    "$foreign_slug" 40
# No repository or product URL for the other product ships at all.
bounded "external repo issues URL"       "github.com/anthropics/$foreign_slug/issues" 0
bounded "external npm package URL"       "npmjs.com/package/@anthropic-ai/$foreign_slug" 0
bounded "external native-dist bucket"    "storage.googleapis.com/$foreign_slug-dist" 0
bounded "external product page URL"      "claude.com/$foreign_slug" 0
bounded "external docs links"            "code.claude.com/docs" 0
present "Mercury repo as the package origin" "github.com/Whq02/MercuryCLI"

echo "[3] one version root + unlinked attribution"
mercury_version=$(python3 -c "import json;print(json.load(open('$here/../../package.json'))['version'])")
present "version root folded into dist"  "${mercury_version}"
# Mercury commit/PR attribution links the PRODUCT site: the PR line carries
# mercury-cli.ai; no foreign product URL anywhere. The un-suffixed linked form
# is RETIRED (nothing composes it) — pinned absent.
present "Mercury attribution (linked, product site)" "Generated with \\[Mercury CLI\\](https://mercury-cli.ai)"
bounded "retired linked-attribution spelling (product-site fold)" "Generated with [Mercury](" 0
# Foreign product/docs URL ratchets: Mercury MCP clientInfo carries NO
# borrowed product URL and EVERY Mercury UA is mercury/* — provider wires
# included (utils/http.ts + utils/userAgent.ts own the spellings; borrowed
# agent spellings are retired). The one remaining spelling budget covers
# the arg-path foreign docs link only.
bounded "claude.com/claude-code product URL" "claude.com/claude-code" 1
# Borrowed agent spelling: ZERO budget — every Mercury UA is mercury/*.
# (dist's remaining claude-code mentions live only inside the
# foreign-binary daemon-log detectors, which never compose a UA.)
bounded "claude-cli agent spelling"      "claude-cli" 0
# Zero budget: ANY occurrence means a foreign docs link re-entered rendered
# copy — remove it at the owner instead of bumping this bound.
bounded "code.claude.com docs links"     "code.claude.com/docs" 0
# The provider-apis bundled skill's live-sources.md (Mercury's OWNED
# provider-API reference) deliberately carries the docs root + API-reference
# URLs so the model fetch-verifies volatile facts before citing — ONE file
# (src/skills/bundled/provider-apis/references/live-sources.md). The third is the
# suppressed JetBrains-plugin notice's dead render branch
# (statusNoticeDefinitions — isActive pinned false).
bounded "docs.claude.com links"          "docs.claude.com" 3
# Telemetry endpoint string ships only inside the disabled branch and the
# analytics chokepoint keeps every upload path off.
bounded "telemetry endpoint (disabled branch)" "api/event_logging/batch" 2
# External service consoles (cloud sessions), bounded:
bounded "remote-session console URL"     "claude.ai/code" 4

echo "[4] retired integrations leave zero residue"
# No plugin source or marketplace is ever added without an operator act:
# the other vendor's marketplace mirror host and marketplace ids ship nowhere.
bounded "vendor plugin-marketplace mirror host" "downloads.""claude.ai" 0
bounded "vendor marketplace id (official)"      "claude-plugins-""official" 0
bounded "vendor marketplace id (directory)"     "claude-plugin-""directory" 0
bounded "vendor marketplace org path"           "anthropics/""claude-plugins" 0
# Mercury asks no vendor which MCP servers are "official": the vendor's
# MCP-registry host+path and its versioned path ship nowhere (no boot-time
# prefetch exists; scripts/mcp/prove-no-registry-phonehome.ts drives it).
bounded "vendor MCP registry host+path"         "api.anthropic.com/mcp-""registry" 0
bounded "vendor MCP registry versioned path"    "mcp-""registry/v0" 0
bounded "chrome docs URL"                "code.claude.com/docs/en/chrome" 0
bounded "chrome extension install URL"   "claude.ai/chrome" 0
bounded "chrome shortlinks"              "clau.de/chrome" 0
bounded "in-Chrome copy"                 "Claude in Chrome" 0
bounded "in-Chrome copy (Mercury)"       "Mercury in Chrome" 0
bounded "chrome MCP server name"         "claude-in-chrome" 0
bounded "chrome CLI flag"                "--no-chrome" 0
bounded "chrome native-host route"       "--chrome-native-host" 0
echo "[5] the binary's usage copy names mercury"
bounded "foreign usage line"             "Usage: claude " 0
bounded "foreign 'Run claude' hint"      "Run claude " 0
bounded "foreign 'claude mcp' usage"     "claude mcp " 0
# 'claude --' survives ONLY inside the safe-shell-command classifier allowlist
# (it recognizes the external CLI's help invocation as a safe bash target).
bounded "foreign binary flag strings"    "claude --" 2

echo "============================================================"
if [ "$fail" = "0" ]; then echo " ✅ DIST INVARIANTS HOLD"; else echo " ❌ DIST INVARIANTS VIOLATED"; fi
echo "============================================================"
exit "$fail"
