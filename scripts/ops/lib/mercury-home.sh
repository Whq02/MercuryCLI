#!/usr/bin/env bash
mercury_resolve_home() {
  if [ -n "${MERCURY_CONFIG_DIR:-}" ]; then printf '%s' "$MERCURY_CONFIG_DIR"; return; fi
  if [ -n "${MERCURY_HOME:-}" ]; then printf '%s' "$MERCURY_HOME"; return; fi
  printf '%s' "$HOME/.mercury"
}
