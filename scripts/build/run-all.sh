#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts bun.lock package.json
# gate-watch: scripts/vendor/**
# gate-watch: src/tools/** src/utils/ripgrep*
# gate-watch: src/utils/gracefulShutdown* src/utils/proxy* src/utils/mtls* src/utils/lockfile* src/utils/caCerts*
# gate-watch: src/entrypoints/cli* src/entrypoints/init*
# scripts/build/run-all.sh — build-integrity proof + crash-class regression gate.
#
# There is NO feature() macro and NO onLoad transform — check 1 below proves
# that STAYS total (a
# surviving feature('…') call in dist would be a regression reintroducing the
# ReferenceError class, a real past bug — BUILD-NOTES.md). It also asserts
# the experimental-betas kill-switch + fork VERSION are baked in.
#
# PLUS (the "feels like beta" friction):
# a multi-mode RUNTIME smoke that is the execution ORACLE for the crash class the
# 20+ unit suites structurally cannot catch — "ReferenceError: feature is not
# defined" and "<min> is not a function" (a lazy require of a DCE'd-only symbol,
# e.g. `z is not a function`). These produce ZERO build/bundle
# error (the Bun DCE footguns strip a binding silently) and pass every suite that
# imports a module directly — they only surface when the real binary runs an
# entry path. So we RUN it across fork modes. "Bundled successfully" is NOT proof
# of liveness; the bundle is the oracle.
#
# Always-on part is OFFLINE + credential-free. MERCURY_SMOKE_LIVE=1 adds real -p
# turns for turn-time crash coverage. Checks the COMMITTED dist (the gate runs
# post-build); auto-joins the green-gate via the scripts/*/run-all.sh glob.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 1
dist="$root/dist/mercury.mjs"
fail=0
ok() { echo "  [PASS] $1"; }
bad() { echo "  [FAIL] $1"; fail=1; }

echo "── build-integrity proof + crash-class smoke ──"

if [[ -f "$dist" ]]; then ok "dist/mercury.mjs present"; else
  bad "dist/mercury.mjs missing — run: bun run build.ts"
  echo "❌ build-integrity proofs FAILED"; exit 1
fi

# 0. The win32-seam ratchet (the WINDOWS standing audit) — POSIX tells frozen
#    per-file; fails the suite the moment new unbranched POSIX idiom lands.
"${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-win32-seam-ratchet.ts" || fail=1

# 0.2 SELF-CONTAINED ARTIFACT (Sol 5.6 WS1): the bundle runs from an isolated
#     temp dir on stock node (no node_modules anywhere), the manifest tells
#     the truth, and the join-kit completes a real local join round trip.
"${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-isolated-artifact.ts" || fail=1

# 0.25 BOOT CRASH SURFACE: a module the artifact cannot load fails
#      the boot LOUD (card + exit 1) instead of idling on a blank screen, and
#      no runtime-require shape can strand the deployed runtime.
"${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-boot-crash-surface.ts" || fail=1

# 0.3 SEARCH GATE: a build that cannot vendor rg FAILS (no silent BUILD OK);
#     the degraded opt-in is loud + manifest-recorded; the runtime catalog
#     agrees with the real binary state (suppresses + self-heals Glob/Grep).
"${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-build-search-gate.ts" || fail=1

# 0.4 VENDOR TAR DIALECT (the cross-box field root E008-01/TASK-018): the
#     fetch scripts extract through ONE colon-free relative invocation, so
#     GNU tar's host:path parsing can never abort a Windows fetch and the
#     build never ships silently degraded by PATH order.
"${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-vendor-tar-dialect.ts" || fail=1

# 1. No surviving feature('FLAG') MACRO call: every call is folded at SOURCE
#    (there is no transform), so a survivor means a raw macro call crept back
#    in (the ReferenceError class). Matches ANY quoted
#    arg — `feature` is a free/global identifier the bundler can't rename, and
#    GrowthBook's SDK method is `.feature(VAR)` (dotted, variable arg), which
#    does NOT match `feature('`. The macro is a BARE identifier, so require a
#    non-word char (or line start) before it — this excludes bundled foreign
#    code whose own APIs contain the substring, e.g. Godot GDScript's
#    `OS.has_feature("editor")` in the VULCAN addon (a `_feature("` false
#    positive). Portable char-class boundary (BSD + GNU grep; no \b).
hits=$(grep -oE "(^|[^A-Za-z0-9_])feature\((['\"])" "$dist" | wc -l | tr -d ' ')
if [[ "$hits" == "0" ]]; then ok "no surviving feature('…') macro call in dist"; else
  bad "$hits surviving feature('…') macro call(s) in dist — the DCE transform missed a site"
  grep -oE "(^|[^A-Za-z0-9_]).{0,20}feature\((['\"])[^)]{0,28}" "$dist" | sort -u | head
fi

# 2. The load-bearing experimental-betas kill is baked at SOURCE: the fold
#    symbol ships, and the retired env spelling is gone from the bundle
#    (needle composed so this script never matches itself). The folded-FALSE
#    semantic is proven functionally by core-runtime's LAW BETA-GUARD.
cc_betas="CLAUDE_""CODE_DISABLE_EXPERIMENTAL_BETAS"
if grep -q "shouldIncludeFirstPartyOnlyBetas" "$dist"; then
  ok "experimental-betas source fold present"
else
  bad "experimental-betas source fold not found in dist"
fi
if grep -q "$cc_betas" "$dist"; then
  bad "retired env spelling $cc_betas resurfaced in dist"
else
  ok "retired experimental-betas env spelling absent from dist"
fi

# 3. BOOTED Mercury identity:
#    run the built binary and read its banner — never a bundle substring grep
booted_version=$(node "$dist" --version 2>&1)
# ONE ROOT since mercury-feel: package.json is the version authority
# (product.ts re-exports the MACRO.VERSION define with a src-run fallback).
expected_version="Mercury $(node -p "require('$root/package.json').version")"
if [[ "$booted_version" == "$expected_version" ]]; then
  ok "BOOTED identity: --version → '$booted_version'"
else
  bad "booted --version printed '$booted_version' — expected '$expected_version'"
fi

# 4. Multi-mode RUNTIME smoke — the execution oracle (offline, credential-free).
#    Runs the audited crash entry paths (--help/--version/mcp-list = startup +
#    command-registry + identity + substrate init) across fork modes; asserts no
#    crash signature. HANG ⇒ LOUD FAIL, never a wedge (mercury-feel,
# each command gets a 120s deadline where a timeout binary
#    exists (coreutils on Linux CI / brew gtimeout) — release run 29166517583
#    sat >20 min inside this very smoke on the fresh-HOME `mcp list` hang.
#    Stock macOS has neither binary; local hangs stay interactive-visible.
CRASH='ReferenceError|is not a function|Uncaught (exception|error)|Cannot read properties of undefined|is not defined'
node_bin="$(command -v node)"
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"; fi
with_deadline() { # cmd...
  if [[ -n "$TIMEOUT_BIN" ]]; then "$TIMEOUT_BIN" 120 "$@"; else "$@"; fi
}
run_smoke_cmd() { # outvar  env-and-cmd...
  local __out_var="$1"; shift
  local __out __rc=0
  __out=$(with_deadline "$@" </dev/null 2>&1) || __rc=$?
  printf -v "$__out_var" '%s' "$__out"
  return "$__rc"
}
smoke() { # label  env...
  local label="$1"; shift
  local out all="" rc
  for cmd in "--help" "--version" "mcp list"; do
    rc=0
    # shellcheck disable=SC2086 -- fixed two-word-max literals
    run_smoke_cmd out env "$@" "$node_bin" "$dist" $cmd || rc=$?
    if [[ "$rc" == "124" ]]; then bad "smoke TIMEOUT ($label): '$cmd' exceeded 120s"; return; fi
    all+="$out"$'\n'
  done
  local hit; hit=$(printf '%s' "$all" | grep -onE "$CRASH" | head -3 | tr '\n' ' ')
  if [[ -z "$hit" ]]; then ok "smoke clean: $label"; else bad "smoke CRASH ($label): $hit"; fi
}
smoke "normal"
smoke "substrate-off"    MERCURY_SUBSTRATE=0
smoke "antisyc+mcdigest" MERCURY_ANTISYC_ALWAYS_ON=1 MERCURY_MC_DIGEST=1
smoke "kill-switch"      MERCURY_KILL=1

# 4b. FRESH-HOME smoke: the first-run bug class an
# operator HOME can never catch — a brand-new HOME + CI=true must complete
# the trio. The fresh-HOME `mcp list` hang (a boot migration calling a
# THROWING auth probe under CI, the preAction rejection swallowed, the
# process wedged silently) shipped past every suite precisely because no
# leg ever ran without an existing HOME.
fresh_home_smoke() {
  local fh; fh=$(mktemp -d) || { bad "fresh-home smoke: mktemp failed"; return; }
  local out rc
  for cmd in "--help" "--version" "mcp list"; do
    rc=0
    # shellcheck disable=SC2086 -- fixed two-word-max literals
    run_smoke_cmd out env HOME="$fh" CI=true TERM=dumb "$node_bin" "$dist" $cmd || rc=$?
    if [[ "$rc" == "124" ]]; then
      bad "smoke TIMEOUT (fresh-home): '$cmd' exceeded 120s on a brand-new HOME (first-run wedge class)"
      rm -rf "$fh"; return
    fi
    local hit; hit=$(printf '%s' "$out" | grep -onE "$CRASH" | head -2 | tr '\n' ' ')
    if [[ -n "$hit" ]]; then
      bad "smoke CRASH (fresh-home): '$cmd' — $hit"
      rm -rf "$fh"; return
    fi
  done
  rm -rf "$fh"
  ok "smoke clean: fresh-home (trio completed on a brand-new HOME under CI=true)"
}
fresh_home_smoke

# 5. Opt-in LIVE turn smoke (-p) for turn-time crashes (needs auth; costs tokens).
if [[ "${MERCURY_SMOKE_LIVE:-0}" == "1" ]]; then
  live() { local label="$1"; shift
    local out; out=$(env "$@" "$node_bin" "$dist" -p "reply with exactly: OK" --model claude-opus-4-8 </dev/null 2>&1)
    local hit; hit=$(printf '%s' "$out" | grep -onE "$CRASH" | head -2 | tr '\n' ' ')
    if [[ -z "$hit" ]]; then ok "live turn clean: $label"; else bad "live turn CRASH ($label): $hit"; fi
  }
  live "normal"
else
  ok "live -p smoke skipped (MERCURY_SMOKE_LIVE=1 to enable turn-time coverage)"
fi

if [[ "$fail" == "0" ]]; then echo "✅ build-integrity proofs pass"; exit 0; else
  echo "❌ build-integrity proofs FAILED"; exit 1
fi
