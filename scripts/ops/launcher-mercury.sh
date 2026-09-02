#!/usr/bin/env bash
set -uo pipefail

mercury_resolve_home() {
  if [ -n "${MERCURY_CONFIG_DIR:-}" ]; then printf '%s' "$MERCURY_CONFIG_DIR"; return; fi
  if [ -n "${MERCURY_HOME:-}" ]; then printf '%s' "$MERCURY_HOME"; return; fi
  printf '%s' "$HOME/.mercury"
}
MERCURY_HOME="$(mercury_resolve_home)"
MCP="$MERCURY_HOME/mcp.json"

MERCURY_RUNTIME_DIR="$MERCURY_HOME/runtime/dist"
MERCURY_DIST_OVERRIDE="${MERCURY_DIST:-}"
MERCURY_DIST="${MERCURY_DIST_OVERRIDE:-$MERCURY_RUNTIME_DIR/mercury.mjs}"

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

MERCURY_TAKEOVER=1
case "${1:-}" in
  acp|agents|attach|auth|bridge|daemon|doctor|editor|environment-runner|extensions|health|install|join|join-kit|kill|list|logs|mcp|new|ps|rc|remote|remote-control|reply|self-hosted-runner|setup-token|show|sync|themis|update|upgrade) MERCURY_TAKEOVER=0 ;;
esac
for _mercury_arg in "$@"; do
  case "$_mercury_arg" in
    -p|--print|-h|--help|-v|-V|--version) MERCURY_TAKEOVER=0 ;;
    --chat|-chat) export MERCURY_SPLASH_CHAT=1 ;;
  esac
done

[ -t 1 ] && printf '\033]0;Mercury\007'

if [ "$MERCURY_TAKEOVER" = "1" ] && [ "${MERCURY_NO_BANNER:-0}" != "1" ] && [ -t 1 ]; then
  if [ -f "$MERCURY_HOME/splash.mjs" ] \
     && [ "${MERCURY_SPLASH:-}" != "off" ] && [ "${MERCURY_SPLASH:-}" != "static" ]; then
    export MERCURY_LAUNCH_ID="ops-$$-$(date +%s 2>/dev/null || echo 0)"
    MERCURY_SA_EXIT=0
    "$MERCURY_NODE_BIN" "$MERCURY_HOME/splash.mjs" </dev/tty || MERCURY_SA_EXIT=$?
  elif [ "${MERCURY_SPLASH:-}" != "off" ]; then
    printf '\n  \033[1;38;2;221;68;68m✦ MERCURY\033[0m \033[38;2;140;133;118m· %s\033[0m\n\n' "$PWD"
  fi
fi

if [ -n "${MERCURY_SA_EXIT:-}" ]; then
  if [ "$MERCURY_SA_EXIT" = "130" ]; then
    exit 0
  fi
  if [ "$MERCURY_SA_EXIT" = "0" ] || [ "$MERCURY_SA_EXIT" = "20" ]; then
    export MERCURY_SPLASH_HANDOFF=1
  else
    "${MERCURY_NODE_BIN:-node}" -e 'process.stdout.write("\x1b[?2026l\x1b[0m\x1b[?1007l\x1b[?1049l\x1b[?25h\x1b]111\x07")' 2>/dev/null || true
  fi
  if [ "$MERCURY_SA_EXIT" = "0" ] && [ "${MERCURY_FULLSCREEN:-}" != "0" ]; then
    export MERCURY_ALT_HELD=1
  fi
  unset MERCURY_SA_EXIT
fi

args=()
[ -f "$MCP" ] && args+=(--mcp-config "$MCP" --strict-mcp-config)

exec env MERCURY_CONFIG_DIR="$MERCURY_HOME" "$MERCURY_NODE_BIN" "$MERCURY_DIST" ${args[@]+"${args[@]}"} "$@"
