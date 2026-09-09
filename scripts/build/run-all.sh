#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts bun.lock package.json
# gate-watch: scripts/vendor/**
# gate-watch: src/tools/** src/utils/ripgrep*
# gate-watch: src/utils/gracefulShutdown* src/utils/proxy* src/utils/mtls* src/utils/lockfile* src/utils/caCerts*
# gate-watch: src/entrypoints/cli* src/entrypoints/init*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/proof-runner.sh"
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

run_proof "$root/scripts/build/prove-win32-seam-ratchet.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-win32-seam-ratchet.ts" || fail=1

run_proof "$root/scripts/build/prove-isolated-artifact.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-isolated-artifact.ts" || fail=1

run_proof "$root/scripts/build/prove-boot-crash-surface.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-boot-crash-surface.ts" || fail=1

run_proof "$root/scripts/build/prove-build-search-gate.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-build-search-gate.ts" || fail=1

run_proof "$root/scripts/build/prove-vendor-tar-dialect.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-vendor-tar-dialect.ts" || fail=1

run_proof "$root/scripts/build/prove-image-processor-pack.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-image-processor-pack.ts" || fail=1

run_proof "$root/scripts/build/prove-bundle-neutral-paths.ts" "${BUN:-$HOME/.bun/bin/bun}" run "$root/scripts/build/prove-bundle-neutral-paths.ts" || fail=1

hits=$(grep -oE "(^|[^A-Za-z0-9_])feature\((['\"])" "$dist" | wc -l | tr -d ' ')
if [[ "$hits" == "0" ]]; then ok "no surviving feature('…') macro call in dist"; else
  bad "$hits surviving feature('…') macro call(s) in dist — the DCE transform missed a site"
  grep -oE "(^|[^A-Za-z0-9_]).{0,20}feature\((['\"])[^)]{0,28}" "$dist" | sort -u | head
fi

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

booted_version=$(node "$dist" --version 2>&1)
expected_version="Mercury $(node -p "require('$root/package.json').version")"
if [[ "$booted_version" == "$expected_version" ]]; then
  ok "BOOTED identity: --version → '$booted_version'"
else
  bad "booted --version printed '$booted_version' — expected '$expected_version'"
fi

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
