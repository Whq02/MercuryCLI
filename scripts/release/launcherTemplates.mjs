import { readFileSync } from 'node:fs'

// scripts/release/launcherTemplates.mjs — the release launcher + friend-copy
// templates. Kept separate from package.mjs so the
// updater + node-runtime provers can shim-test the generated version-check logic directly
// (fake-`node` PATH shims driving accept/refuse matrices) while package.mjs
// stays the one assembly/smoke owner.
//
// The Node numbers are never hand-written here: every template derives from
// the machine-readable package policy (package.json `engines.node`, itself
// prover-pinned equal to src/utils/runtime/nodePolicy.ts NODE_SUPPORT.range)
// via parseEnginesNode() — a strict shape parse that REFUSES to generate
// launchers from a range it does not understand. All three launchers check the
// FULL range: supported major + LTS-minimum minor floor + no prerelease tag
// (the in-bundle entry gate stays the canonical decision for anything a
// wrapper cannot express).

/** Strictly parse the `>=A.B.C <D` engines shape (D must be A+1). */
export function parseEnginesNode(enginesNode) {
  const m = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(enginesNode ?? '')
  if (!m) {
    throw new Error(
      `engines.node "${enginesNode}" does not match the ">=A.B.C <D" shape the launcher templates project from — update parseEnginesNode alongside any deliberate policy-shape change`,
    )
  }
  const major = Number(m[1])
  const minorFloor = Number(m[2])
  const patchFloor = Number(m[3])
  const ceiling = Number(m[4])
  if (ceiling !== major + 1) {
    throw new Error(`engines.node "${enginesNode}" ceiling <${ceiling} is not major+1 — one qualified major line is the contract`)
  }
  return { major, minorFloor, patchFloor, range: enginesNode, label: `Node ${major} LTS` }
}

// ── the enter-screen chain ──────────
// The canonical splash (assets/splash/mercury-splash.mjs) ships beside
// mercury.mjs as splash.mjs, and every launcher chains
//   enter screen → <config-home>/splash-action.json handover → mercury.mjs
// on INTERACTIVE TTY boots only. The skip laws mirror the operator launcher
// (scripts/ops/launcher-mercury.sh) and the binary's own semantics: a
// SUBCOMMAND VERB as the first argument or a print/help/version FLAG
// anywhere boots straight (case-sensitive — the binary's arg parser is);
// piped/redirected stdio boots straight (posix tests -t, PS1 tests
// [Console]::Is*Redirected, CMD asks node itself — batch has no TTY test);
// a bare positional prompt (`mercury "fix it"`) IS a takeover. The splash
// self-guards non-TTY/MERCURY_SPLASH=off too (exit 0, silent), so every gap
// in a launcher-level test stays safe.

/**
 * The product's own top-level verb surface, read from the source that
 * registers it. A hand-written skip list is a restatement that drifts: it
 * carried `doctor` but not `health` — the PRIMARY name commander registers,
 * with `doctor` as its alias — and neither `show` nor `editor`, so those
 * verbs met the enter screen and could be cancelled into never running while
 * the shell reported success (FN-015 rank 7).
 *
 * Three registration roads, all read here:
 *   - `program.command('<verb>')` in src/main.tsx (top level only — a group's
 *     subcommands hang off the group's own object) plus each command's
 *     `.alias('<verb>')`, taken before any nested `.command(`;
 *   - the launcher-fast-path loop rows in the same file (daemon · acp);
 *   - src/entrypoints/cli.tsx: the fast-path routes it answers before
 *     commander sees argv, and the DEAD_SUBCOMMANDS set whose refusal must
 *     reach the terminal rather than a discarded alternate buffer.
 */
export function verbSurfaceFromSource(mainSource, cliSource) {
  const firstWord = spec => spec.trim().split(/[\s<[]/)[0]
  const commands = []
  const sites = [...mainSource.matchAll(/\bprogram\s*\.command\('([^']+)'/g)]
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]
    const end = i + 1 < sites.length ? sites[i + 1].index : mainSource.length
    const segment = mainSource.slice(site.index + site[0].length, end)
    // A group's subcommands begin at its first nested `.command(` — aliases
    // past that point belong to them, never to the top-level verb.
    const nested = segment.indexOf('.command(')
    const own = nested === -1 ? segment : segment.slice(0, nested)
    const aliases = [...own.matchAll(/\.alias\('([^']+)'\)/g)].map(m => m[1])
    commands.push({ name: firstWord(site[1]), aliases })
  }
  const loop = /for \(const \[name, usage\] of \[([\s\S]*?)\] as const\)/.exec(mainSource)
  if (loop) {
    for (const row of loop[1].matchAll(/\[\s*'([^']+)'/g)) {
      commands.push({ name: firstWord(row[1]), aliases: [] })
    }
  }
  // Verbs only: a leading-dash first argument already skips the takeover by
  // the dash law, and SPLASH_SKIP_FLAGS owns the enumerated flags.
  const fastPath = [...cliSource.matchAll(/args\[0\] === '([^']+)'/g)].map(m => m[1]).filter(v => !v.startsWith('-'))
  const deadBlock = /const DEAD_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(cliSource)
  const dead = deadBlock ? [...deadBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []
  if (commands.length === 0 || fastPath.length === 0 || dead.length === 0) {
    throw new Error(
      'the launcher templates could not read the product\'s verb surface from src/main.tsx + src/entrypoints/cli.tsx — update verbSurfaceFromSource alongside any deliberate registration-shape change (a stale skip list lets a verb be cancelled into never running)',
    )
  }
  return { commands, fastPath, dead: [...new Set(dead)] }
}

/** The skip set the launchers carry: every registered name and alias, every
 *  fast-path route, every dead subcommand — sorted and unique, so all three
 *  generated launchers and the operator launcher spell one order. */
export function splashSkipVerbsFrom(surface) {
  const verbs = new Set()
  for (const command of surface.commands) {
    verbs.add(command.name)
    for (const alias of command.aliases) verbs.add(alias)
  }
  for (const verb of surface.fastPath) verbs.add(verb)
  for (const verb of surface.dead) verbs.add(verb)
  return [...verbs].sort()
}

/** First-argument verbs that boot straight — DERIVED from the registered
 *  surface at generation time, never restated. */
export const SPLASH_SKIP_VERBS = splashSkipVerbsFrom(
  verbSurfaceFromSource(
    readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/entrypoints/cli.tsx', import.meta.url), 'utf8'),
  ),
)

/** Flags anywhere in argv that boot straight (case-sensitive: -v ≠ -V both listed). */
export const SPLASH_SKIP_FLAGS = ['-p', '--print', '-h', '--help', '-v', '-V', '--version']

// ANY leading-dash FIRST
// argument skips the takeover — flags mean "I know what I want", the enter
// screen is for bare boots. The enumerated SPLASH_SKIP_FLAGS list above
// stays for flags ANYWHERE in argv (`mercury "fix it" --print`); the dash
// law covers the unenumerable first-flag space (`--rollback`, `--continue`,
// `-r`, typos) that would otherwise fall INTO the splash — on the wedged Windows
// host, straight into the freeze. The binary then answers the flag itself
// (including the unknown-option pointer for --rollback).

// ── THE EXIT-CODE HANDOVER ──────────────────────────────
// The launchers consume NOTHING the splash writes. 1.5.4's cmd launcher read
// the splash-action plain-text twin with `set /p`; against the LF-only
// receipt the first read swallowed the WHOLE file into a multi-line
// %MERCURY_SA_ACT%, and its first `if "%…%"` expansion was a malformed
// command — cmd aborted the batch, node never started, and the held
// alt-screen stranded the operator on the splash frame (every Windows
// interactive boot, both field machines; the same reader had silently
// mis-parsed the rarer action receipts). The class fix
// removes data-dependent shell parsing from the boot path entirely:
//   · the splash's EXIT CODE is the one launcher-facing channel —
//     0 handoff+HELD · 20 handoff+RESTORED · 130 cancel · else abnormal;
//   · action/dir ride splash-action.json to the RUNTIME consumer
//     (src/substrate/splashHandover.ts, armed by MERCURY_SPLASH_HANDOFF=1)
//     — validated JSON in real code, one owner, unit-proven everywhere;
//   · a receipt anomaly can cost hold cosmetics, never the boot.

/** The CMD boot probe — ONE node start for version + interactivity (the
 *  separate `node -p` version probe and TTY probe are merged; the
 *  Windows boot path drops from five Node starts to three). Prints
 *  `<version> <0|1>` on stdout; stdout is deliberately CAPTURED by `for /f`,
 *  so the interactivity verdict reads STDIN only — a user-redirected stdout
 *  is caught by the splash's own out.isTTY self-guard (exit 0, silent).
 *  User args still ride BEHIND `--` so node never eats --version/-p/-h (the
 *  skip-flag law). Embedded in a double-quoted cmd string ⇒
 *  single-quoted JS strings only, no percent signs. */
export const SPLASH_VERSION_TTY_PROBE_JS =
  `const a=process.argv.slice(1);const f=[${SPLASH_SKIP_FLAGS.map(f => `'${f}'`).join(',')}];` +
  "const d=a.length>0&&a[0].charAt(0)==='-';" +
  "process.stdout.write(process.versions.node+' '+(process.stdin.isTTY&&!d&&!a.some(x=>f.includes(x))?'1':'0'))"

// ── the runtime rungs ───────────────────────────────────────────────────────
// Every launcher resolves its Node in ONE order, first hit wins:
//   1. MERCURY_NODE — an explicit binary (a pinned-but-missing one refuses
//      loudly; the operator asked for it by name);
//   2. the vendored runtime beside the bundle — `vendor/node/bin/node`
//      (`vendor\node\node.exe` on Windows): every release archive carries one,
//      so a fresh machine needs only git;
//   3. a PATH `node`.
// No rung is silent: the chosen binary is then checked against the FULL
// supported range, and no rung at all prints the three-rung refusal naming
// each one. The runtime spawns its own children through process.execPath, so
// the rung the launcher picks is the runtime the whole session runs on.
// src/services/privateChannel/vendoredRuntime.ts owns the pack path; the
// spellings here are pinned to it by scripts/node-runtime/prove-launchers.ts.
export const VENDORED_RUNTIME_POSIX = 'vendor/node/bin/node'
export const VENDORED_RUNTIME_WIN32 = 'vendor\\node\\node.exe'

/** POSIX launcher (mercury) — self-locating, argument-forwarding, three
 *  runtime rungs, full-range check on the rung it picked. */
export function posixLauncher(p) {
  return `#!/bin/sh
# Mercury launcher — self-locating, argument-forwarding. Runs on the Node
# runtime beside it (vendor/node — every release archive carries one), or on
# MERCURY_NODE / a PATH node inside ${p.label} (${p.range}).
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# ── the runtime (three rungs, first hit wins): MERCURY_NODE (an explicit
# binary) · the vendored runtime beside the bundle · a PATH node. No rung is
# silent: a pinned-but-missing MERCURY_NODE refuses here, and the rung picked
# is checked against the FULL supported range below.
node_missing() {
  echo "mercury: no usable Node runtime — none of the three rungs answered:" >&2
  echo "         1. MERCURY_NODE is unset, or names no executable file (point it at a Node ${p.major}.x binary to choose one explicitly)" >&2
  echo "         2. no vendored runtime at $dir/${VENDORED_RUNTIME_POSIX} (re-extract the release archive intact — it carries one)" >&2
  echo "         3. no 'node' on PATH (install ${p.label}, ${p.range}, from https://nodejs.org)" >&2
  exit 1
}
node_bin=""
if [ -n "\${MERCURY_NODE:-}" ]; then
  if [ -f "$MERCURY_NODE" ] && [ -x "$MERCURY_NODE" ]; then node_bin="$MERCURY_NODE"; else node_missing; fi
elif [ -f "$dir/${VENDORED_RUNTIME_POSIX}" ] && [ -x "$dir/${VENDORED_RUNTIME_POSIX}" ]; then
  node_bin="$dir/${VENDORED_RUNTIME_POSIX}"
elif command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
else
  node_missing
fi
node_unsupported() {
  echo "mercury: ${p.label} (${p.range}) is required (found $("$node_bin" -v 2>/dev/null || echo none) at $node_bin)" >&2
  echo "         install a current Node ${p.major}.x from https://nodejs.org, point MERCURY_NODE at one, or re-extract the release archive for its vendored runtime" >&2
  exit 1
}
nodev=$("$node_bin" -p 'process.versions.node' 2>/dev/null)
case "$nodev" in ${p.major}.*) ;; *) node_unsupported ;; esac
case "$nodev" in *-*) node_unsupported ;; esac
nodemin=\${nodev#*.}; nodemin=\${nodemin%%.*}
case "$nodemin" in ''|*[!0-9]*) node_unsupported ;; esac
[ "$nodemin" -ge ${p.minorFloor} ] || node_unsupported
if [ ! -f "$dir/mercury.mjs" ]; then
  echo "mercury: mercury.mjs is missing beside this launcher ($dir)" >&2
  echo "         re-extract the release archive intact" >&2
  exit 1
fi
# ── artifact provenance (LANE LW: interactive boots; warn-only, never a gate)
# The shipped verifier prints ONE stderr line when the payload is unsigned,
# tampered, or signed by a key outside the trusted roster — and nothing when
# signed. It always exits 0, and \`|| true\` holds even a crash harmless: a
# provenance verdict may never cost a boot. Piped/scripted boots skip it so
# automation stays byte-clean; \`mercury doctor\` carries the full record.
if [ -t 0 ] && [ -t 2 ] && [ -f "$dir/verify-artifact.mjs" ]; then
  "$node_bin" "$dir/verify-artifact.mjs" --launcher || true
fi
# ── the config home (three rungs — runtime + splash resolve identically) ────
if [ -n "\${MERCURY_CONFIG_DIR:-}" ]; then MERCURY_SA_HOME="$MERCURY_CONFIG_DIR"
elif [ -n "\${MERCURY_HOME:-}" ]; then MERCURY_SA_HOME="$MERCURY_HOME"
else MERCURY_SA_HOME="$HOME/.mercury"
fi
# ── compile cache: V8 code cache for the bundle parse ───────────────
# Must be in the ENVIRONMENT before node compiles the entry — an in-process
# call cannot cover the already-compiled main module (~0.7s parse of a 20MB
# bundle on the field HDD host). Node creates the dir and silently disables
# on failure; an operator's own NODE_COMPILE_CACHE wins, and
# NODE_DISABLE_COMPILE_CACHE opts out entirely. Covers the splash run too.
if [ -z "\${NODE_COMPILE_CACHE:-}" ] && [ -z "\${NODE_DISABLE_COMPILE_CACHE:-}" ]; then
  NODE_COMPILE_CACHE="$MERCURY_SA_HOME/compile-cache"
  export NODE_COMPILE_CACHE
fi
# ── the enter screen (interactive TTY boots only) ───────────────────────────
# Verbs, flags and piped/redirected stdio boot straight — the enter screen
# never breaks scripted use. MERCURY_NO_BANNER=1 / MERCURY_SPLASH=off skip it;
# MERCURY_SPLASH=static keeps the one-line wordmark.
MERCURY_TAKEOVER=1
case "\${1:-}" in
  ${SPLASH_SKIP_VERBS.join('|')}) MERCURY_TAKEOVER=0 ;;
  -*) MERCURY_TAKEOVER=0 ;;
esac
for _mercury_arg in "$@"; do
  case "$_mercury_arg" in
    ${SPLASH_SKIP_FLAGS.join('|')}) MERCURY_TAKEOVER=0 ;;
  esac
done
if [ "$MERCURY_TAKEOVER" = "1" ] && [ -t 0 ] && [ -t 1 ] \\
   && [ "\${MERCURY_NO_BANNER:-0}" != "1" ] && [ "\${MERCURY_SPLASH:-}" != "off" ]; then
  if [ -f "$dir/splash.mjs" ] && [ "\${MERCURY_SPLASH:-}" != "static" ]; then
    #mint THIS launch's opaque id — env-down only, never parsed back.
    # The splash embeds it in the receipt; the runtime consumes only its own,
    # so simultaneous launches sharing one home stay isolated.
    MERCURY_LAUNCH_ID="posix-$$-$(date +%s 2>/dev/null || echo 0)"
    export MERCURY_LAUNCH_ID
    "$node_bin" "$dir/splash.mjs"
    MERCURY_SA_EXIT=$?
    # THE EXIT-CODE HANDOVER: this launcher parses NOTHING the splash
    # writes — the 1.5.4 cmd reader died parsing the receipt file, so the
    # class is closed in all three launchers at once. Numeric branches only:
    #   0 handoff+HELD · 20 handoff+RESTORED · 130 cancel · else abnormal.
    # Action/dir ride splash-action.json to the RUNTIME consumer, armed by
    # MERCURY_SPLASH_HANDOFF=1 (one-shot, consumed at cli entry).
    if [ "$MERCURY_SA_EXIT" = "130" ]; then
      # Ctrl-C / SIGTERM / the idle timeout on the enter screen cancels the
      # BOOT: the splash restored the screen — stand down.
      exit 0
    fi
    if [ "$MERCURY_SA_EXIT" = "0" ] || [ "$MERCURY_SA_EXIT" = "20" ]; then
      MERCURY_SPLASH_HANDOFF=1
      export MERCURY_SPLASH_HANDOFF
    else
      # abnormal splash death (nonzero, not the 130 cancel): a bounded,
      # idempotent, owner-scoped heal — exactly the splash-ownable modes —
      # and the runtime boots plain, WITHOUT a false hold marker. A splash
      # failure may cost hold cosmetics, never the boot.
      "$node_bin" -e 'process.stdout.write("\\x1b[?2026l\\x1b[0m\\x1b[?1007l\\x1b[?1049l\\x1b[?25h\\x1b]111\\x07")' 2>/dev/null || true
    fi
    # hand over inside the held alternate buffer (the boot black-beat fix) —
    # exit 0 IS the settled held receipt (3.6.2/: the splash exits 20
    # when it restored the screen instead). The app's root alt-screen mount
    # consumes and deletes the marker.
    if [ "$MERCURY_SA_EXIT" = "0" ] && [ "\${MERCURY_FULLSCREEN:-}" != "0" ]; then
      MERCURY_ALT_HELD=1
      export MERCURY_ALT_HELD
    fi
  else
    printf '\\n  \\033[1;38;2;221;68;68m\\342\\234\\246 MERCURY\\033[0m \\033[38;2;140;133;118m\\302\\267 %s\\033[0m\\n\\n' "$PWD"
  fi
fi
"$node_bin" "$dir/mercury.mjs" "$@"
rt=$?
# post-child heal: TTY-gated, abnormal-exit only, code preserved. Focus
# tracking (?1004l) is re-reset AFTER ?1049l: on win32 a reset written before
# the alt-screen exit lands on the alt buffer, so 1004 stays armed on the main
# buffer and focus flips spew ^[[I/^[[O at the dead prompt (field TASK-005 L4).
if [ -t 1 ] && [ "$rt" != "0" ]; then
  "$node_bin" -e "process.stdout.write('\\x1b[?2026l\\x1b[0m\\x1b[?1000l\\x1b[?1002l\\x1b[?1003l\\x1b[?1006l\\x1b[?1004l\\x1b[?2004l\\x1b[?1007l\\x1b[?1049l\\x1b[?1004l\\x1b[?25h\\x1b]111\\x07')" 2>/dev/null || true
fi
exit $rt
`
}

/** Windows CMD launcher (mercury.cmd) — the existence-only gap is CLOSED:
 *  version parsed + full range checked before the bundle is touched.
 *  Console UTF-8 + the enter-screen chain.
 * The version and TTY probes are ONE node start — the boot
 *  path runs three Node processes (probe · splash · app), down from five.
 * the splash handover is EXIT-CODE ONLY — no batch line
 *  ever reads or expands product-written data (the 1.5.4 set /p receipt
 *  reader aborted the whole batch on its own receipt; see the handover
 *  comment above cmd's splash block). */
export function cmdLauncher(p) {
  return `@echo off\r
setlocal\r
set "DIR=%~dp0"\r
rem Console UTF-8: Mercury's frame delivery writes raw UTF-8 to the console\r
rem fd, decoded under the console codepage — the CP437/850 legacy default\r
rem garbles every box-drawing glyph (\`ΓöÇ\` mojibake). chcp 65001 sets BOTH\r
rem input+output codepages. Deliberately not restored here (locale-proof\r
rem batch parsing of chcp output is not worth the risk; a new console tab\r
rem starts at the profile codepage anyway) — the runtime seam restores only\r
rem what IT changes. On success the PRESET marker tells the runtime seam to\r
rem skip even its query spawn (one less chcp.com per boot).\r
chcp 65001 >nul 2>nul\r
if not errorlevel 1 set "MERCURY_WIN32_UTF8_PRESET=1"\r
rem ── the runtime (three rungs, first hit wins): MERCURY_NODE (an explicit\r
rem binary) · the vendored runtime beside the bundle (${VENDORED_RUNTIME_WIN32})\r
rem · a PATH node. Sequential top-level ifs only: a path with parentheses\r
rem inside a parenthesized block would abort the batch. No rung is silent —\r
rem a pinned-but-missing MERCURY_NODE refuses, and the rung picked is\r
rem checked against the FULL supported range below.\r
set "NODEBIN="\r
if defined MERCURY_NODE set "NODEBIN=%MERCURY_NODE%"\r
if defined NODEBIN if not exist "%NODEBIN%" goto :node_missing\r
if not defined NODEBIN if exist "%DIR%${VENDORED_RUNTIME_WIN32}" set "NODEBIN=%DIR%${VENDORED_RUNTIME_WIN32}"\r
if not defined NODEBIN where node >nul 2>nul\r
if not defined NODEBIN if not errorlevel 1 set "NODEBIN=node"\r
if not defined NODEBIN goto :node_missing\r
rem ONE probe: version + interactivity in a single node start.\r
rem stdout is captured, so the interactivity verdict reads STDIN — a\r
rem user-redirected stdout is caught by the splash's own out.isTTY\r
rem self-guard (exit 0, silent). User args still ride BEHIND the --\r
rem terminator — else node consumes --version/-p/-h as ITS OWN flags and the\r
rem skip-flag law inverts.\r
rem the capture is a TEMP FILE, not a for /f over the\r
rem command — the old form re-parsed raw %%* through cmd a SECOND time\r
rem inside the for-command (with\r
rem USER argv as the payload). The probe line forwards argv exactly like\r
rem the boot line does, and the for /f reads only OUR probe's own\r
rem single-line digits-and-dots output back from the file.\r
set "NODEV="\r
set "NODETTY="\r
rem %RANDOM% is time-seeded per process — two same-second launches collide;\r
rem the %TIME% tail (colon-stripped, path-safe) discriminates them. TEMP\r
rem unset/unwritable ⇒ the file never appears and the probe falls to a\r
rem STRAIGHT boot below (the in-bundle entry gate owns the version refusal\r
rem there); an ancient node that runs-but-prints-garbage still leaves a\r
rem file, so the clean version refusal is preserved.\r
set "MERCURY_PROBE_OUT=%TEMP%\\mercury-probe-%RANDOM%-%TIME::=%.txt"\r
if not defined TEMP set "MERCURY_PROBE_OUT=%DIR%mercury-probe-%RANDOM%-%TIME::=%.txt"\r
"%NODEBIN%" -e "${SPLASH_VERSION_TTY_PROBE_JS}" -- %* >"%MERCURY_PROBE_OUT%" 2>nul\r
if not exist "%MERCURY_PROBE_OUT%" goto :boot\r
for /f "usebackq tokens=1,2" %%v in ("%MERCURY_PROBE_OUT%") do (set "NODEV=%%v" & set "NODETTY=%%w")\r
del /q "%MERCURY_PROBE_OUT%" >nul 2>nul\r
if not defined NODEV set "NODEV=none"\r
echo %NODEV%| findstr /r /c:"^${p.major}\\.[0-9][0-9]*\\.[0-9][0-9]*$" >nul || goto :node_unsupported\r
for /f "tokens=2 delims=." %%m in ("%NODEV%") do set "NODEMIN=%%m"\r
if %NODEMIN% LSS ${p.minorFloor} goto :node_unsupported\r
if not exist "%DIR%mercury.mjs" (\r
  echo mercury: mercury.mjs is missing beside this launcher 1>&2\r
  exit /b 1\r
)\r
rem ── artifact provenance (LANE LW: interactive boots; warn-only, no gate) ──\r
rem One stderr line on unsigned/tampered/unknown-key, silence when signed;\r
rem the errorlevel is deliberately never consulted — a provenance verdict\r
rem (or a verifier crash) can never cost a boot. Piped/scripted boots skip\r
rem it (NODETTY from the probe above) so automation stays byte-clean.\r
if "%NODETTY%"=="1" if exist "%DIR%verify-artifact.mjs" "%NODEBIN%" "%DIR%verify-artifact.mjs" --launcher\r
rem ── the config home (three rungs — runtime + splash resolve identically) ──\r
set "MERCURY_SA_HOME="\r
if defined MERCURY_CONFIG_DIR set "MERCURY_SA_HOME=%MERCURY_CONFIG_DIR%"\r
if not defined MERCURY_SA_HOME if defined MERCURY_HOME set "MERCURY_SA_HOME=%MERCURY_HOME%"\r
if not defined MERCURY_SA_HOME set "MERCURY_SA_HOME=%USERPROFILE%\\.mercury"\r
rem ── compile cache: V8 code cache for the bundle parse ─────────────\r
rem Must be in the environment BEFORE node compiles the entry (~0.7s parse\r
rem of the 20MB bundle on the field HDD host). Node creates the dir and\r
rem silently disables on failure; an operator's own NODE_COMPILE_CACHE wins,\r
rem NODE_DISABLE_COMPILE_CACHE opts out. Covers the splash run too.\r
rem THE WIN32 PATH BOUND (TASK-017 S2): a cache dir past 200 chars makes\r
rem node's cache machinery SPIN at one core with no output (TASK-014\r
rem w1-f15-01) — and the env form runs BEFORE any Mercury JS, so the\r
rem in-process guard (compileCachePath.ts, same 200 + \\\\?\\ opt-out)\r
rem cannot cover a launcher boot. Over the bound: skip the cache, boot on.\r
set "MERCURY_SA_CACHE=%MERCURY_SA_HOME%\\compile-cache"\r
set "MERCURY_SA_CACHE_OVER="\r
if not "%MERCURY_SA_CACHE:~200%"=="" set "MERCURY_SA_CACHE_OVER=1"\r
if "%MERCURY_SA_CACHE:~0,4%"=="\\\\?\\" set "MERCURY_SA_CACHE_OVER="\r
if not defined MERCURY_SA_CACHE_OVER if not defined NODE_COMPILE_CACHE if not defined NODE_DISABLE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%MERCURY_SA_CACHE%"\r
set "MERCURY_SA_CACHE="\r
set "MERCURY_SA_CACHE_OVER="\r
rem ── the enter screen (interactive TTY boots only) ──────────────────────────\r
rem Verbs, flags and piped stdio boot straight; the probe above carried the\r
rem TTY+flag decision. The splash self-guards non-TTY too — every gap stays\r
rem safe.\r
set "MERCURY_TAKEOVER=1"\r
for %%v in (${SPLASH_SKIP_VERBS.join(' ')}) do if "%~1"=="%%v" set "MERCURY_TAKEOVER=0"\r
if not "%NODETTY%"=="1" set "MERCURY_TAKEOVER=0"\r
if not "%MERCURY_TAKEOVER%"=="1" goto :boot\r
if not exist "%DIR%splash.mjs" goto :boot\r
if "%MERCURY_NO_BANNER%"=="1" goto :boot\r
if "%MERCURY_SPLASH%"=="off" goto :boot\r
if "%MERCURY_SPLASH%"=="static" goto :boot\r
rem LH-01: mint THIS launch's opaque id — env-down only, never parsed back\r
rem by any shell. %RANDOM% is time-seeded per process (same-second launches\r
rem collide), so the %TIME% centiseconds tail discriminates. The splash\r
rem embeds it in the receipt; the runtime consumes only its own.\r
set "MERCURY_LAUNCH_ID=cmd-%RANDOM%%RANDOM%-%TIME::=%"\r
"%NODEBIN%" "%DIR%splash.mjs"\r
set "MERCURY_SA_EXIT=%errorlevel%"\r
rem THE EXIT-CODE HANDOVER: this block parses NOTHING\r
rem the splash writes. 1.5.4 read splash-action.txt here with set /p —\r
rem against the LF-only receipt the first read swallowed the WHOLE file\r
rem into a multi-line %%MERCURY_SA_ACT%%, whose first \`if "%%...%%"\`\r
rem expansion was a malformed command: cmd ABORTED THE BATCH, node never\r
rem started, and the held alt-screen stranded the operator on the splash\r
rem frame (every Windows interactive boot). Numeric compares only now —\r
rem no batch line ever expands product-written data. Action/dir ride\r
rem splash-action.json to the RUNTIME consumer (MERCURY_SPLASH_HANDOFF=1).\r
rem   0 = handoff, screen HELD: set the alt-held marker (MERCURY_FULLSCREEN not 0)\r
rem   20 = handoff, screen RESTORED (inline mode): boot, no marker\r
rem   130 = cancel (Ctrl-C / idle): stand down, boot nothing\r
rem   else = abnormal splash death: heal the terminal, boot plain\r
if "%MERCURY_SA_EXIT%"=="130" exit /b 0\r
if "%MERCURY_SA_EXIT%"=="0" goto :sa_handoff\r
if "%MERCURY_SA_EXIT%"=="20" goto :sa_handoff\r
"%NODEBIN%" -e "process.stdout.write('\\x1b[?2026l\\x1b[0m\\x1b[?1007l\\x1b[?1049l\\x1b[?25h\\x1b]111\\x07')" >nul 2>nul\r
goto :boot\r
:sa_handoff\r
set "MERCURY_SPLASH_HANDOFF=1"\r
if "%MERCURY_SA_EXIT%"=="0" if not "%MERCURY_FULLSCREEN%"=="0" set "MERCURY_ALT_HELD=1"\r
:boot\r
"%NODEBIN%" "%DIR%mercury.mjs" %*\r
set "RT_EXIT=%errorlevel%"\r
rem post-child heal (FN-002 F1, field T4): a killed/crashed runtime cannot\r
rem restore terminal modes — the launcher is the only cover. TTY-gated\r
rem (%NODETTY%) so piped/redirected runs stay byte-clean (UI-114); skipped\r
rem on exit 0 (a clean exit restored its own modes); exit code preserved.\r
rem Focus tracking (?1004l) is re-reset AFTER ?1049l: on win32 a reset before\r
rem the alt-screen exit lands on the alt buffer, so 1004 stays armed on the\r
rem main buffer and focus flips spew ^[[I/^[[O at the dead prompt (TASK-005 L4).\r
if "%NODETTY%"=="1" if not "%RT_EXIT%"=="0" "%NODEBIN%" -e "process.stdout.write('\\x1b[?2026l\\x1b[0m\\x1b[?1000l\\x1b[?1002l\\x1b[?1003l\\x1b[?1006l\\x1b[?1004l\\x1b[?2004l\\x1b[?1007l\\x1b[?1049l\\x1b[?1004l\\x1b[?25h\\x1b]111\\x07')" 2>nul\r
exit /b %RT_EXIT%\r
:node_unsupported\r
rem the range's < and > must be caret-escaped INSIDE the echo — unescaped\r
rem they are parsed as redirects and the refusal never prints (it also\r
rem planted a stray '=24.11.0' file beside the cwd).\r
echo mercury: ${p.label} ^(${p.range.replace(/([<>])/g, '^$1')}^) is required, found %NODEV% 1>&2\r
echo          install a current Node ${p.major}.x from https://nodejs.org, point MERCURY_NODE at one, or re-extract the release archive for its vendored runtime 1>&2\r
exit /b 1\r
:node_missing\r
rem No rung answered. Neither MERCURY_NODE nor the launcher directory is\r
rem echoed: a value with cmd metacharacters would run inside the echo.\r
echo mercury: no usable Node runtime - none of the three rungs answered: 1>&2\r
echo          1. MERCURY_NODE is unset, or names no existing file ^(point it at a Node ${p.major}.x binary to choose one explicitly^) 1>&2\r
echo          2. no vendored runtime beside this launcher at ${VENDORED_RUNTIME_WIN32} ^(re-extract the release archive intact - it carries one^) 1>&2\r
echo          3. no 'node' on PATH ^(install ${p.label}, ${p.range.replace(/([<>])/g, '^$1')}, from https://nodejs.org^) 1>&2\r
exit /b 1\r
`
}

/** PowerShell launcher (mercury.ps1) — full-range check + console UTF-8 +
 * the enter-screen chain. The fixes carried:
 *  ($PSScriptRoot — $MyInvocation.MyCommand.Path is empty when dot-sourced
 *  or run through -Command, resolving every Join-Path against the CWD),
 *  the native splash-action read, and the cancel handover. */
export function ps1Launcher(p) {
  return `# Mercury launcher (PowerShell) - needs ${p.label} (${p.range})
$dir = $PSScriptRoot
# PS-01: launcher-owned environment keys are a REVERSIBLE
# transaction. Invoked from an interactive PowerShell session this script
# runs in the CALLER'S runspace — 1.5.4 left its markers behind, so a later
# splash-skipping run inherited a stale held-screen claim and unrelated node
# runs inherited Mercury's compile-cache location. Snapshot here, restore in
# the finally below on EVERY outcome (ready, cancel, refusal, child error).
# Console encodings stay deliberately unrestored (the
# rule: the runtime seam restores only what IT changes).
$mercuryOwnedEnv = @('MERCURY_SPLASH_HANDOFF','MERCURY_ALT_HELD','MERCURY_LAUNCH_ID','MERCURY_WIN32_UTF8_PRESET','NODE_COMPILE_CACHE')
$mercuryEnvSnapshot = @{}
foreach ($k in $mercuryOwnedEnv) { $mercuryEnvSnapshot[$k] = [Environment]::GetEnvironmentVariable($k) }
try {
# Console UTF-8: raw UTF-8 frame bytes decode under the console codepage —
# set BOTH encodings (SetConsoleCP + SetConsoleOutputCP equivalent). Never
# restored here; the runtime seam restores only what IT changes. The PRESET
# marker lets the runtime seam skip even its chcp query spawn.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
  $env:MERCURY_WIN32_UTF8_PRESET = '1'
} catch { }
# -- the runtime (three rungs, first hit wins): MERCURY_NODE (an explicit
# binary) - the vendored runtime beside the bundle (${VENDORED_RUNTIME_WIN32}) -
# a PATH node. No rung is silent: a pinned-but-missing MERCURY_NODE refuses,
# and the rung picked is checked against the FULL supported range below.
$nodeBin = $null
if ($env:MERCURY_NODE) {
  if (Test-Path -LiteralPath $env:MERCURY_NODE -PathType Leaf) { $nodeBin = $env:MERCURY_NODE }
} elseif (Test-Path -LiteralPath (Join-Path $dir '${VENDORED_RUNTIME_WIN32}') -PathType Leaf) {
  $nodeBin = Join-Path $dir '${VENDORED_RUNTIME_WIN32}'
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $nodeBin = 'node'
}
if (-not $nodeBin) {
  Write-Error "mercury: no usable Node runtime - none of the three rungs answered: 1. MERCURY_NODE is unset, or names no existing file (point it at a Node ${p.major}.x binary to choose one explicitly); 2. no vendored runtime beside this launcher at ${VENDORED_RUNTIME_WIN32} (re-extract the release archive intact - it carries one); 3. no 'node' on PATH (install ${p.label}, ${p.range}, from https://nodejs.org)"
  exit 1
}
$nodev = (& $nodeBin -p 'process.versions.node' 2>$null)
$nodeOk = $false
if ($nodev -match '^(\\d+)\\.(\\d+)\\.(\\d+)$') {
  $nodeOk = ([int]$Matches[1] -eq ${p.major}) -and ([int]$Matches[2] -ge ${p.minorFloor})
}
if (-not $nodeOk) { Write-Error "mercury: ${p.label} (${p.range}) is required (found v$nodev at $nodeBin) - install a current Node ${p.major}.x from https://nodejs.org, point MERCURY_NODE at one, or re-extract the release archive for its vendored runtime"; exit 1 }
if (-not (Test-Path (Join-Path $dir 'mercury.mjs'))) { Write-Error "mercury: mercury.mjs missing beside this launcher"; exit 1 }
# -- the config home (three rungs -- runtime + splash resolve identically) --
$saHome = if ($env:MERCURY_CONFIG_DIR) { $env:MERCURY_CONFIG_DIR }
  elseif ($env:MERCURY_HOME) { $env:MERCURY_HOME }
  else { Join-Path $HOME '.mercury' }
# -- compile cache: V8 code cache for the bundle parse --
# Must be in the environment BEFORE node compiles the entry (~0.7s parse of
# the 20MB bundle on the field HDD host). Node creates the dir and silently
# disables on failure; an operator's own NODE_COMPILE_CACHE wins,
# NODE_DISABLE_COMPILE_CACHE opts out. Covers the splash run too.
# THE WIN32 PATH BOUND (TASK-017 S2): past 200 chars node's cache machinery
# spins at one core with no output (TASK-014 w1-f15-01), and the env form
# runs before any Mercury JS — the in-process guard (compileCachePath.ts,
# same 200 + \\\\?\\ opt-out) cannot cover a launcher boot. Over the bound:
# skip the cache, boot on.
$saCache = Join-Path $saHome 'compile-cache'
if (-not $env:NODE_COMPILE_CACHE -and -not $env:NODE_DISABLE_COMPILE_CACHE -and
    ($saCache.Length -le 200 -or $saCache.StartsWith('\\\\?\\'))) {
  $env:NODE_COMPILE_CACHE = $saCache
}
# -- the enter screen (interactive TTY boots only) --
# Verbs, flags and redirected stdio boot straight; the splash self-guards
# non-TTY too. Case-sensitive matching mirrors the binary's arg parser.
$takeover = $true
$skipVerbs = @(${SPLASH_SKIP_VERBS.map(v => `'${v}'`).join(',')})
$skipFlags = @(${SPLASH_SKIP_FLAGS.map(f => `'${f}'`).join(',')})
if ($args.Count -gt 0 -and ($skipVerbs -ccontains [string]$args[0])) { $takeover = $false }
if ($args.Count -gt 0 -and ([string]$args[0]).StartsWith('-')) { $takeover = $false }
foreach ($mercuryArg in $args) { if ($skipFlags -ccontains [string]$mercuryArg) { $takeover = $false } }
$interactive = $false
try { $interactive = (-not [Console]::IsInputRedirected) -and (-not [Console]::IsOutputRedirected) } catch { }
# -- artifact provenance (LANE LW: interactive boots; warn-only, never a gate)
# One stderr line on unsigned/tampered/unknown-key, silence when signed; the
# exit code is deliberately never consulted and a crash is swallowed — a
# provenance verdict can never cost a boot. Non-interactive runs skip it.
if ($interactive -and (Test-Path (Join-Path $dir 'verify-artifact.mjs'))) {
  try { & $nodeBin (Join-Path $dir 'verify-artifact.mjs') --launcher } catch { }
}
$splashPath = Join-Path $dir 'splash.mjs'
$splashMode = if ($env:MERCURY_SPLASH) { $env:MERCURY_SPLASH } else { '' }
$noBanner = if ($env:MERCURY_NO_BANNER) { $env:MERCURY_NO_BANNER } else { '' }
if ($takeover -and $interactive -and (Test-Path $splashPath) -and ($noBanner -ne '1') -and ($splashMode -ne 'off') -and ($splashMode -ne 'static')) {
  #mint THIS launch's opaque id — env-down only, never parsed back.
  # The splash embeds it in the receipt; the runtime consumes only its own.
  $env:MERCURY_LAUNCH_ID = "ps-$PID-$(Get-Random)"
  & $nodeBin $splashPath
  $saExit = $LASTEXITCODE
  # THE EXIT-CODE HANDOVER: this launcher parses NOTHING
  # the splash writes — 1.5.4's cmd reader aborted its whole batch parsing
  # the receipt file, so the class is closed in all three launchers at once.
  # Numeric branches only; action/dir ride splash-action.json to the RUNTIME
  # consumer (armed by MERCURY_SPLASH_HANDOFF=1).
  #   0 handoff+HELD (alt-held marker) - 20 handoff+RESTORED (no marker) -
  #   130 cancel (stand down) - else abnormal (heal + plain boot).
  if ($saExit -eq 130) { exit 0 }
  if (($saExit -eq 0) -or ($saExit -eq 20)) {
    $env:MERCURY_SPLASH_HANDOFF = '1'
  } else {
    & $nodeBin -e "process.stdout.write('\\x1b[?2026l\\x1b[0m\\x1b[?1007l\\x1b[?1049l\\x1b[?25h\\x1b]111\\x07')" 2>$null
  }
  if (($saExit -eq 0) -and ($env:MERCURY_FULLSCREEN -ne '0')) { $env:MERCURY_ALT_HELD = '1' }
}
& $nodeBin (Join-Path $dir 'mercury.mjs') @args
$rtExit = $LASTEXITCODE
# post-child heal: TTY-gated, abnormal-exit only, code preserved. Focus
# tracking (?1004l) is re-reset AFTER ?1049l: on win32 a reset written before
# the alt-screen exit lands on the alt buffer, so 1004 stays armed on the main
# buffer and focus flips spew ^[[I/^[[O at the dead prompt (field TASK-005 L4).
if ((-not [Console]::IsOutputRedirected) -and ($rtExit -ne 0)) {
  & $nodeBin -e "process.stdout.write('\\x1b[?2026l\\x1b[0m\\x1b[?1000l\\x1b[?1002l\\x1b[?1003l\\x1b[?1006l\\x1b[?1004l\\x1b[?2004l\\x1b[?1007l\\x1b[?1049l\\x1b[?1004l\\x1b[?25h\\x1b]111\\x07')" 2>$null
}
exit $rtExit
} finally {
  # PS-01: restore every launcher-owned key to its pre-call existence+value —
  # the child received its env at spawn; the CALLER's session stays clean.
  foreach ($k in $mercuryOwnedEnv) {
    if ($null -eq $mercuryEnvSnapshot[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($k, $mercuryEnvSnapshot[$k]) }
  }
}
`
}

/** README-FIRST.md — the shortest successful path first, then the facts. */
export function readmeFirst(p, version) {
  return `# Mercury ${version} — start here

## Quick start (three steps)

1. **Nothing to install first.** The archive carries its own Node runtime
   (${p.label}) beside \`mercury.mjs\`, and every launcher runs on it. To run
   on a Node of your own instead, point \`MERCURY_NODE\` at its binary, or
   keep one on PATH inside ${p.range} and delete \`vendor/node\` (newer majors
   are not yet qualified).
   **Windows additionally requires Git for Windows (git-bash)** —
   https://git-scm.com/downloads/win — Mercury runs its shell through git-bash's
   \`bash.exe\`. If it is installed but not on PATH, point Mercury at it:
   \`MERCURY_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe\`.
2. **Extract this archive anywhere** (a path with spaces is fine).
3. **Run it:**
   - macOS / Linux: \`./mercury/mercury\`
   - Windows: \`mercury\\mercury.cmd\` (or \`mercury.ps1\` from PowerShell)

First run walks you through theme + login with your own Anthropic account and
model choice. \`./mercury/mercury --help\` works without an account, and
\`./mercury/mercury doctor\` checks the installation's health (add \`--json\`
for a machine-readable certificate).

## Make it a real install (optional, recommended)

\`\`\`
./mercury/mercury install        # macOS / Linux
mercury\\mercury.cmd install     # Windows
\`\`\`

This copies the extracted payload into a per-version directory under your
Mercury home and places ONE stable \`mercury\` command in a user-local bin
directory (\`~/.local/bin\` on macOS/Linux, \`%LOCALAPPDATA%\\Mercury\\bin\` on
Windows — it prints exactly what it changed and whether you need a PATH
entry). No administrator access, no npm, rerunning it is a no-op.
\`mercury install --dry-run\` describes the change without making it;
\`mercury install --uninstall\` removes the managed binaries and never your
configuration or sessions. (\`install.sh\` / \`install.ps1\` in this folder run
the same verb.) See INSTALLING.md for the full layout.

## Staying current (private beta channel)

Updates come from the PRIVATE Mercury repository, so they need two things:
collaborator access to that repository and a signed-in GitHub CLI
(\`gh auth status\` should say you are logged in — otherwise \`gh auth login\`).

\`\`\`
mercury update --check      # is a newer private beta available?
mercury update              # download, verify checksums, stage, activate
mercury update --rollback   # return to the previously installed version
mercury update --status     # what is installed, where, and channel access
\`\`\`

Every update verifies the release's SHA256SUMS.txt before anything activates,
keeps the previous version installed, and restores it automatically if the
new one fails its startup smoke. See UPDATING.md for every failure mode and
manual recovery. Mercury never publishes to npm and never auto-updates in the
background — updates happen only when you run the command.

## The facts

- **Supported platforms:** Linux x64 · macOS arm64 (Apple silicon) ·
  Windows x64. macOS Intel is not packaged (the source build covers it).
- **Launch confirmations:** none expected from a terminal. On Windows,
  PowerShell's execution policy may block \`mercury.ps1\` — use
  \`mercury.cmd\`, which needs no policy change.
- **The enter screen:** an interactive terminal boot opens Mercury's launch
  card first (recent projects, quick actions, the boot menu on \`m\`) and
  hands over into the session. Verbs (\`doctor\`, \`update\`, …), flags
  (\`--version\`, \`-p\`, …) and piped/scripted use always boot straight;
  \`MERCURY_NO_BANNER=1\` or \`MERCURY_SPLASH=off\` skips it entirely.
- **Windows rendering:** the launcher and the runtime set the console to
  UTF-8 automatically. If box-drawing characters still render as
  \`ΓöÇ\`-style mojibake (an older install or a custom launch path), run
  \`chcp 65001\` in that console — or enable Windows' system-wide
  "Beta: Use Unicode UTF-8" setting. Four Windows Terminal settings
  interact with the enter screen:
  - **Acrylic / opacity** (\`useAcrylic\`, \`opacity\` below 100): the enter
    screen paints no background of its own — everything rides the terminal's
    *default* background, so the window padding and the canvas composite
    identically and translucent profiles stay whole. To keep your own
    terminal ground untouched set \`MERCURY_OASIS_BG=0\` (never recolour
    the ground).
  - **\`snapToGridOnResize: false\`** leaves up to one cell of window edge
    outside the character grid (thicker on the right/bottom); setting it
    \`true\` makes the frame symmetric.
  - **\`cellHeight\`** other than \`1.0\` adds leading the logo's half-block
    art cannot fill — the wordmark stretches and hairline seams appear
    between raster rows. Cosmetic only.
  - **A \`ctrl+c\` → copy keybinding** with \`copyOnSelect: false\` swallows
    Mercury's cancel key while a selection persists — click to clear the
    selection, then Ctrl-C cancels normally.
- **Your data:** configuration, sessions and login live in your Mercury home
  (\`~/.mercury\`, or whatever \`MERCURY_CONFIG_DIR\` names;
  \`%USERPROFILE%\\.mercury\` on Windows) — OUTSIDE the install. Updating,
  rolling back and uninstalling never touch them.
- **Report a problem with:** the output of \`mercury --version\` and
  \`mercury doctor --json\`, plus what you ran.
- **Advanced controls:** the full cockpit (the Helm) appears in terminals
  ≥100 columns wide; \`/help\` lists every command, \`/model\` switches
  models/providers, \`/appearance\` themes. Portable use straight from the
  extracted folder keeps working forever — installing is optional.
- **Private-beta limitations:** distribution is restricted to repository
  collaborators; Windows support is CI-verified but has had less live
  operator time than macOS/Linux; there is no automatic background update.
- **Release notes:** RELEASE-NOTES.md in this folder covers what changed.

This archive is self-contained: no Node install, no npm install, no source
checkout, no Bun. The \`vendor\` directory (the Node runtime, ripgrep, the
language packs) must stay beside \`mercury.mjs\`.

Third-party notices + origin facts: \`NOTICES.md\` in this folder. Mercury is
a standalone, source-built product.
`
}

/** INSTALLING.md — portable + user-local install detail. */
export function installingDoc(p, version) {
  return `# Installing Mercury ${version}

Two coherent paths, one runtime. Both run on the Node the archive carries
(\`vendor/node\`, ${p.label}); \`MERCURY_NODE\` or a PATH node inside
${p.range} may stand in for it.

## Portable (zero install)

Extract the archive anywhere — including paths with spaces — and run the
launcher in place (\`./mercury/mercury\`, or \`mercury\\mercury.cmd\` /
\`mercury.ps1\` on Windows). Everything the runtime needs sits beside
\`mercury.mjs\`; nothing is written outside your Mercury home
(\`~/.mercury\`). This path never requires the installer.

On Windows the launchers set the console to UTF-8 (\`chcp 65001\`); if glyphs
render as \`ΓöÇ\`-style mojibake under a custom launch path, run
\`chcp 65001\` in that console or enable Windows' system-wide
"Beta: Use Unicode UTF-8" setting.

## User-local install (\`mercury install\`)

Run \`mercury install\` from the extracted folder's own launcher (or
\`install.sh\` / \`install.ps1\`, which run the same verb). It:

1. copies the payload to \`<mercury home>/versions/<version>/\`;
2. smoke-tests the copy (\`--version\` must print this release);
3. switches the ONE pointer file \`versions/current.txt\` atomically;
4. writes the stable \`mercury\` command — \`~/.local/bin/mercury\` on
   macOS/Linux, \`%LOCALAPPDATA%\\Mercury\\bin\\mercury.cmd\` on Windows —
   and tells you if that directory needs adding to PATH.

Properties you can rely on:

- **No administrator access.** Everything is user-owned.
- **Idempotent.** Rerunning with the same archive changes nothing and says so.
- **Never npm, never a source checkout.**
- **Previous versions stay.** Installing or updating never deletes the
  version you were on; \`mercury update --rollback\` returns to it.
- **Safe against your own launchers.** If a non-Mercury-managed file already
  sits at the stable command path, it is left alone and named — \`--force\`
  replaces it with a \`.bak\` kept beside it.
- **Uninstall preserves your data.** \`mercury install --uninstall\` removes
  \`versions/\` and the managed command only; configuration, sessions and
  login stay.
- **Dry run.** \`mercury install --dry-run\` prints what would change.

## Where things live

| What | Where |
|---|---|
| Installed versions | \`<mercury home>/versions/<version>/\` |
| Active-version pointer | \`<mercury home>/versions/current.txt\` (one line) |
| Stable command | \`~/.local/bin/mercury\` · \`%LOCALAPPDATA%\\Mercury\\bin\\mercury.cmd\` |
| Configuration + sessions | \`<mercury home>\` (\`~/.mercury\`; \`MERCURY_CONFIG_DIR\` overrides) |

Manual recovery is deliberately simple: \`current.txt\` is a plain text file
naming the active version directory — edit it if automation ever cannot.
`
}

/** UPDATING.md — check, apply, every failure mode, rollback, recovery. */
export function updatingDoc(p, version) {
  return `# Updating Mercury (private beta channel)

Mercury ${version} updates from the PRIVATE Mercury GitHub repository only —
through YOUR already-signed-in GitHub CLI. There is no npm package, no public
download endpoint, and no background auto-update. Mercury never prints or
stores your GitHub credentials; \`gh\` holds them itself.

## Prerequisites

- collaborator access to the private Mercury repository;
- GitHub CLI installed and signed in — \`gh auth status\` confirms readiness;
- no Node install: every archive carries its own runtime (${p.label}), and an
  updated version brings its own.

## The commands

\`\`\`
mercury update --check      # report installed vs available, change nothing
mercury update              # perform the update end to end
mercury update --rollback   # switch back to the previous installed version
mercury update --status     # layout, versions present, channel access
\`\`\`

A normal update: discovers the newest convention-valid private prerelease,
downloads YOUR platform's archive plus SHA256SUMS.txt from that SAME release,
verifies the SHA-256 locally, extracts and checks the embedded version,
smoke-tests the staged copy, switches the current pointer atomically, keeps
the previous version installed, then smoke-tests the switched install —
restoring the previous pointer automatically if that last check fails.

## What each state means

- **"Mercury is current"** — no newer private release exists. Exit 0.
- **"no private releases found"** — the channel has no release yet. Exit 0.
- **Access unavailable** — \`gh\` missing, signed out, or your account cannot
  see the private repository. The message names which, with the remedy
  (install gh · \`gh auth login\` · ask for a collaborator invite). Nothing
  was downloaded or changed.
- **No asset for this platform** — the release exists but does not carry your
  OS/architecture archive. Reported honestly; nothing changes.
- **Checksum refusal** — the downloaded bytes do not match the release's
  SHA256SUMS.txt (or the entry is missing/duplicated/malformed). The
  download is discarded; the active install is untouched. Rerun the update;
  if it repeats, report it — the release publication is inconsistent.
- **Interrupted download** — nothing was activated; staging is cleaned up on
  the next run. Rerun \`mercury update\`.
- **Staged smoke failure** — the new version failed \`--version\` before
  activation; nothing was switched. Report it.
- **Post-switch smoke failure** — the new version activated but failed its
  startup check; the PREVIOUS pointer was restored automatically and the
  message says which version is active.
- **Another update already running** — one update at a time; if a crashed run
  left the lock behind, remove \`<mercury home>/versions/.update.lock\` and
  retry.

Every attempted update writes a local receipt —
\`<mercury home>/versions/last-update.json\` — recording the transaction id,
the stage reached, the outcome and the versions involved. A refusal names its
stage and this receipt path; include the receipt when reporting a problem.
Crashed-run leftovers (\`.download-*\`, \`.staging-*\`) are reconciled
automatically at the start of the next update; a displaced working copy from
an interrupted replacement is restored, never deleted.

## Rollback

\`mercury update --rollback\` switches to the previously installed version —
only if its files are still intact (verified first). It refuses honestly when
no previous complete version exists. The newer version stays on disk for
diagnosis; \`mercury update\` re-activates it. Your configuration and sessions
are untouched in both directions.

## Manual recovery (when automation cannot finish)

The active version is chosen by ONE plain text file:
\`<mercury home>/versions/current.txt\` — a single line naming a directory
under \`versions/\`. If an update is interrupted at the worst possible moment,
open that file and set it to any version directory that exists (for example
the one you were on); the stable \`mercury\` command follows it immediately.

One Windows rendering note: updated launchers set the console to UTF-8; if
box-drawing glyphs still render as \`ΓöÇ\`-style mojibake, run \`chcp 65001\`
in that console or enable Windows' system-wide "Beta: Use Unicode UTF-8"
setting.
`
}
