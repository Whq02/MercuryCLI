# MERCURY-SPLASH-ACTION-START (managed by scripts/splash/deploy.sh — do not hand-edit)
# THE EXIT-CODE HANDOVER: the launcher parses NOTHING the
# splash writes. 1.5.4's cmd launcher read the splash-action plain-text twin
# with `set /p`; the LF-only receipt collapsed into one multi-line %VAR%
# whose first `if` expansion was a malformed command — cmd aborted the batch,
# node never started, and every Windows interactive boot stranded on the held
# splash frame. The class fix removes data-dependent shell parsing from every
# launcher at once: the splash's EXIT CODE is the one launcher-facing channel
# (0 handoff+HELD · 20 handoff+RESTORED · 130 cancel · else abnormal), and
# action/dir ride <config-home>/splash-action.json to the RUNTIME consumer
# (src/substrate/splashHandover.ts), armed by MERCURY_SPLASH_HANDOFF=1.
# $MERCURY_SA_EXIT is set by the splash-run line; unset means the splash
# never ran (verb / flag / piped boot) — the block is a no-op then.
# (defaulted expansions keep the block viable under set -u)
if [ -n "${MERCURY_SA_EXIT:-}" ]; then
  if [ "$MERCURY_SA_EXIT" = "130" ]; then
    # Ctrl-C / SIGTERM / the idle timeout on the enter screen cancels the
    # BOOT: the splash restored the screen — stand down.
    exit 0
  fi
  if [ "$MERCURY_SA_EXIT" = "0" ] || [ "$MERCURY_SA_EXIT" = "20" ]; then
    export MERCURY_SPLASH_HANDOFF=1
  else
    # abnormal splash death (nonzero, not the 130 cancel): bounded,
    # idempotent, owner-scoped heal — then boot plain, without a false hold
    # marker. A splash failure may cost hold cosmetics, never the boot.
    node -e 'process.stdout.write("\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h\x1b]111\x07")' 2>/dev/null || true
  fi
  # exit 0 IS the settled held receipt (3.6.2/: the splash exits 20
  # when it restored the screen — inline mode). The app's root alt-screen
  # mount consumes and deletes the marker.
  if [ "$MERCURY_SA_EXIT" = "0" ] && [ "${MERCURY_FULLSCREEN:-}" != "0" ]; then
    export MERCURY_ALT_HELD=1
  fi
  unset MERCURY_SA_EXIT
fi
# MERCURY-SPLASH-ACTION-END
