#!/usr/bin/env bash
# ============================================================================
#  scripts/lib/project-home.sh — the SHELL twin of
#  src/utils/projectStoreAdoption.ts adoptiveProjectPath.
#
#  project_store_dir <root> <name> resolves a Mercury-owned project store:
#  <root>/.mercury/<name>, the one project-config home. `.claude` is not a
#  Mercury home — an external harness's project dir is never one. The
#  cross-language agreement prover
#  (scripts/projectdirs/prove-shell-home-agreement.ts) pins this
#  byte-identical to the TS seam — edit BOTH or the gate goes red.
# ============================================================================
project_store_dir() {
  local root="$1" name="$2"
  printf '%s' "$root/.mercury/$name"
}
