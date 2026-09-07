#!/usr/bin/env bash
# gate-class: pure
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
say() { printf '%s\n' "$*"; }
check() { # check <label> <expr-exit-code> (0 = pass)
  if [ "$2" -eq 0 ]; then say "  ✓ $1"; else say "  ✗ $1"; fails=$((fails + 1)); fi
}

say '— launcher contract —'
bash -n "$here/launcher-mercury.sh"; check 'launcher-mercury.sh parses (bash -n)' $?
bash -n "$here/deploy-launcher.sh"; check 'deploy-launcher.sh parses (bash -n)' $?
bash -n "$here/deploy-runtime.sh"; check 'deploy-runtime.sh parses (bash -n)' $?
bash -n "$here/workspace-backup.sh"; check 'workspace-backup.sh parses (bash -n)' $?
bash -n "$here/deploy-backup-agent.sh"; check 'deploy-backup-agent.sh parses (bash -n)' $?

tmphome="$(mktemp -d /tmp/ops-proof-home-XXXXXX)"
trap 'rm -rf "$tmphome" "$fixrepo" 2>/dev/null' EXIT

say '— the backup LaunchAgent derives every path from the ONE config-home owner —'
rendered="$(MERCURY_CONFIG_DIR="$tmphome" bash "$here/deploy-backup-agent.sh" --print)"; rc=$?
[ "$rc" -eq 0 ]; check "--print renders (got $rc)" $?
printf '%s' "$rendered" | grep -q "<string>$tmphome/bin/workspace-backup.sh</string>"; check 'program path is <home>/bin/workspace-backup.sh' $?
n="$(printf '%s' "$rendered" | grep -c "<string>$tmphome/backups/workspace/launchd.log</string>" || true)"
[ "$n" -eq 2 ]; check "stdout + stderr both land in <home>/backups/workspace/launchd.log (got $n)" $?
printf '%s' "$rendered" | grep -q '<string>com.mercury.workspace-backup</string>'; check 'label is com.mercury.workspace-backup' $?
printf '%s' "$rendered" | grep -q '<key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer>'; check 'schedule is daily 04:30' $?
n="$(printf '%s' "$rendered" | grep -c '<string>/' || true)"
[ "$n" -eq 4 ]; check "exactly four path strings, no foreign home (got $n)" $?
[ ! -d "$tmphome/bin" ]; check '--print writes nothing' $?
agents="$tmphome/LaunchAgents"
out="$(MERCURY_CONFIG_DIR="$tmphome" MERCURY_LAUNCH_AGENTS_DIR="$agents" bash "$here/deploy-backup-agent.sh" --no-load 2>&1)"; rc=$?
[ "$rc" -eq 0 ]; check "--no-load stages the install (got $rc)" $?
cmp -s "$here/workspace-backup.sh" "$tmphome/bin/workspace-backup.sh"; check 'deployed workspace-backup.sh is byte-equal to the repo' $?
[ -x "$tmphome/bin/workspace-backup.sh" ]; check 'deployed workspace-backup.sh is executable' $?
cmp -s "$here/lib/mercury-home.sh" "$tmphome/bin/lib/mercury-home.sh"; check 'deployed lib/mercury-home.sh is byte-equal to the repo' $?
[ "$(cat "$agents/com.mercury.workspace-backup.plist")" = "$rendered" ]; check 'the written plist is the rendered plist' $?
[ -d "$tmphome/backups/workspace" ]; check 'the log directory exists before launchd needs it' $?
printf '%s' "$out" | grep -q 'not loaded'; check '--no-load says so' $?
if command -v plutil >/dev/null 2>&1; then
  plutil -lint -s "$agents/com.mercury.workspace-backup.plist"; check 'the plist lints (plutil)' $?
fi

out="$(MERCURY_CONFIG_DIR="$tmphome" MERCURY_DIST=/nonexistent/mercury.mjs \
       bash "$here/launcher-mercury.sh" 2>&1)"; rc=$?
[ "$rc" -eq 66 ]; check "missing dist refuses with exit 66 (got $rc)" $?
printf '%s' "$out" | grep -q 'REFUSES TO LAUNCH'; check 'refusal is LOUD (banner text)' $?
printf '%s' "$out" | grep -q 'bun run build.ts'; check 'refusal names the rebuild command' $?
printf '%s' "$out" | grep -qi 'no fallback'; check 'refusal states there is NO fallback' $?

fakedist="$tmphome/fake-foreign.mjs"
printf '%s\n' 'console.log("definitely-not-mercury 9.9.9")' > "$fakedist"
out="$(MERCURY_CONFIG_DIR="$tmphome" MERCURY_NO_BANNER=1 MERCURY_DIST="$fakedist" \
       bash "$here/launcher-mercury.sh" 2>&1)"; rc=$?
[ "$rc" -eq 67 ]; check "foreign bundle refused with exit 67 (got $rc)" $?
printf '%s' "$out" | grep -q 'NOT'; check 'foreign-bundle refusal is LOUD' $?
printf '%s' "$out" | grep -q 'definitely-not-mercury'; check 'refusal reports what the bundle SAID' $?

realdist="$here/../../dist/mercury.mjs"
if [ -f "$realdist" ]; then
  booted="$(node "$realdist" --version 2>/dev/null)"
  case "$booted" in Mercury\ *) rc2=0 ;; *) rc2=1 ;; esac
  check "real dist passes the booted-identity shape ('$booted')" $rc2
else
  say '  – dist absent: skipping the real-dist identity leg'
fi

say '— launcher prompt-injection retirement —'
n="$(grep -c -- '--append-system-prompt "\$(cat' "$here/launcher-mercury.sh" || true)"
[ "$n" -eq 0 ]; check "no live prompt-injection exec in the launcher (got $n)" $?

say '— the launcher has no python banner path —'
live="$(grep -v '^[[:space:]]*#' "$here/launcher-mercury.sh")"
n="$(printf '%s' "$live" | grep -c 'welcome\.py' || true)"
[ "$n" -eq 0 ]; check "no live welcome.py reference in the launcher (got $n)" $?
n="$(printf '%s' "$live" | grep -c 'patches\.' || true)"
[ "$n" -eq 0 ]; check "no live byte-patcher reference in the launcher (got $n)" $?
grep -q '221;68;68m✦ MERCURY' "$here/launcher-mercury.sh"
check 'static fallback is the Mercury wordmark in the brand accent (#DD4444)' $?
n="$(printf '%s' "$live" | grep -c 'python' || true)"
[ "$n" -eq 0 ]; check "launcher has zero live python dependency (got $n)" $?

say '— a runtime dir without mercury.mjs REFUSES (stale-artifact class) —'
cr2home="$(mktemp -d /tmp/ops-proof-cr2-XXXXXX)"
mkdir -p "$cr2home/runtime/dist"
printf '%s\n' 'console.log("Mercury 9.9.9-other")' > "$cr2home/runtime/dist/other.mjs"
out="$(MERCURY_CONFIG_DIR="$cr2home" MERCURY_NO_BANNER=1 bash "$here/launcher-mercury.sh" --version 2>&1)"; rc=$?
[ "$rc" -ne 0 ]; check "other-bundle-only runtime refuses (got $rc)" $?
printf '%s' "$out" | grep -qi 'missing'; check 'the refusal names the missing build' $?
printf '%s\n' 'console.log("Mercury 9.9.9-native")' > "$cr2home/runtime/dist/mercury.mjs"
out="$(MERCURY_CONFIG_DIR="$cr2home" MERCURY_NO_BANNER=1 bash "$here/launcher-mercury.sh" --version 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '9.9.9-native'; check 'the native bundle boots (got $rc)' $?
rm -rf "$cr2home"

say '— mercury_resolve_home: the three-rung chain (shell twin of envUtils) —'
rhome="$(mktemp -d /tmp/ops-proof-rhome-XXXXXX)"
res() { env -i HOME="$rhome" "$@" bash -c ". '$here/lib/mercury-home.sh'; mercury_resolve_home"; }
[ "$(res MERCURY_CONFIG_DIR=/r1 MERCURY_HOME=/r3)" = "/r1" ]; check 'rung 1: MERCURY_CONFIG_DIR wins' $?
[ "$(res MERCURY_HOME=/r3)" = "/r3" ]; check 'rung 2: MERCURY_HOME next' $?
[ "$(res)" = "$rhome/.mercury" ]; check 'rung 3: the default is ~/.mercury' $?
mkdir -p "$rhome/.mercury"
[ "$(res)" = "$rhome/.mercury" ]; check 'an existing ~/.mercury resolves the same' $?
rm -rf "$rhome/.mercury"
[ "$(res)" = "$rhome/.mercury" ]; check 'a missing ~/.mercury resolves the same' $?
[ ! -d "$rhome/.mercury" ]; check 'resolution never CREATES a home (R-7)' $?
rm -rf "$rhome"
lib_chain="$(sed -n '/^mercury_resolve_home()/,/^}/p' "$here/lib/mercury-home.sh")"
launcher_chain="$(sed -n '/^mercury_resolve_home()/,/^}/p' "$here/launcher-mercury.sh")"
[ -n "$lib_chain" ] && [ "$lib_chain" = "$launcher_chain" ]; check 'launcher inline resolver is byte-identical to lib/mercury-home.sh' $?

say '— workspace backup round-trip (hermetic fixture) —'
fixrepo="$(mktemp -d /tmp/ops-proof-repo-XXXXXX)"
git -C "$fixrepo" init -q
git -C "$fixrepo" -c user.email=ops@proof -c user.name=ops commit -q --allow-empty -m fixture
echo 'precious untracked bytes' > "$fixrepo/scratch-note.txt"

MERCURY_REPO="$fixrepo" MERCURY_CONFIG_DIR="$tmphome" MERCURY_BACKUP_KEEP=2 \
  bash "$tmphome/bin/workspace-backup.sh" >/dev/null; check 'backup run (deployed copy) exits 0' $?
dest="$(ls -1d "$tmphome"/backups/workspace/*/ | head -1)"
[ -f "$dest/repo.bundle" ]; check 'repo.bundle written' $?
git bundle verify "$dest/repo.bundle" >/dev/null 2>&1; check 'repo.bundle verifies (restorable)' $?
[ "$(cat "$dest/HEAD")" = "$(git -C "$fixrepo" rev-parse HEAD)" ]; check 'HEAD stamp matches' $?
tar -tzf "$dest/untracked.tgz" 2>/dev/null | grep -q 'scratch-note.txt'
check 'untracked file captured in untracked.tgz' $?
[ -f "$dest/config.tgz" ]; check 'config home core captured in config.tgz' $?

for i in 1 2 3; do
  sleep 1
  MERCURY_REPO="$fixrepo" MERCURY_CONFIG_DIR="$tmphome" MERCURY_BACKUP_KEEP=2 \
    bash "$here/workspace-backup.sh" >/dev/null
done
n="$(ls -1d "$tmphome"/backups/workspace/*/ | wc -l | tr -d ' ')"
[ "$n" -eq 2 ]; check "rotation keeps exactly KEEP=2 (got $n)" $?

say ''
if [ "$fails" -gt 0 ]; then
  say "❌ $fails OPS PROOF(S) FAILED"
  exit 1
fi
say '✅ ALL OPS PROOFS PASS'
