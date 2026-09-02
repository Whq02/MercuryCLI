#!/usr/bin/env bash
# ============================================================================
#  mercury — Mercury launcher: boots the SOURCE-BUILT Mercury
#  (deployed runtime dist/mercury.mjs) on the RESOLVED config home.
#
#  Source of truth: scripts/ops/launcher-mercury.sh (this file); deployed
#  copy: <config-home>/bin/mercury (the ~/.local/bin/mercury symlink points
#  at it — R-1: the symlink is repointed by hand, never by a script). Deploy
#  with scripts/ops/deploy-launcher.sh — the splash-action block below is
#  ALSO managed by scripts/splash/deploy.sh between its markers.
#
#  There is no byte-patched runtime, no patch-runtime.mjs, and no
#  prompt-swap path. A missing
#  build is a LOUD hard failure, never a silent fallback onto a stale
#  runtime: old binary + new state is the stray-agent incident class.
# ============================================================================
set -uo pipefail

# THE home resolver — INLINED because the deployed launcher is a standalone
# artifact (no repo beside it). Byte-for-byte the chain in
# scripts/ops/lib/mercury-home.sh, which is the shell twin of the runtime's
# getMercuryHome; the projectdirs agreement prover pins all three.
# Resolution only — never mkdir a home here.
mercury_resolve_home() {
  if [ -n "${MERCURY_CONFIG_DIR:-}" ]; then printf '%s' "$MERCURY_CONFIG_DIR"; return; fi
  if [ -n "${MERCURY_HOME:-}" ]; then printf '%s' "$MERCURY_HOME"; return; fi
  printf '%s' "$HOME/.mercury"
}
MERCURY_HOME="$(mercury_resolve_home)"
MCP="$MERCURY_HOME/mcp.json"

# The launcher boots the DEPLOYED runtime:
# scripts/ops/deploy-runtime.sh publishes a committed tree's build to
# $MERCURY_HOME/runtime/dist — the repo's live dist is NEVER booted directly,
# so a mid- `bun run build.ts` can never hot-swap the
# production binary with unverified WIP (a WIP bundle crashed a live
# session, post-FLUX incident). MERCURY_DIST overrides (worktree/dev
# boots). A missing deployed runtime is a LOUD failure below — never a
# silent fallback.
MERCURY_RUNTIME_DIR="$MERCURY_HOME/runtime/dist"
MERCURY_DIST_OVERRIDE="${MERCURY_DIST:-}"
MERCURY_DIST="${MERCURY_DIST_OVERRIDE:-$MERCURY_RUNTIME_DIR/mercury.mjs}"

# The runtime (three rungs, first hit wins — the release launchers walk the
# same order): MERCURY_NODE (an explicit binary) · the vendored runtime beside
# the booted bundle (vendor/node/bin/node — a build with the Node pack carries
# one, and deploy-runtime.sh copies it with the dist) · a PATH node. No rung
# is silent: a pinned-but-missing MERCURY_NODE refuses here, and the bundle's
# own entry gate judges the chosen node against the supported range at the
# --version check below.
MERCURY_NODE_BIN=""
if [ -n "${MERCURY_NODE:-}" ]; then
  if [ -f "$MERCURY_NODE" ] && [ -x "$MERCURY_NODE" ]; then MERCURY_NODE_BIN="$MERCURY_NODE"; fi
elif [ -f "$(dirname "$MERCURY_DIST")/vendor/node/bin/node" ] && [ -x "$(dirname "$MERCURY_DIST")/vendor/node/bin/node" ]; then
  MERCURY_NODE_BIN="$(dirname "$MERCURY_DIST")/vendor/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  MERCURY_NODE_BIN="$(command -v node)"
fi
if [ -z "$MERCURY_NODE_BIN" ]; then
  {
    printf '\033[1;31m'
    echo '╔════════════════════════════════════════════════════════════════════╗'
    echo '║  MERCURY REFUSES TO LAUNCH — no usable Node runtime.                ║'
    echo '╚════════════════════════════════════════════════════════════════════╝'
    printf '\033[0m'
    echo '  none of the three rungs answered:'
    echo '  1. MERCURY_NODE : unset, or names no executable file (point it at a Node 24.x binary)'
    echo "  2. vendored     : no runtime at $(dirname "$MERCURY_DIST")/vendor/node/bin/node"
    echo '                    (bun run scripts/vendor/fetch-node.ts && bun run build.ts, then redeploy)'
    echo '  3. PATH         : no `node` on PATH (install Node 24 LTS from https://nodejs.org)'
  } >&2
  exit 127
fi
if [ ! -f "$MERCURY_DIST" ]; then
  {
    printf '\033[1;31m'
    echo '╔════════════════════════════════════════════════════════════════════╗'
    echo '║  MERCURY REFUSES TO LAUNCH — the source build is MISSING.           ║'
    echo '╚════════════════════════════════════════════════════════════════════╝'
    printf '\033[0m'
    echo "  expected : $MERCURY_DIST"
    echo '  deploy   : cd <your Mercury checkout> && bun run build.ts \\'
    echo '             && bash scripts/ops/deploy-runtime.sh   (deploy-on-green)'
    echo '  dev boot : MERCURY_DIST=<checkout>/dist/mercury.mjs mercury'
    echo '  There is NO fallback: a stale runtime must never boot on live state.'
  } >&2
  exit 66
fi

# Staleness honesty (deploy-on-green): a calm note when the deployed runtime
# is older than the repo's HEAD — the operator sees drift without being
# blocked. Best-effort: silent when git/the repo/jq-less parsing is absent.
#
# BETA-POSTURE NOTE: this per-boot note is
# deliberate for the beta period. If Mercury ever moves to a prod posture,
# REMOVE this block or fold the drift signal into a quieter surface
# (/doctor's build-fresh row or the statusbar) instead of per-boot stderr.
# Optional refinement either way: compare the built TREE (manifest.buildTree
# vs HEAD^{tree}) instead of commit SHAs so docs-only commits stay quiet.
# Staleness is NOT a per-boot stderr line anymore (operator ruling
# backend plumbing never leaks onto the boot surface): the
# note is handed over as a STRUCTURED boot note ($MERCURY_HOME/
# boot-notes.json — substrate/bootNotes.ts ingests + clears it); the
# setup card's disclosure row + /doctor surface it. Zero stderr.
if [ -z "$MERCURY_DIST_OVERRIDE" ] && [ -f "$MERCURY_RUNTIME_DIR/runtime-manifest.json" ] && command -v git >/dev/null 2>&1; then
  _repo="${MERCURY_REPO:-$HOME/Developer/mercury}"
  if [ -d "$_repo/.git" ]; then
    _dep_sha="$(sed -n 's/.*"sourceSha": *"\([0-9a-f]*\)".*/\1/p' "$MERCURY_RUNTIME_DIR/runtime-manifest.json" | head -1)"
    _head_sha="$(git -C "$_repo" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$_dep_sha" ] && [ -n "$_head_sha" ] && [ "$_dep_sha" != "$_head_sha" ]; then
      printf '{"notes":[{"kind":"info","text":"runtime %s · repo main %s — refresh: scripts/ops/deploy-runtime.sh"}]}\n' \
        "${_dep_sha:0:7}" "${_head_sha:0:7}" > "$MERCURY_HOME/boot-notes.json" 2>/dev/null || true
    fi
  fi
fi

# BOOTED-identity check: a file EXISTING at
# the dist path is not enough — a foreign/stale bundle dropped there would boot
# unverified on live state (the incident's shape). Run the zero-import
# --version fast-path (~100ms) and require the Mercury banner before exec.
# MERCURY_LAUNCH_NO_VERIFY=1 skips (emergency hatch; the refusal names it).
# The same run is the runtime's floor check: the bundle's entry gate refuses
# an unsupported node before answering --version, and that refusal names the
# range — surfaced here as the runtime card, never mistaken for a foreign
# bundle.
if [ "${MERCURY_LAUNCH_NO_VERIFY:-0}" != "1" ]; then
  BOOTED_ID="$("$MERCURY_NODE_BIN" "$MERCURY_DIST" --version 2>/dev/null)"
  case "$BOOTED_ID" in
    Mercury\ *) : ;; # verified — the booted banner is Mercury's
    *)
      BOOTED_ERR="$("$MERCURY_NODE_BIN" "$MERCURY_DIST" --version 2>&1 >/dev/null)"
      case "$BOOTED_ERR" in
        mercury:\ *)
          {
            printf '\033[1;31m'
            echo '╔════════════════════════════════════════════════════════════════════╗'
            echo '║  MERCURY REFUSES TO LAUNCH — the Node runtime it picked is not      ║'
            echo '║  supported (the bundle refused it).                                 ║'
            echo '╚════════════════════════════════════════════════════════════════════╝'
            printf '\033[0m'
            echo "  node     : $MERCURY_NODE_BIN"
            echo "$BOOTED_ERR" | sed 's/^/  /'
            echo '  rungs    : MERCURY_NODE · the vendored vendor/node beside the bundle · PATH'
          } >&2
          exit 127
          ;;
      esac
      {
        printf '\033[1;31m'
        echo '╔════════════════════════════════════════════════════════════════════╗'
        echo '║  MERCURY REFUSES TO LAUNCH — the build at the dist path is NOT      ║'
        echo '║  Mercury (booted identity check failed).                            ║'
        echo '╚════════════════════════════════════════════════════════════════════╝'
        printf '\033[0m'
        echo "  path     : $MERCURY_DIST"
        echo "  it said  : ${BOOTED_ID:-<no output>}"
        echo '  expected : Mercury <version>'
        echo '  rebuild  : cd <your Mercury checkout> && bun run build.ts'
        echo '  (MERCURY_LAUNCH_NO_VERIFY=1 skips this check — emergencies only.)'
      } >&2
      exit 67
      ;;
  esac
fi

# the splash + its held alternate buffer are for
# INTERACTIVE takeover boots ONLY. A print/help/version/subcommand run must
# never enter the held buffer — its output would print there invisibly and
# the terminal would strand on the splash's parked frame (probe-proved:
# `mercury -p …` on a TTY lost its result and stranded the terminal).
# A bare positional prompt (`mercury "fix it"`) IS a takeover and keeps
# the splash.
# The verb arm mirrors the release launchers' SPLASH_SKIP_VERBS, which is
# DERIVED from the product's registered surface (scripts/release/
# launcherTemplates.mjs) and pinned equal to this line by
# scripts/node-runtime/prove-launchers.ts §8 — regenerate both together.
MERCURY_TAKEOVER=1
case "${1:-}" in
  acp|agents|attach|auth|bridge|daemon|doctor|editor|environment-runner|extensions|health|install|join|join-kit|kill|list|logs|mcp|new|ps|rc|remote|remote-control|reply|self-hosted-runner|setup-token|show|sync|themis|update|upgrade) MERCURY_TAKEOVER=0 ;;
esac
for _mercury_arg in "$@"; do
  case "$_mercury_arg" in
    -p|--print|-h|--help|-v|-V|--version) MERCURY_TAKEOVER=0 ;;
    # `--chat` (or the banked `-chat`): the splash composes the --chat card —
    # no Session Concourse row (L15: New Session is the door) — so frame 0
    # and the in-process Boot face show the same six rows across the seam.
    # The runtime reads argv, never this mark.
    --chat|-chat) export MERCURY_SPLASH_CHAT=1 ;;
  esac
done

# Brand the terminal window/tab title (OSC). Cosmetic; TTY-only — a piped
# stdout must never receive OSC bytes ahead of the payload.
[ -t 1 ] && printf '\033]0;Mercury\007'

# Mercury launch banner — the animated enter screen (Node); falls back to a
# one-line static wordmark. TTY-only; skip with MERCURY_NO_BANNER=1 or
# MERCURY_SPLASH=off; MERCURY_SPLASH=static forces the one-liner.
# There is no python welcome.py fallback (a separately deployed artifact
# goes stale — the stale-deployed-artifact class). The static fallback is
# in-launcher: zero deps, Mercury wordmark in the brand accent (#DD4444).
if [ "$MERCURY_TAKEOVER" = "1" ] && [ "${MERCURY_NO_BANNER:-0}" != "1" ] && [ -t 1 ]; then
  if [ -f "$MERCURY_HOME/splash.mjs" ] \
     && [ "${MERCURY_SPLASH:-}" != "off" ] && [ "${MERCURY_SPLASH:-}" != "static" ]; then
    # capture the splash's exit code — it IS the whole
    # launcher-facing handover now (0 handoff+HELD · 20 handoff+RESTORED ·
    # 130 cancel · else abnormal); the managed splash-action block below
    # branches on it. The alt-held marker moved into that block too (exit 0
    # is the settled held receipt).
    # mint THIS launch's opaque id — env-down only, never parsed back.
    export MERCURY_LAUNCH_ID="ops-$$-$(date +%s 2>/dev/null || echo 0)"
    MERCURY_SA_EXIT=0
    "$MERCURY_NODE_BIN" "$MERCURY_HOME/splash.mjs" </dev/tty || MERCURY_SA_EXIT=$?
  elif [ "${MERCURY_SPLASH:-}" != "off" ]; then
    printf '\n  \033[1;38;2;221;68;68m✦ MERCURY\033[0m \033[38;2;140;133;118m· %s\033[0m\n\n' "$PWD"
  fi
fi

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
    # The heal rides the launcher's resolved runtime (MERCURY_NODE_BIN — the
    # three-rung resolution); the defaulted expansion keeps the block viable
    # under set -u in a launcher generation that never set it.
    "${MERCURY_NODE_BIN:-node}" -e 'process.stdout.write("\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h\x1b]111\x07")' 2>/dev/null || true
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

args=()
# --strict-mcp-config: load ONLY our cloned MCPs, ignoring account/global connectors
# (claude.ai Gmail/Drive/Calendar etc.) so the session is truly isolated.
[ -f "$MCP" ] && args+=(--mcp-config "$MCP" --strict-mcp-config)

# Identity + operating doctrine are COMPILED INTO the binary (repository-owned
# source, src/prompt/mercuryContract.ts) — there is no wrapper-file append.
# ${args[@]+…}: macOS bash 3.2 treats an EMPTY array expansion as unbound
# under `set -u` — the plain form aborted every no-MCP boot (latent until the
# ops leg first exercised the exec line).
exec env MERCURY_CONFIG_DIR="$MERCURY_HOME" "$MERCURY_NODE_BIN" "$MERCURY_DIST" ${args[@]+"${args[@]}"} "$@"
