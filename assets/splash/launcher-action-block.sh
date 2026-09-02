if [ -n "${MERCURY_SA_EXIT:-}" ]; then
  if [ "$MERCURY_SA_EXIT" = "130" ]; then
    exit 0
  fi
  if [ "$MERCURY_SA_EXIT" = "0" ] || [ "$MERCURY_SA_EXIT" = "20" ]; then
    export MERCURY_SPLASH_HANDOFF=1
  else
    node -e 'process.stdout.write("\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h\x1b]111\x07")' 2>/dev/null || true
  fi
  if [ "$MERCURY_SA_EXIT" = "0" ] && [ "${MERCURY_FULLSCREEN:-}" != "0" ]; then
    export MERCURY_ALT_HELD=1
  fi
  unset MERCURY_SA_EXIT
fi
