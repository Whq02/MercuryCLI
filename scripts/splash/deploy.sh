#!/usr/bin/env bash
# deploy.sh — deploy the enter screen to the launcher path.
# The launcher (~/.local/bin/mercury) runs <config-home>/splash.mjs before
# booting Mercury; the repo file is the canonical source, the copy is the
# artifact. The previous (crab) splash is kept once as splash.mjs.crab-bak.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
. "$repo/scripts/ops/lib/mercury-home.sh"
MERCURY_HOME="$(mercury_resolve_home)"
src="$repo/assets/splash/mercury-splash.mjs"
core="$repo/assets/splash/splash-core.mjs"
dst="$MERCURY_HOME/splash.mjs"
dst_core="$MERCURY_HOME/splash-core.mjs"
[ -f "$src" ] || { echo "missing $src"; exit 1; }
# Share-by-extraction: the splash ships as a PAIR — the driver
# (splash.mjs) imports its sibling compose core ('./splash-core.mjs'), so
# deploy copies + syntax-checks BOTH or the enter screen dies on import.
# (A partially-deployed pair degrades to cosmetics only: the launcher treats
# an abnormal splash exit as bounded and boots plain — the FLOOR LAW.)
[ -f "$core" ] || { echo "missing $core (the splash deploys as a pair)"; exit 1; }
node --check "$src"
node --check "$core"
mkdir -p "$MERCURY_HOME"
if [ -f "$dst" ] && [ ! -f "$dst.crab-bak" ] && ! grep -q 'mercury-splash.mjs' "$dst"; then
  cp "$dst" "$dst.crab-bak"
  echo "backed up the previous splash → $dst.crab-bak"
fi
cp "$core" "$dst_core"
cp "$src" "$dst"
echo "deployed → $dst (+ splash-core.mjs)"

# ── the launcher-card action block ──────────────────────────────
# The card's actions (continue / doctor / recent project) cross to the
# launcher through <config-home>/splash-action.json; the launcher needs the
# managed reader block. Injected idempotently between the MERCURY-SPLASH-
# ACTION markers (replace when present, insert before the `args=()` anchor
# otherwise). The canonical block is assets/splash/launcher-action-block.sh.
launcher="${MERCURY_LAUNCHER:-$HOME/.local/bin/mercury}"
block="$repo/assets/splash/launcher-action-block.sh"
if [ -f "$launcher" ] && [ -f "$block" ]; then
  python3 - "$launcher" "$block" <<'PY'
import os, re, sys
launcher, block = sys.argv[1], sys.argv[2]
# R-3: ~/.local/bin/mercury is a SYMLINK and open(...,'w')
# writes THROUGH it — the launcher-clobber shape. Resolve the real
# target first and refuse to touch anything that is not a Mercury launcher
# (marker block present, or the launcher's own resolver/args anchor).
launcher = os.path.realpath(launcher)
src = open(launcher).read()
blk = open(block).read().rstrip('\n')
START, END = '# MERCURY-SPLASH-ACTION-START', '# MERCURY-SPLASH-ACTION-END'
is_mercury_launcher = (START in src) or ('mercury_resolve_home' in src) or re.search(r'(?m)^args=\(\)', src)
if not is_mercury_launcher:
    print(f'launcher action block: REFUSED — {launcher} does not look like a Mercury launcher (no markers, no resolver, no args anchor); nothing written')
    sys.exit(0)
# GENERATION PAIRING GUARD: the exit-code block
# only works on a launcher whose splash run line CAPTURES the exit code
# (MERCURY_SA_EXIT=0 / || MERCURY_SA_EXIT=$? — OUTSIDE these markers).
# Injecting it into an OLD-generation launcher (`node splash.mjs || true` +
# its own unconditional ALT_HELD export) makes the block a permanent no-op:
# cancel BOOTS the app with a false hold marker and every card action goes
# dead. Refuse loudly instead of deploying a broken pair.
outside = src
if START in src and END in src:
    outside = src[:src.index(START)] + src[src.index(END) + len(END):]
if 'MERCURY_SA_EXIT=0' not in outside:
    print(f'launcher action block: REFUSED — {launcher} is an OLD-generation launcher (its splash run line does not capture MERCURY_SA_EXIT). Run scripts/ops/deploy-launcher.sh FIRST, then re-run this deploy; the two ship as a pair.')
    sys.exit(1)
if START in src and END in src:
    s, e = src.index(START), src.index(END) + len(END)
    new = src[:s] + blk + src[e:]
    verb = 'refreshed'
else:
    m = re.search(r'(?m)^args=\(\)', src)
    if not m:
        print(f'launcher action block: anchor `args=()` not found in {launcher} — skipped')
        sys.exit(0)
    new = src[:m.start()] + blk + '\n\n' + src[m.start():]
    verb = 'injected'
if new != src:
    open(launcher, 'w').write(new)
    print(f'launcher action block {verb} → {launcher}')
else:
    print('launcher action block: already current')
PY
else
  echo "launcher not found at $launcher — action block not installed (card actions fall back to plain launch)"
fi
