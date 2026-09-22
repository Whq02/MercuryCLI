#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
fail=0
pass() { echo "  [PASS] $1"; }
red() { echo "  [FAIL] $1${2:+ — $2}"; fail=1; }
check() { if [ "$2" = 0 ]; then pass "$1"; else red "$1" "${3:-}"; fi; }

temp="${TMPDIR:-/tmp}"
scratch="$(mktemp -d "${temp%/}/suite-home-guard.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/home/.mercury" "$scratch/tmp" "$scratch/pinned" "$scratch/lib"
bun="${BUN:-$HOME/.bun/bin/bun}"
guard="$root/scripts/lib/suite-env.sh"
if [ "${MERCURY_PROOF_POISON_GUARD:-}" = "1" ]; then
  grep -v '^  suite_home_guard "\$runner"$' "$guard" >"$scratch/lib/suite-env.sh"
  guard="$scratch/lib/suite-env.sh"
fi
clean() { env -i PATH="$PATH" HOME="$scratch/home" TMPDIR="$scratch/tmp" "$@"; }
probe='. "$1" || exit 78; suite_env_guard "$2"; printf "%s\n" "${MERCURY_CONFIG_DIR:-}"; [ -d "${MERCURY_CONFIG_DIR:-/nonexistent}" ] && echo present; [ -f "${MERCURY_CONFIG_DIR:-/nonexistent}/.mercury.json" ] && echo seeded; grep -qF "\"$3\"" "${MERCURY_CONFIG_DIR:-/nonexistent}/.mercury.json" 2>/dev/null && echo trusts-root; printf "store=%s\n" "${MERCURY_CREDENTIAL_STORE:-}"'
probe_runner() {
  local r="$1"
  shift
  clean "$@" bash -c "$probe" _ "$guard" "$r" "$root" >"$scratch/out" 2>"$scratch/err"
}
first() { sed -n 1p "$scratch/out"; }
under_temp() { case "$1" in "$scratch/tmp/"*) return 0 ;; *) return 1 ;; esac; }
under_own() { case "$1" in "$scratch/home/.mercury"|"$scratch/home/.mercury/"*) return 0 ;; *) return 1 ;; esac; }
own_empty() { [ -z "$(ls -A "$scratch/home/.mercury")" ]; }
temp_empty() { [ -z "$(ls -A "$scratch/tmp")" ]; }
wards="$root/scripts/wards/run-all.sh"

echo "── every runner, the variable unset"
n=0; bad=""; kept=""; silent=""; store_bad=""
for r in "$root"/scripts/*/run-all.sh; do
  n=$((n + 1))
  name="${r#"$root"/scripts/}"; name="${name%/run-all.sh}"
  probe_runner "$r" BUN=/usr/bin/false; rc=$?
  home="$(first)"
  [ "$rc" = 0 ] || bad="$bad $name(rc=$rc)"
  case "$home" in "$scratch/tmp/mercury-suite-home-$name."??????) ;; *) bad="$bad $name" ;; esac
  grep -qx present "$scratch/out" || bad="$bad $name(absent)"
  grep -qx 'store=file' "$scratch/out" || store_bad="$store_bad $name"
  grep -q "^suite $name: " "$scratch/err" || silent="$silent $name"
  [ -n "$home" ] && [ -e "$home" ] && kept="$kept $name"
done
check "every runner's guard exports a fresh config home under the temp root, named for its suite ($n runners)" "$([ -z "$bad" ] && echo 0 || echo 1)" "$bad"
check "…pins the file-backed credential store beside it" "$([ -z "$store_bad" ] && echo 0 || echo 1)" "$store_bad"
check "…says so on one line naming the suite" "$([ -z "$silent" ] && echo 0 || echo 1)" "$silent"
check "…and removes it when the runner exits" "$([ -z "$kept" ] && echo 0 || echo 1)" "$kept"
check "…with nothing under \$HOME/.mercury" "$(own_empty && echo 0 || echo 1)" "$(ls -A "$scratch/home/.mercury" | tr '\n' ' ')"
check "the census read the whole estate ($n runners)" "$([ "$n" -gt 100 ] && echo 0 || echo 1)"

echo "── the scratch home is seeded through the one seeder"
probe_runner "$wards" BUN="$bun"; rc=$?
check "the wards runner's scratch home carries the first-run seed" "$([ "$rc" = 0 ] && grep -qx seeded "$scratch/out" && echo 0 || echo 1)" "rc=$rc $(cat "$scratch/out" "$scratch/err" | tr '\n' ' ')"
check "…trusting the checkout root" "$(grep -qx trusts-root "$scratch/out" && echo 0 || echo 1)"
check "…and the line says it was seeded" "$(grep -q 'seeded for ' "$scratch/err" && echo 0 || echo 1)" "$(cat "$scratch/err")"

echo "── the operator's own home is never a proof home"
for spelling in "$scratch/home/.mercury" "$scratch/home/.mercury/" "$scratch/home/.mercury/sessions"; do
  probe_runner "$wards" BUN=/usr/bin/false MERCURY_CONFIG_DIR="$spelling"; rc=$?
  home="$(first)"
  check "MERCURY_CONFIG_DIR=${spelling#"$scratch"} is replaced by a scratch home" "$([ "$rc" = 0 ] && under_temp "$home" && ! under_own "$home" && echo 0 || echo 1)" "rc=$rc home=$home"
  check "…and the line says the pin named the operator's own home" "$(grep -q "named the operator's own home" "$scratch/err" && echo 0 || echo 1)" "$(cat "$scratch/err")"
done
probe_runner "$wards" BUN=/usr/bin/false MERCURY_HOME="$scratch/home/.mercury"; rc=$?
home="$(first)"
check "MERCURY_HOME alone is no pin: the run still gets a scratch home" "$([ "$rc" = 0 ] && under_temp "$home" && echo 0 || echo 1)" "rc=$rc home=$home"
check "nothing was written under \$HOME/.mercury" "$(own_empty && echo 0 || echo 1)" "$(ls -A "$scratch/home/.mercury" | tr '\n' ' ')"

echo "── a pinned scratch home is kept as it is"
probe_runner "$wards" BUN=/usr/bin/false MERCURY_CONFIG_DIR="$scratch/pinned"; rc=$?
check "the pinned home is exported unchanged" "$([ "$rc" = 0 ] && [ "$(first)" = "$scratch/pinned" ] && echo 0 || echo 1)" "rc=$rc home=$(first)"
check "…the guard prints nothing" "$([ ! -s "$scratch/err" ] && echo 0 || echo 1)" "$(cat "$scratch/err")"
check "…the credential store is left as it was" "$(grep -qx 'store=' "$scratch/out" && echo 0 || echo 1)" "$(grep '^store=' "$scratch/out")"
check "…and no scratch home was made" "$(temp_empty && echo 0 || echo 1)" "$(ls -A "$scratch/tmp" | tr '\n' ' ')"

echo "── the refusal and the escape are unchanged"
probe_runner "$wards" BUN=/usr/bin/false MERCURY_SEATS=2; rc=$?
check "a foreign value still refuses the runner with exit 78" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc"
check "…and the refused run leaves no scratch home behind" "$(temp_empty && echo 0 || echo 1)" "$(ls -A "$scratch/tmp" | tr '\n' ' ')"
probe_runner "$wards" BUN=/usr/bin/false MERCURY_SEATS=2 MERCURY_SUITE_ENV=any; rc=$?
home="$(first)"
check "MERCURY_SUITE_ENV=any runs the suite and still gets a scratch home" "$([ "$rc" = 0 ] && under_temp "$home" && echo 0 || echo 1)" "rc=$rc home=$home"

echo "── a real runner, whole"
clean BUN="$bun" bash "$wards" >"$scratch/wards.log" 2>&1; rc=$?
check "scripts/wards/run-all.sh runs green with no home pinned" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc $(tail -3 "$scratch/wards.log" | tr '\n' ' ')"
check "…its scratch home was announced" "$(grep -q '^suite wards: ' "$scratch/wards.log" && echo 0 || echo 1)"
check "…removed at its exit" "$([ -z "$(ls -d "$scratch"/tmp/mercury-suite-home-wards.* 2>/dev/null)" ] && echo 0 || echo 1)" "$(ls -A "$scratch/tmp" | tr '\n' ' ')"
check "…and nothing under \$HOME/.mercury" "$(own_empty && echo 0 || echo 1)" "$(ls -A "$scratch/home/.mercury" | tr '\n' ' ')"

echo "── the single-proof road: the shared capture driver pins a home at import"
printf "import '%s/scripts/lib/captureDriver.ts'\nconsole.log(process.env.MERCURY_CONFIG_DIR ?? '')\nconsole.log(process.env.MERCURY_CREDENTIAL_STORE ?? '')\n" "$root" >"$scratch/belt.ts"
belt() { (cd "$root" && clean "$@" "$bun" run "$scratch/belt.ts" >"$scratch/out" 2>"$scratch/err"); }
belt; rc=$?
home="$(first)"
check "a proof with no home pinned gets a scratch home under the temp root" "$([ "$rc" = 0 ] && under_temp "$home" && echo 0 || echo 1)" "rc=$rc home=$home $(cat "$scratch/err" | tr '\n' ' ')"
check "…with the file-backed credential store" "$([ "$(sed -n 2p "$scratch/out")" = file ] && echo 0 || echo 1)"
check "…removed at exit" "$([ -n "$home" ] && [ ! -e "$home" ] && echo 0 || echo 1)"
belt MERCURY_CONFIG_DIR="$scratch/home/.mercury"; rc=$?
home="$(first)"
check "a proof pinned to the operator's own home is moved to a scratch home" "$([ "$rc" = 0 ] && under_temp "$home" && ! under_own "$home" && echo 0 || echo 1)" "rc=$rc home=$home"
belt MERCURY_CONFIG_DIR="$scratch/pinned"; rc=$?
check "a proof pinned to a scratch home keeps it" "$([ "$rc" = 0 ] && [ "$(first)" = "$scratch/pinned" ] && echo 0 || echo 1)" "rc=$rc home=$(first)"
check "nothing under \$HOME/.mercury after the single-proof road" "$(own_empty && echo 0 || echo 1)" "$(ls -A "$scratch/home/.mercury" | tr '\n' ' ')"

if [ "$fail" = 0 ]; then echo "  ALL PASS"; else echo "  FAILED"; fi
exit "$fail"
