#!/usr/bin/env bash
# ============================================================================
# scripts/ops/lib/mercury-home.sh — THE shell twin of the runtime config-home
# resolver (src/utils/envUtils.ts getMercuryHome). Every ops script
# that needs the operator's home sources this and calls mercury_resolve_home;
# a hand-rolled fallback chain here is the split-store class at full scale.
#
# Chain (identical to the runtime, all three rungs):
#   MERCURY_CONFIG_DIR > MERCURY_HOME > ~/.mercury
#
# NEVER mkdir here: resolution only; creation is the runtime's (or the
# operator's) deliberate act.
# The projectdirs suite pins this chain byte-equal to the runtime resolver.
# ============================================================================
mercury_resolve_home() {
  if [ -n "${MERCURY_CONFIG_DIR:-}" ]; then printf '%s' "$MERCURY_CONFIG_DIR"; return; fi
  if [ -n "${MERCURY_HOME:-}" ]; then printf '%s' "$MERCURY_HOME"; return; fi
  printf '%s' "$HOME/.mercury"
}
