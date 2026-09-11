#!/usr/bin/env bash
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

launcher="${MERCURY_LAUNCHER:-$HOME/.local/bin/mercury}"
block="$repo/assets/splash/launcher-action-block.sh"
if [ -f "$launcher" ] && [ -f "$block" ]; then
  python3 - "$launcher" "$block" <<'PY'
import os, re, sys
launcher, block = sys.argv[1], sys.argv[2]
# the launcher path is usually a symlink: write to the real target only
launcher = os.path.realpath(launcher)
src = open(launcher).read()
blk = open(block).read().rstrip('\n')
BEGIN = re.compile(r'^: mercury-splash-action-begin$', re.M)
END = re.compile(r'^: mercury-splash-action-end$', re.M)
OLD_BEGIN = re.compile(r'^# MERCURY-SPLASH-ACTION-START.*$', re.M)
OLD_END = re.compile(r'^# MERCURY-SPLASH-ACTION-END.*$', re.M)

def refuse(why):
    print(f'launcher action block: REFUSED — {launcher}: {why}; redeploy the launcher (scripts/ops/deploy-launcher.sh) and re-run this deploy; nothing written')
    sys.exit(1)

def marked_span(begin, end, text):
    bs, es = list(begin.finditer(text)), list(end.finditer(text))
    if not bs and not es:
        return None
    if len(bs) != 1 or len(es) != 1 or es[0].start() < bs[0].end():
        refuse(f'the block markers are not one ordered pair (begin x{len(bs)}, end x{len(es)})')
    return bs[0].start(), es[0].end()

def shell_lines(text):
    return [(i, l) for i, l in enumerate(text.split('\n'))
            if l.strip() and not l.lstrip().startswith('#') and not BEGIN.match(l) and not END.match(l)]

def bare_span(text):
    # a marker-less body, or an unbroken run of them, is the span
    want = [l for _, l in shell_lines(blk)]
    have = shell_lines(text)
    hits = [k for k in range(len(have) - len(want) + 1) if [l for _, l in have[k:k + len(want)]] == want]
    if not hits:
        return None
    if any(b - a != len(want) for a, b in zip(hits, hits[1:])):
        refuse('marker-less copies of the block are present but not as one unbroken run')
    lines = text.split('\n')
    first, last = have[hits[0]][0], have[hits[-1] + len(want) - 1][0]
    start = sum(len(l) + 1 for l in lines[:first])
    end = sum(len(l) + 1 for l in lines[:last + 1]) - 1
    return start, end

span, verb = marked_span(BEGIN, END, src), 'refreshed'
if span is None:
    span, verb = marked_span(OLD_BEGIN, OLD_END, src), 'migrated'
if span is None:
    span, verb = bare_span(src), 'migrated'
is_mercury_launcher = span is not None or 'mercury_resolve_home' in src or re.search(r'^args=\(\)', src, re.M)
if not is_mercury_launcher:
    print(f'launcher action block: REFUSED — {launcher} does not look like a Mercury launcher (no block, no resolver, no args anchor); nothing written')
    sys.exit(0)
# the pairing guard: the splash run line outside the block must capture
# the exit code, or the block is a permanent no-op
outside = src if span is None else src[:span[0]] + src[span[1]:]
if 'unset MERCURY_SA_EXIT' in outside:
    refuse('a splash-action body lies outside the managed span and would run first')
if 'MERCURY_SA_EXIT=0' not in outside:
    print(f'launcher action block: REFUSED — {launcher} is an OLD-generation launcher (its splash run line does not capture MERCURY_SA_EXIT). Run scripts/ops/deploy-launcher.sh FIRST, then re-run this deploy; the two ship as a pair.')
    sys.exit(1)
if span is not None:
    new = src[:span[0]] + blk + src[span[1]:]
else:
    m = re.search(r'^args=\(\)', src, re.M)
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
