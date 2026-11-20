#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: native/windows-launcher/**
# gate-watch: flake.nix flake.lock nix/** docs/NIX.md
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/release"
fail=0
echo "############################################################"
echo "# release — the release job on a machine of our own"
echo "############################################################"
drive_members release 'scripts/release/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "release suite: RED"
  exit 1
fi
echo "release suite: green"
