#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
fail=0
pass() { echo "  [PASS] $1"; }
red() { echo "  [FAIL] $1${2:+ — $2}"; fail=1; }
check() { if [ "$2" = 0 ]; then pass "$1"; else red "$1" "${3:-}"; fi; }

scratch="$(mktemp -d "${TMPDIR:-/tmp}/suite-env-guard.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/scripts/lib" "$scratch/scripts/synth" "$scratch/home"
cp "$root/scripts/lib/suite-env.sh" "$scratch/scripts/lib/suite-env.sh"
if [ "${MERCURY_PROOF_POISON_GUARD:-}" = "1" ]; then
  sed -i.bak 's/^  \[ "${MERCURY_SUITE_ENV:-}" = "any" \] && return 0$/  return 0/' "$scratch/scripts/lib/suite-env.sh" && rm -f "$scratch/scripts/lib/suite-env.sh.bak"
fi
cat >"$scratch/scripts/synth/run-all.sh" <<'EOF'
#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_SYNTH_KNOB
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
echo "SYNTH RAN"
EOF
printf '# MERCURY_SYNTH_KNOB MERCURY_SEATS MERCURY_GODOT_TOOLS\n' >"$scratch/scripts/synth/prove-knob.sh"
runner="$scratch/scripts/synth/run-all.sh"
clean() { env -i PATH="$PATH" HOME="$scratch/home" "$@"; }

echo "── the synthetic runner"
out="$(clean MERCURY_SEATS=2 MERCURY_GODOT_TOOLS=1 MERCURY_OAUTH_TOKEN=fixture-do-not-disclose bash "$runner" 2>&1)"; rc=$?
check "a foreign value refuses the runner with exit 78" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc"
check "…naming every foreign variable without its value" "$(case "$out" in *"MERCURY_GODOT_TOOLS"*"MERCURY_OAUTH_TOKEN"*"MERCURY_SEATS"*) echo 0;; *) echo 1;; esac)" "$out"
check "…never disclosing credential values" "$(case "$out" in *fixture-do-not-disclose*) echo 1;; *) echo 0;; esac)"
check "…before any proof ran" "$(case "$out" in *"SYNTH RAN"*) echo 1;; *) echo 0;; esac)"
check "…and the line says how to run deliberately" "$(case "$out" in *"MERCURY_SUITE_ENV=any"*) echo 0;; *) echo 1;; esac)"

out="$(clean MERCURY_CONFIG_DIR="$scratch/home" MERCURY_HOME="$scratch/home" MERCURY_CREDENTIAL_STORE=file MERCURY_GATE_PREBUILT=1 MERCURY_GATE_CORES=2 MERCURY_SUITE_TIMEOUT=3000 MERCURY_CI_SHARD_OUT="$scratch/out" MERCURY_VSHOT_BUDGET_SCALE=3 MERCURY_OPENAI_API_BASE=http://127.0.0.1:1 MERCURY_CUSTOM_OAUTH_URL=http://127.0.0.1:1 MERCURY_UPDATE_API_BASE_URL=http://127.0.0.1:1 MERCURY_DAEMON_DIR="$scratch/home" bash "$runner" 2>&1)"; rc=$?
check "the pool's own environment line runs the suite" "$([ "$rc" = 0 ] && case "$out" in *"SYNTH RAN"*) echo 0;; *) echo 1;; esac || echo 1)" "rc=$rc $out"

out="$(clean MERCURY_SYNTH_KNOB=1 bash "$runner" 2>&1)"; rc=$?
check "an explicitly declared input runs the suite" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc $out"

out="$(clean MERCURY_SEATS=2 MERCURY_GODOT_TOOLS=1 bash "$runner" 2>&1)"; rc=$?
check "a proof merely naming stamps does not exempt them" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc $out"
check "both mentioned stamps are named in the refusal" "$(case "$out" in *MERCURY_GODOT_TOOLS*MERCURY_SEATS*) echo 0;; *) echo 1;; esac)" "$out"
out="$(clean MERCURY_SYNTH_KNOB_EXTRA=1 bash "$runner" 2>&1)"; rc=$?
check "a declaration matches a complete name, not a prefix" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc $out"

for suite in bash gate substrate headless staleness core-runtime; do
  out="$(clean MERCURY_SEATS=2 MERCURY_GODOT_TOOLS=1 bash -c '. "$1"; suite_env_guard "$2"' _ "$root/scripts/lib/suite-env.sh" "$root/scripts/$suite/run-all.sh" 2>&1)"; rc=$?
  check "$suite refuses stamps mentioned in its proofs" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc $out"
done

printf '# gate-env: MERCURY_BODY_ONLY\n' >>"$runner"
out="$(clean MERCURY_BODY_ONLY=1 bash "$runner" 2>&1)"; rc=$?
check "a declaration after executable code cannot authorize an input" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc $out"
printf '#!/usr/bin/env bash\n# gate-env: MERCURY_*\n' >"$scratch/scripts/synth/invalid.sh"
out="$(clean bash -c '. "$1"; suite_env_guard "$2"' _ "$root/scripts/lib/suite-env.sh" "$scratch/scripts/synth/invalid.sh" 2>&1)"; rc=$?
check "wildcard declarations refuse rather than widening inheritance" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc $out"
out="$(clean MERCURY_SHELL_ENGINE=system bash -c '. "$1"; suite_env_guard "$2"' _ "$root/scripts/lib/suite-env.sh" "$root/scripts/bash/run-all.sh" 2>&1)"; rc=$?
check "the Bash runner explicitly admits its engine selection" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc $out"

out="$(clean MERCURY_SEATS=2 MERCURY_SUITE_ENV=any bash "$runner" 2>&1)"; rc=$?
check "MERCURY_SUITE_ENV=any runs the suite deliberately under a foreign value" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc $out"

out="$(clean bash "$runner" 2>&1)"; rc=$?
check "an environment with no MERCURY_* at all runs" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc $out"

echo "── a real runner"
out="$(clean MERCURY_SEATS=2 bash "$root/scripts/substrate/run-all.sh" 2>&1)"; rc=$?
check "scripts/substrate/run-all.sh refuses MERCURY_SEATS=2 at once (exit 78)" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc"
check "…naming it" "$(case "$out" in *"MERCURY_SEATS"*) echo 0;; *) echo 1;; esac)" "$out"

echo "── routed proof inputs"
routed="$root/scripts/switchboard-4-drives"
check "the routed runner owns the reactivation proof" "$(grep -qxF 'prove-reactivate-drive.ts' "$routed/members.txt" && echo 0 || echo 1)"
for input in MERCURY_REACTIVATE_CAPTURE_DIR MERCURY_REACTIVATE_DRIVE_MODEL MERCURY_REACTIVATE_KEEP; do
  out="$(clean "$input=$scratch" bash -c '. "$1"; suite_env_guard "$2"' _ "$root/scripts/lib/suite-env.sh" "$routed/run-all.sh" 2>&1)"; rc=$?
  check "the executing runner admits $input" "$([ "$rc" = 0 ] && echo 0 || echo 1)" "rc=$rc $out"
done
out="$(clean MERCURY_REACTIVATE_KEEP=1 MERCURY_SEATS=2 MERCURY_GODOT_TOOLS=1 bash -c '. "$1"; suite_env_guard "$2"' _ "$root/scripts/lib/suite-env.sh" "$routed/run-all.sh" 2>&1)"; rc=$?
check "routed declarations do not admit session stamps" "$([ "$rc" = 78 ] && echo 0 || echo 1)" "rc=$rc $out"

echo "── the census"
missing=""
for r in "$root"/scripts/*/run-all.sh; do
  if ! awk 'found && /^\. "\$\(dirname "\$0"\)\/\.\.\/lib\/suite-env\.sh" \|\| exit 78; suite_env_guard "\$0"$/ {ok=1; exit} /^set -/ {found=1; next} found {exit} END {exit !ok}' "$r"; then
    missing="$missing ${r#"$root"/}"
  fi
done
check "every scripts/*/run-all.sh sources the guard right after its set line" "$([ -z "$missing" ] && echo 0 || echo 1)" "$missing"
n=$(ls "$root"/scripts/*/run-all.sh | wc -l | tr -d ' ')
check "the census read the whole estate ($n runners)" "$([ "$n" -gt 100 ] && echo 0 || echo 1)"

if [ "$fail" = 0 ]; then echo "  ALL PASS"; else echo "  FAILED"; fi
exit "$fail"
