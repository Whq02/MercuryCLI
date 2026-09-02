#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-launchers.ts — U4: every generated
//  launcher checks the FULL supported range, with the decision logic exercised
//  for real via fake-`node` PATH shims (the shim reports an arbitrary version;
//  the launcher's own logic decides).
//    (1) parseEnginesNode: strict shape, refuses unknown shapes, agrees with
//        the ONE policy owner
//    (2) POSIX release launcher: accept/refuse matrix · argument forwarding
//        (spaces preserved) · exit-code propagation · spaced install path
//    (4) CMD + PS1: full-range check present structurally (the CMD
//        existence-only gap is CLOSED); optional pwsh execution leg
//    (5) README-FIRST + kit README carry the label, never "20+"
// ============================================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// launcher templates are plain .mjs (node-importable for package.mjs; bun-importable here)
// @ts-ignore -- untyped .mjs module
import { cmdLauncher, parseEnginesNode, posixLauncher, ps1Launcher, readmeFirst, SPLASH_SKIP_FLAGS, SPLASH_SKIP_VERBS, SPLASH_VERSION_TTY_PROBE_JS } from '../release/launcherTemplates.mjs'
// The namespace form lets section (8) read the derivation exports by name
// without the whole prover failing to link on a tree that lacks them.
// @ts-ignore -- untyped .mjs module
import * as templates from '../release/launcherTemplates.mjs'
import { NODE_SUPPORT } from '../../src/utils/runtime/nodePolicy.js'
import { resolveProofHome } from '../lib/proofHome.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

//
section('(1) parseEnginesNode — strict, refusing, owner-agreeing')
const pkg = JSON.parse(require('node:fs').readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { engines?: { node?: string } }
const policy = parseEnginesNode(pkg.engines?.node)
check('policy derives from package.json engines', policy.range === pkg.engines?.node)
check('policy agrees with the ONE owner (range/label/major)', policy.range === NODE_SUPPORT.range && policy.label === NODE_SUPPORT.label && policy.major === NODE_SUPPORT.major)
check('minor floor matches the owner minimum', policy.minorFloor === Number(NODE_SUPPORT.minimum.split('.')[1]))
for (const badShape of ['>=20', '>=24', '24.x', '>=24.11.0 <26', '>=24.11.0', undefined]) {
  let threw = false
  try {
    parseEnginesNode(badShape)
  } catch {
    threw = true
  }
  check(`parseEnginesNode refuses ${JSON.stringify(badShape)}`, threw)
}

//
// Shim harness: a spaced install dir, a stub mercury.mjs (echoes argv JSON,
// exits per --exit), and a fake `node` first on PATH reporting
// FAKE_NODE_VERSION for version probes while delegating real execution.
const base = mkdtempSync(join(tmpdir(), 'uplift launchers '))
const appDir = join(base, 'mercury app')
const shimDir = join(base, 'shim')
mkdirSync(appDir, { recursive: true })
mkdirSync(shimDir, { recursive: true })
const STUB = `const args = process.argv.slice(2)
console.log(JSON.stringify(args))
const i = args.indexOf('--exit')
process.exit(i === -1 ? 0 : Number(args[i + 1]))
`
writeFileSync(join(appDir, 'mercury.mjs'), STUB)
writeFileSync(
  join(shimDir, 'node'),
  `#!/bin/sh
# fake node: version probes read FAKE_NODE_VERSION; execution delegates to the real node
case "$1" in
  -p) echo "$FAKE_NODE_VERSION"; exit 0 ;;
  -v|--version) echo "v$FAKE_NODE_VERSION"; exit 0 ;;
esac
exec "${process.execPath}" "$@"
`,
)
chmodSync(join(shimDir, 'node'), 0o755)
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch. The launcher resolves its config home for the
// NODE_COMPILE_CACHE export (MERCURY_CONFIG_DIR is the top rung) — un-pinned,
// these accept legs would export a cache dir under the OPERATOR'S real home
// and the delegated real-node run would write compile-cache artifacts there.
// Pin every spelling the chain consults, like the section-(7) chainEnv.
const SHIM_HOME = resolveProofHome([process.cwd()])
const shimEnv = (v: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${shimDir}:${process.env.PATH}`,
  FAKE_NODE_VERSION: v,
  MERCURY_CONFIG_DIR: SHIM_HOME,
  MERCURY_HOME: SHIM_HOME,
  MERCURY_HOME: SHIM_HOME,
})

const MATRIX: Array<[string, 'accept' | 'refuse']> = [
  ['18.19.1', 'refuse'],
  ['20.19.0', 'refuse'],
  ['22.21.0', 'refuse'],
  ['23.11.1', 'refuse'],
  ['24.0.0', 'refuse'],
  ['24.10.9', 'refuse'],
  ['24.11.0', 'refuse'],
  ['24.18.0', 'refuse'],
  ['24.19.0', 'refuse'],
  ['24.20.0', 'accept'],
  ['24.99.5', 'accept'],
  ['24.12.0-nightly20260601', 'refuse'],
  ['25.0.0', 'refuse'],
  ['26.1.0', 'refuse'],
  ['garbage', 'refuse'],
]

//
section('(2) POSIX release launcher — matrix + forwarding + exit codes')
const launcherPath = join(appDir, 'mercury')
writeFileSync(launcherPath, posixLauncher(policy))
chmodSync(launcherPath, 0o755)
for (const [v, want] of MATRIX) {
  const r = spawnSync('sh', [launcherPath, 'probe arg'], { encoding: 'utf8', env: shimEnv(v), timeout: 30_000 })
  if (want === 'accept') {
    check(`POSIX ${v} → accepted`, r.status === 0 && r.stdout.trim().startsWith('["probe arg"]'), `status=${r.status} out=${r.stdout.slice(0, 80)} err=${r.stderr.slice(0, 120)}`)
  } else {
    check(`POSIX ${v} → refused`, r.status === 1 && r.stderr.includes(policy.label) && r.stderr.includes(policy.range), `status=${r.status} err=${r.stderr.slice(0, 160)}`)
  }
}
{
  const r = spawnSync('sh', [launcherPath, 'a b', '--exit', '7', 'c'], { encoding: 'utf8', env: shimEnv(NODE_SUPPORT.minimum), timeout: 30_000 })
  check('POSIX forwards args verbatim (spaces preserved)', r.stdout.trim() === '["a b","--exit","7","c"]', r.stdout.trim())
  check('POSIX propagates the exit code (exec)', r.status === 7, `status=${r.status}`)
}

//
section('(4) CMD + PS1 — the full-range check is present (gap closed)')
const cmd = cmdLauncher(policy)
check('CMD probes the real version (existence-only gap CLOSED)', cmd.includes('process.versions.node'))
check('CMD anchors the supported major', cmd.includes(`findstr /r /c:"^${policy.major}\\.`))
check('CMD enforces the minor floor', cmd.includes(`LSS ${policy.minorFloor}`))
check('CMD names label + range in the refusal (range < > caret-escaped so the echo actually prints)', cmd.includes(policy.label) && cmd.includes(`^(${policy.range.replace(/([<>])/g, '^$1')}^)`) && !cmd.includes(`^(${policy.range}^)`))
// the boot tail captures the code BEFORE the post-child heal and
// returns the RUNTIME's code, never the heal's (the heal is TTY-gated +
// abnormal-only — piped runs stay byte-clean per UI-114).
check('CMD propagates the exit code (captured across the F1 heal)', cmd.includes('set "RT_EXIT=%errorlevel%"') && cmd.includes('exit /b %RT_EXIT%'))
check('CMD heal is TTY-gated + abnormal-only', cmd.includes('if "%NODETTY%"=="1" if not "%RT_EXIT%"=="0"'))
const ps1 = ps1Launcher(policy)
check('PS1 checks major equality + minor floor', ps1.includes(`-eq ${policy.major}`) && ps1.includes(`-ge ${policy.minorFloor}`))
check('PS1 refuses prerelease via the strict triple regex', ps1.includes("-match '^(\\d+)\\.(\\d+)\\.(\\d+)$'"))
check('PS1 propagates the exit code (captured across the F1 heal)', ps1.includes('$rtExit = $LASTEXITCODE') && ps1.includes('exit $rtExit'))
check('PS1 heal is TTY-gated + abnormal-only', ps1.includes('(-not [Console]::IsOutputRedirected) -and ($rtExit -ne 0)'))
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 15_000 })
if (pwsh.status === 0) {
  const ps1Path = join(appDir, 'mercury.ps1')
  writeFileSync(ps1Path, ps1)
  const r = spawnSync('pwsh', ['-NoProfile', '-File', ps1Path, 'ps probe'], { encoding: 'utf8', env: shimEnv('22.21.0'), timeout: 30_000 })
  check('PS1 22.21.0 → refused (pwsh available)', r.status === 1, `status=${r.status}`)
  const r2 = spawnSync('pwsh', ['-NoProfile', '-File', ps1Path, 'ps probe'], { encoding: 'utf8', env: shimEnv(NODE_SUPPORT.minimum), timeout: 30_000 })
  check(`PS1 ${NODE_SUPPORT.minimum} → accepted (pwsh available)`, r2.status === 0 && r2.stdout.includes('["ps probe"]'), `status=${r2.status} out=${r2.stdout.slice(0, 80)}`)
} else {
  console.log('  [SKIP] pwsh not on this machine — PS1/CMD execution rides the windows-x64 private-release smoke; structure asserted above')
}

//
section('(5) generated copy carries the label, never 20+')
const readme = readmeFirst(policy, '9.9.9-test')
check('README-FIRST requires the label + full range', readme.includes(policy.label) && readme.includes(policy.range))
check('README-FIRST never says 20+/18+', !readme.includes('20+') && !readme.includes('18+'))

//
// WINDOWS FRIEND-PATH HOTFIX: console UTF-8 + the enter-screen
// chain in every generated launcher.
section('(6) console UTF-8 + enter-screen chain — structural, all three')
{
  const posix = posixLauncher(policy)
  const cmdT = cmdLauncher(policy)
  const ps1T = ps1Launcher(policy)

  check('CMD sets the console codepage before node runs', cmdT.includes('chcp 65001 >nul 2>nul') && cmdT.indexOf('chcp 65001') !== -1 && cmdT.indexOf('chcp 65001') < cmdT.indexOf('where node'))
  check('PS1 sets BOTH console encodings to UTF-8', ps1T.includes('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false') && ps1T.includes('[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false'))

  for (const [name, text] of [['POSIX', posix], ['CMD', cmdT], ['PS1', ps1T]] as const) {
    check(`${name} chains the packaged splash`, text.includes('splash.mjs'))
    check(`${name} hands over via MERCURY_ALT_HELD`, text.includes('MERCURY_ALT_HELD'))
    check(`${name} honors MERCURY_NO_BANNER + MERCURY_SPLASH=off`, text.includes('MERCURY_NO_BANNER') && text.includes('MERCURY_SPLASH'))
    for (const verb of ['doctor', 'install', 'update', 'acp', 'join']) {
      check(`${name} boots straight for the '${verb}' verb`, text.includes(verb))
    }
    check(`${name} still boots mercury.mjs with forwarded args`, text.includes('mercury.mjs'))
    // The post-child heal re-resets focus tracking (?1004l) AFTER the alt-screen
    // exit (?1049l): on win32 a 1004 reset written before ?1049l lands on the alt
    // buffer and focus tracking stays armed on the main buffer, so the dead
    // prompt spews ^[[I/^[[O on focus flips (field TASK-005 L4).
    check(`${name} post-child heal resets focus tracking after the alt-screen exit`, text.includes('?1049l\\x1b[?1004l\\x1b[?25h'))
    // Every heal OPENS with ?2026l (the synchronized-update close): ink/root/
    // teardown.ts writes ESU first because a paint killed between BSU and ESU
    // must not leave the terminal frozen — and the heals exist for exactly the
    // runtime that never reached its own teardown (TASK-017 S2,
    // exit-heals-omit-synchronized-update-close).
    const heals = text.split('\n').filter(l => l.includes('process.stdout.write(') && l.includes('?1049l'))
    check(`${name} both heals open with ?2026l`, heals.length === 2 && heals.every(l => l.includes('\\x1b[?2026l\\x1b[0m')))
  }
  check('POSIX gates on BOTH stdin+stdout TTY', posix.includes('[ -t 0 ] && [ -t 1 ]'))
  // NO launcher parses anything the splash writes — the
  // embedded JSON consumer, the plain-twin readers and the receipt deletes
  // are all GONE; the handover is the splash's exit code + the runtime's
  // MERCURY_SPLASH_HANDOFF consumer. These negative pins are the class
  // ratchet: a reintroduced reader is a gate red, not a code review find.
  check('POSIX carries no splash-action reader (BM-30 ratchet)', !posix.includes('IFS= read -r MERCURY_SA_ACT') && !posix.includes('rm -f "$MERCURY_SA_TXT"') && !posix.includes('SPLASH_ACTION_CONSUMER'))
  check('CMD carries no splash-action reader (BM-30 ratchet — the killer line)', !cmdT.includes('set /p "') && !cmdT.includes('<"%MERCURY_SA_HOME%') && !cmdT.includes('del /q "%MERCURY_SA_HOME%'))
  check('PS1 carries no splash-action reader (BM-30 ratchet)', !ps1T.includes('Get-Content -LiteralPath $saTxt') && !ps1T.includes("Join-Path $saHome 'splash-action.txt'"))
  check('all THREE arm the runtime consumer on a handoff (MERCURY_SPLASH_HANDOFF=1 on exit 0 AND 20)', posix.includes('MERCURY_SPLASH_HANDOFF=1') && cmdT.includes('set "MERCURY_SPLASH_HANDOFF=1"') && ps1T.includes("$env:MERCURY_SPLASH_HANDOFF = '1'"))
  // every launcher mints an opaque per-launch id before the splash —
  // env-down only (no shell ever parses it back); the runtime consumer
  // id-gates receipt application so simultaneous launches stay isolated.
  check('all THREE mint MERCURY_LAUNCH_ID before the splash (LH-01)', posix.includes('MERCURY_LAUNCH_ID="posix-$$-') && cmdT.includes('set "MERCURY_LAUNCH_ID=cmd-%RANDOM%') && ps1T.includes('$env:MERCURY_LAUNCH_ID = "ps-$PID-'))
  // PS-01: the ps1 launcher runs in the CALLER'S runspace — every
  // launcher-owned env key is snapshot at entry and restored in finally.
  check('PS1 snapshots + restores its owned env keys (PS-01 transaction)', ps1T.includes('$mercuryEnvSnapshot') && ps1T.includes('} finally {') && ps1T.includes("'MERCURY_SPLASH_HANDOFF','MERCURY_ALT_HELD','MERCURY_LAUNCH_ID','MERCURY_WIN32_UTF8_PRESET','NODE_COMPILE_CACHE'"))
  check(
    'the runtime entry carries the consumer (cli.tsx consumes the receipt the launchers no longer touch)',
    readFileSync(join(import.meta.dir, '../../src/entrypoints/cli.tsx'), 'utf8').includes('consumeSplashHandover'),
  )

  // the dash law — ANY leading-dash FIRST argument skips
  // the splash takeover (flags mean "I know what I want"; the enter screen
  // is for bare boots). The field shape: `mercury --rollback` fell into the
  // takeover — on the wedged Windows host, into the freeze.
  check('POSIX first-arg dash skips the takeover (dash law)', posix.includes('-*) MERCURY_TAKEOVER=0'))
  check('PS1 first-arg dash skips the takeover', ps1T.includes(".StartsWith('-')"))
  check('CMD probe carries the dash verdict', SPLASH_VERSION_TTY_PROBE_JS.includes("charAt(0)==='-'"))
  {
    // The probe is runnable JS — fake the TTY and read the verdict directly.
    const probeWrap =
      "Object.defineProperty(process.stdin,'isTTY',{value:true,configurable:true});" +
      SPLASH_VERSION_TTY_PROBE_JS
    const dashRun = spawnSync('node', ['-e', probeWrap, '--', '--rollback'], { encoding: 'utf8', timeout: 15_000 })
    check('CMD probe verdict: leading-dash first arg ⇒ takeover 0', dashRun.stdout.trim().endsWith(' 0'), dashRun.stdout)
    const bareRun = spawnSync('node', ['-e', probeWrap, '--'], { encoding: 'utf8', timeout: 15_000 })
    check('CMD probe verdict: bare boot ⇒ takeover 1', bareRun.stdout.trim().endsWith(' 1'), bareRun.stdout)
  }
  check(
    'root CLI points --rollback at the update verb (one-line pointer)',
    readFileSync(join(import.meta.dir, '../../src/main.tsx'), 'utf8').includes('run `mercury update --rollback`'),
  )
  // the compile-cache env — set BEFORE node compiles the
  // entry (an in-process call cannot cover the already-compiled main module;
  // the audited parse cost ≈689ms/boot of a 20.83MB bundle). All three
  // launchers: honor a pre-set NODE_COMPILE_CACHE, honor the disable env,
  // resolve the SAME seven-rung config home, and cover the splash run too
  // (the export precedes the splash node start).
  {
    const cmdT = cmdLauncher(policy)
    for (const [name, t] of [['POSIX', posix], ['CMD', cmdT], ['PS1', ps1T]] as const) {
      check(`${name} exports NODE_COMPILE_CACHE under the config home`, t.includes('NODE_COMPILE_CACHE') && t.includes('compile-cache'))
      check(`${name} honors NODE_DISABLE_COMPILE_CACHE (opt-out)`, t.includes('NODE_DISABLE_COMPILE_CACHE'))
    }
    check('POSIX honors a pre-set cache dir (operator wins)', posix.includes('[ -z "${NODE_COMPILE_CACHE:-}" ]'))
    check('CMD honors a pre-set cache dir', cmdT.includes('if not defined NODE_COMPILE_CACHE'))
    check('PS1 honors a pre-set cache dir', ps1T.includes('-not $env:NODE_COMPILE_CACHE'))
    check(
      'POSIX sets the cache env BEFORE the splash node run (splash parse caches too)',
      posix.indexOf('NODE_COMPILE_CACHE') !== -1 && posix.indexOf('NODE_COMPILE_CACHE') < posix.indexOf('node "$dir/splash.mjs"'),
    )
    check(
      'CMD sets the cache env BEFORE the splash node run',
      cmdT.indexOf('NODE_COMPILE_CACHE') !== -1 && cmdT.indexOf('NODE_COMPILE_CACHE') < cmdT.indexOf('node "%DIR%splash.mjs"'),
    )
    check(
      'PS1 sets the cache env BEFORE the splash node run',
      ps1T.indexOf('NODE_COMPILE_CACHE') !== -1 && ps1T.indexOf('NODE_COMPILE_CACHE') < ps1T.indexOf('& node $splashPath'),
    )
    // THE WIN32 PATH BOUND REACHES THE ENV FORM (TASK-017 S2,
    // launcher-compile-cache-path-bound-bypassed): the in-process guard
    // arms only when NODE_COMPILE_CACHE is UNDEFINED, and both Windows
    // launchers define it — so the 200-char bound (a 224-char home spun one
    // core forever, TASK-014 w1-f15-01) must live in the templates too, in
    // lockstep with compileCachePath.ts, \\?\ opting out in both. Over the
    // bound the launchers skip the cache and boot on — exactly the
    // in-process guard's posture.
    {
      const { WIN32_COMPILE_CACHE_DIR_MAX } = await import('../../src/utils/runtime/compileCachePath.ts')
      check('the bound is the one owner constant (200)', WIN32_COMPILE_CACHE_DIR_MAX === 200)
      check('CMD bounds the cache path with the owner number', cmdT.includes(`%MERCURY_SA_CACHE:~${WIN32_COMPILE_CACHE_DIR_MAX}%`))
      check('CMD: over the bound the set is skipped, not the boot', cmdT.includes('if not defined MERCURY_SA_CACHE_OVER if not defined NODE_COMPILE_CACHE if not defined NODE_DISABLE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%MERCURY_SA_CACHE%"'))
      check('CMD honors the \\\\?\\ opt-out (extended spellings escape the bound)', cmdT.includes('if "%MERCURY_SA_CACHE:~0,4%"=="\\\\?\\"'))
      check('POISON gone: CMD no longer sets the cache unconditionally', !cmdT.includes('if not defined NODE_COMPILE_CACHE if not defined NODE_DISABLE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%MERCURY_SA_HOME%'))
      check('PS1 bounds the cache path with the owner number', ps1T.includes(`.Length -le ${WIN32_COMPILE_CACHE_DIR_MAX}`))
      check("PS1 honors the \\\\?\\ opt-out", ps1T.includes(".StartsWith('\\\\?\\')"))
      check('POISON gone: PS1 no longer sets the cache unconditionally', !ps1T.includes("$env:NODE_COMPILE_CACHE = Join-Path $saHome 'compile-cache'"))
      // The batch substring gate, driven for real through cmd semantics on
      // any host: %VAR:~200% is empty exactly when len<=200 — prove the
      // arithmetic the template leans on with node string slicing.
      const under = 'C:/x'.padEnd(200, 'a').slice(0, 200)
      const over = 'C:/x'.padEnd(201, 'a')
      check('the substring gate arithmetic: <=200 passes, >200 trips', under.slice(WIN32_COMPILE_CACHE_DIR_MAX) === '' && over.slice(WIN32_COMPILE_CACHE_DIR_MAX) !== '')
    }
    check(
      'the entry seam carries the env-less fallback (portable node boots)',
      readFileSync(join(import.meta.dir, '../../src/entrypoints/cli.tsx'), 'utf8').includes('enableCompileCache'),
    )
  }
  check('POSIX captures the splash exit code (the ONE handover channel)', posix.includes('MERCURY_SA_EXIT=$?'))
  check('POSIX honors the 130 cancel stand-down (via BM-30 exit codes)', posix.includes('[ "$MERCURY_SA_EXIT" = "130" ]'))
  check('POSIX keeps the static wordmark fallback', posix.includes('MERCURY') && posix.includes('printf'))
  {
    // ONE probe carries version + interactivity. Its stdout is
    // deliberately CAPTURED (for /f) — the old stdout-TTY law inverted: the
    // probe now reads STDIN only (the splash's own out.isTTY self-guard
    // covers a user-redirected stdout). Args still ride behind `--`
    // (node must never eat --version/-p/-h).
    check('CMD probe reads stdin.isTTY only (stdout is the version channel)', SPLASH_VERSION_TTY_PROBE_JS.includes('process.stdin.isTTY') && !SPLASH_VERSION_TTY_PROBE_JS.includes('process.stdout.isTTY'))
    check('CMD probe prints the version + verdict on ONE line', SPLASH_VERSION_TTY_PROBE_JS.includes('process.versions.node'))
    // AR-01: the probe forwards argv on a PLAIN command line and
    // captures through a temp file — user argv must never ride inside a
    // for /f command (a second cmd parser pass: the class with user
    // input as the payload).
    const probeLine = cmdT.split('\r\n').find(l => l.includes('node -e') && l.includes('process.stdin.isTTY')) ?? ''
    check('CMD probe line exists (plain command line, temp-file capture)', probeLine !== '' && probeLine.includes('>"%MERCURY_PROBE_OUT%"'))
    check('AR-01 ratchet: NO for /f line re-parses a command containing node/argv', cmdT.split('\r\n').filter(l => l.includes('for /f')).every(l => !l.includes('node') && !l.includes('%*')))
    check('CMD probe output is consumed first-line-only from the temp file (usebackq)', cmdT.includes('for /f "usebackq tokens=1,2" %%v in ("%MERCURY_PROBE_OUT%")'))
    // 3.6.2: the NORMAL boot path keeps exactly ONE node -e probe (the
    // version+tty merge — the boot-cost law); the second
    // occurrence is the ABNORMAL-child heal, which never runs on a
    // normal boot. made the guard FLOW-shaped: the heal line is only
    // reachable after the 130/0/20 branches have all jumped away.
    const nodeELines = cmdT.split('\r\n').filter(l => l.includes('node -e'))
    check('CMD has exactly ONE pre-app node -e probe (version+tty merged)', nodeELines.filter(l => !l.includes('?1049l')).length === 1)
    check(
      'CMD abnormal-child heal is flow-guarded (after the 130 stand-down and both handoff jumps, before the plain boot) and owner-scoped',
      nodeELines.some(l => l.includes('?1049l')) &&
        cmdT.indexOf('=="130" exit /b 0') !== -1 && cmdT.indexOf('=="130" exit /b 0') < cmdT.indexOf('?1049l') &&
        cmdT.indexOf('if "%MERCURY_SA_EXIT%"=="20" goto :sa_handoff') !== -1 && cmdT.indexOf('if "%MERCURY_SA_EXIT%"=="20" goto :sa_handoff') < cmdT.indexOf('?1049l') &&
        cmdT.indexOf('?1049l') < cmdT.indexOf('\r\n:sa_handoff\r\n'),
    )
    check('CMD probe passes user args behind -- (node must never eat --version/-p/-h)', probeLine.includes('" -- %*'), probeLine)
    check('CMD gates the takeover on the probe verdict', cmdT.includes('if not "%NODETTY%"=="1" set "MERCURY_TAKEOVER=0"'))
  }
  check('PS1 gates on console redirection', ps1T.includes('IsInputRedirected') && ps1T.includes('IsOutputRedirected'))
  check('PS1 boots with forwarded args only (the pre-arg splice moved to the runtime consumer)', ps1T.includes('@args') && !ps1T.includes('mercuryPre'))
  check('CMD boots with forwarded args only (no %-expansion of anything product-written)', cmdT.includes('node "%DIR%mercury.mjs" %*') && !cmdT.includes('MERCURY_PRE'))

  // The base64 consumer blobs stayed gone, and now
  // the native readers are absent too — no launcher touches the receipt files.
  check('CMD carries no base64 consumer blob (E4 retired)', !cmdT.includes('base64'))
  check('PS1 carries no base64 consumer blob (E4 retired)', !ps1T.includes('base64'))
  check('CMD honors the 130 cancel stand-down (exit /b 0, before alt-held)', cmdT.includes('if "%MERCURY_SA_EXIT%"=="130" exit /b 0') && cmdT.indexOf('=="130" exit /b 0') !== -1 && cmdT.indexOf('=="130" exit /b 0') < cmdT.indexOf('MERCURY_ALT_HELD'))
  check('PS1 honors the 130 cancel stand-down (exit 0, before the alt-held setter)', ps1T.includes('if ($saExit -eq 130) { exit 0 }') && ps1T.indexOf('($saExit -eq 130)') !== -1 && ps1T.indexOf('($saExit -eq 130)') < ps1T.indexOf("$env:MERCURY_ALT_HELD = '1'"))
  check('PS1 resolves its directory via $PSScriptRoot (E5 — dot-source/-Command safe)', ps1T.includes('$dir = $PSScriptRoot') && !ps1T.includes('$MyInvocation.MyCommand.Path'))
  check('CMD sets the console-UTF-8 preset marker for the runtime seam (D2)', cmdT.includes('set "MERCURY_WIN32_UTF8_PRESET=1"'))
  check('PS1 sets the console-UTF-8 preset marker for the runtime seam (D2)', ps1T.includes("$env:MERCURY_WIN32_UTF8_PRESET = '1'"))
  check('the skip lists are non-trivial and mirror the operator launcher', SPLASH_SKIP_VERBS.length >= 18 && SPLASH_SKIP_FLAGS.includes('-p') && SPLASH_SKIP_FLAGS.includes('--version'))
}

//
section('(7) POSIX chain — skip laws both directions (pipes + a real PTY)')
{
  // A richer harness: a stub splash that records it ran (+TTY truth) and
  // writes a real splash-action.json; a stub hermes that reports argv, cwd
  // and the alt-held handover. Separate app dir — the section (2)/(3) stubs
  // keep their exact output contracts.
  const chainDir = join(base, 'chain app')
  const chainHome = join(base, 'chain home')
  const projectDir = join(base, 'picked project')
  mkdirSync(chainDir, { recursive: true })
  mkdirSync(chainHome, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(chainDir, 'mercury.mjs'),
    `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: require('fs').realpathSync(process.cwd()), alt: process.env.MERCURY_ALT_HELD || '', handoff: process.env.MERCURY_SPLASH_HANDOFF || '', launchId: process.env.MERCURY_LAUNCH_ID || '' }))\n`,
  )
  writeFileSync(
    join(chainDir, 'splash.mjs'),
    `const fs = require('fs')
const home = process.env.MERCURY_HOME
const mode = process.env.MERCURY_TEST_SPLASH_MODE || 'handoff'
fs.writeFileSync(home + '/splash-ran.marker', JSON.stringify({ tty: Boolean(process.stdout.isTTY) }))
// the launcher-facing handover is the EXIT CODE alone; the JSON
// receipt is for the RUNTIME consumer (the launcher must neither read nor
// delete it — these legs assert exactly that).
if (mode === 'handoff') {
  fs.writeFileSync(home + '/splash-action.json', JSON.stringify({ version: 1, ts: Date.now(), action: 'continue', dir: process.env.MERCURY_TEST_PROJECT, screen: 'held' }))
  process.exit(0)
} else if (mode === 'restored') {
  fs.writeFileSync(home + '/splash-action.json', JSON.stringify({ version: 1, ts: Date.now(), screen: 'restored' }))
  process.exit(20)
} else if (mode === 'cancel') {
  fs.writeFileSync(home + '/splash-action.json', JSON.stringify({ version: 1, ts: Date.now(), action: 'cancel', screen: 'restored' }))
  process.exit(130)
} else if (mode === 'die') {
  process.exit(7)
} else if (mode === 'garbage-receipt') {
  // the 1.5.4 murder bytes: an LF-only multi-line receipt (+ a rogue twin) —
  // the launcher must be IMMUNE to receipt content by construction
  fs.writeFileSync(home + '/splash-action.json', '\\n\\nheld\\n')
  fs.writeFileSync(home + '/splash-action.txt', '\\n\\nheld\\n')
  process.exit(0)
}\n`,
  )
  const chainLauncher = join(chainDir, 'mercury')
  writeFileSync(chainLauncher, posixLauncher(policy))
  chmodSync(chainLauncher, 0o755)

  const chainEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      FAKE_NODE_VERSION: NODE_SUPPORT.minimum,
      // Pin EVERY rung the seven-rung resolution consults (ambient-state
      // law): a real Mercury session exports MERCURY_CONFIG_DIR +
      // MERCURY_CONFIG_DIR, which outrank the MERCURY_HOME pin — the chain
      // legs would read (and DELETE splash-action.json from!) the
      // operator's real home when the pool runs inside a Mercury session.
      MERCURY_CONFIG_DIR: chainHome,
      MERCURY_HOME: chainHome,
      MERCURY_HOME: chainHome,
      MERCURY_TEST_PROJECT: projectDir,
      ...extra,
    }
    // F6: the operator's machine may carry splash/banner state — strip it.
    for (const k of ['MERCURY_NO_BANNER', 'MERCURY_SPLASH', 'MERCURY_FULLSCREEN', 'MERCURY_ALT_HELD']) {
      if (!(k in extra)) delete env[k]
    }
    return env
  }
  const splashRan = (): boolean => existsSync(join(chainHome, 'splash-ran.marker'))
  const resetChain = (): void => {
    rmSync(join(chainHome, 'splash-ran.marker'), { force: true })
    rmSync(join(chainHome, 'splash-action.json'), { force: true })
    rmSync(join(chainHome, 'splash-action.txt'), { force: true })
  }
  const lastJson = (out: string): { args: string[]; cwd: string; alt: string; handoff: string; launchId: string } | null => {
    // The abnormal-death heal writes its restore bytes to stdout WITHOUT a
    // trailing newline, so the stub's JSON can share a line with ANSI noise —
    // parse from the first `{` on each line.
    const lines = out
      .split(/\r?\n/)
      .map(l => {
        const i = l.indexOf('{')
        return i === -1 ? '' : l.slice(i).trim()
      })
      .filter(l => l.startsWith('{'))
    if (lines.length === 0) return null
    try {
      return JSON.parse(lines[lines.length - 1]!) as { args: string[]; cwd: string; alt: string; handoff: string; launchId: string }
    } catch {
      return null
    }
  }
  // a PTY runner: both stdin+stdout become a real TTY for the launcher
  const runPty = (args: string[], env: NodeJS.ProcessEnv): { out: string; status: number | null } => {
    const py = [
      'import pty, sys, os',
      'status = pty.spawn(sys.argv[1:])',
      'sys.exit(os.waitstatus_to_exitcode(status))',
    ].join('\n')
    const r = spawnSync('python3', ['-c', py, 'sh', chainLauncher, ...args], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
      input: '',
    })
    return { out: r.stdout + r.stderr, status: r.status }
  }

  // — piped (non-TTY): the enter screen must NOT run, even bare —
  resetChain()
  {
    const r = spawnSync('sh', [chainLauncher], { encoding: 'utf8', env: chainEnv(), timeout: 30_000 })
    const j = lastJson(r.stdout)
    check('pipes: splash skipped (non-TTY)', !splashRan())
    check('pipes: hermes booted bare, no handover', j !== null && j.args.length === 0 && j.alt === '' && j.handoff === '', r.stdout.slice(0, 120))
  }

  // — PTY probe: only meaningful where python3+pty can mint one —
  const ptyProbe = runPty(['--version'], chainEnv())
  if (ptyProbe.status === null || ptyProbe.out.trim() === '') {
    console.log('  [SKIP] python3 pty unavailable — the PTY legs need a real tty minting harness')
  } else {
    // flags skip under a REAL TTY
    check('pty --version: splash skipped (flag law)', !splashRan())
    const jv = lastJson(ptyProbe.out)
    check('pty --version: forwarded', jv !== null && jv.args.length === 1 && jv.args[0] === '--version', ptyProbe.out.slice(0, 120))

    // verbs skip under a REAL TTY
    resetChain()
    const rDoctor = runPty(['doctor'], chainEnv())
    check('pty doctor: splash skipped (verb law)', !splashRan())
    check('pty doctor: forwarded', (lastJson(rDoctor.out)?.args ?? []).join(',') === 'doctor')

    // the POSITIVE direction: a bare interactive boot runs the enter
    // screen; the launcher takes the handoff from the EXIT CODE alone — no
    // arg prepend, no cd, and the receipt file SURVIVES for the runtime.
    resetChain()
    const rBare = runPty([], chainEnv())
    const jb = lastJson(rBare.out)
    const marker = splashRan() ? JSON.parse(readFileSync(join(chainHome, 'splash-ran.marker'), 'utf8')) as { tty: boolean } : null
    check('pty bare: the enter screen RAN', marker !== null, rBare.out.slice(0, 200))
    check('pty bare: the splash saw a real TTY', marker?.tty === true)
    check("pty bare: argv untouched (the --continue splice is the runtime consumer's)", jb !== null && jb.args.length === 0, JSON.stringify(jb))
    check("pty bare: cwd untouched (the chdir is the runtime consumer's)", jb !== null && jb.cwd === realpathSync(process.cwd()), `${jb?.cwd}`)
    check('pty bare: alt-buffer handover marked (exit 0 = held)', jb?.alt === '1')
    check('pty bare: the runtime consumer armed (MERCURY_SPLASH_HANDOFF=1)', jb?.handoff === '1')
    check('pty bare: a launch id crossed env-down (LH-01)', jb !== null && jb.launchId.startsWith('posix-'), jb?.launchId)
    check('pty bare: the receipt SURVIVES for the runtime (the launcher never touches it)', existsSync(join(chainHome, 'splash-action.json')))

    // exit 20 — restored handoff (inline mode): consumer armed, NO hold marker
    resetChain()
    const rRest = runPty([], chainEnv({ MERCURY_TEST_SPLASH_MODE: 'restored' }))
    const jr = lastJson(rRest.out)
    check('pty restored(20): booted with the consumer armed and NO hold marker', jr !== null && jr.alt === '' && jr.handoff === '1', JSON.stringify(jr))

    // cancel = exit 130 — the launcher stands down
    resetChain()
    const rCancel = runPty([], chainEnv({ MERCURY_TEST_SPLASH_MODE: 'cancel' }))
    check('pty cancel(130): launcher exits 0', rCancel.status === 0, `status=${rCancel.status}`)
    check('pty cancel(130): the app was NEVER booted', lastJson(rCancel.out) === null, rCancel.out.slice(0, 120))
    check("pty cancel(130): the receipt is left for the next splash's sweep (launchers never delete)", existsSync(join(chainHome, 'splash-action.json')))

    // abnormal splash death: heal + PLAIN boot — a splash failure may cost
    // hold cosmetics, never the boot
    resetChain()
    const rDie = runPty([], chainEnv({ MERCURY_TEST_SPLASH_MODE: 'die' }))
    const jd = lastJson(rDie.out)
    check('pty die(7): the app STILL boots', jd !== null, rDie.out.slice(0, 160))
    check('pty die(7): plain boot — no hold marker, no handoff', jd !== null && jd.alt === '' && jd.handoff === '', JSON.stringify(jd))

    // the 1.5.4 murder bytes: receipt CONTENT can never reach the launcher —
    // an LF-only multi-line receipt must not cost the boot (acceptance #4)
    resetChain()
    const rGarb = runPty([], chainEnv({ MERCURY_TEST_SPLASH_MODE: 'garbage-receipt' }))
    const jg = lastJson(rGarb.out)
    check('pty garbage-receipt: the boot is IMMUNE to receipt content', jg !== null && jg.handoff === '1', JSON.stringify(jg))

    // opt-outs under a REAL TTY
    resetChain()
    runPty([], chainEnv({ MERCURY_SPLASH: 'off' }))
    check('pty MERCURY_SPLASH=off: splash skipped', !splashRan())
    resetChain()
    runPty([], chainEnv({ MERCURY_NO_BANNER: '1' }))
    check('pty MERCURY_NO_BANNER=1: splash skipped', !splashRan())
    resetChain()
    const rStatic = runPty([], chainEnv({ MERCURY_SPLASH: 'static' }))
    check('pty MERCURY_SPLASH=static: splash skipped, wordmark shown', !splashRan() && rStatic.out.includes('MERCURY'))

    // — the merged CMD probe JS itself: one node start prints
    //   `<version> <0|1>` — the verdict rides the OUTPUT (stdout is the
    //   version channel, captured by for /f), and interactivity reads STDIN
    //   only. A TTY whose stdout is redirected still answers interactive
    //   here BY DESIGN: the for /f capture always redirects stdout, and the
    //   splash's own out.isTTY self-guard owns the redirected-stdout case.
    const runProbePty = (shellCmd: string): { status: number | null; out: string } => {
      const py = [
        'import pty, sys, os',
        'status = pty.spawn(sys.argv[1:])',
        'sys.exit(os.waitstatus_to_exitcode(status))',
      ].join('\n')
      const r = spawnSync('python3', ['-c', py, 'sh', '-c', shellCmd], { encoding: 'utf8', env: chainEnv(), timeout: 30_000, input: '' })
      return { status: r.status, out: (r.stdout ?? '') }
    }
    const verdictOf = (out: string): string | null => {
      const toks = out.trim().split(/\s+/)
      return toks.length >= 2 ? toks[toks.length - 1]! : null
    }
    const probeQ = SPLASH_VERSION_TTY_PROBE_JS.replace(/'/g, "'\\''")
    {
      const r = runProbePty(`node -e '${probeQ}' -- ; echo`)
      check('probe on a real TTY → version + verdict 1', r.status === 0 && verdictOf(r.out) === '1', r.out.slice(0, 60))
    }
    {
      const r = runProbePty(`node -e '${probeQ}' -- >/tmp/mercury-probe-out.$$ ; cat /tmp/mercury-probe-out.$$ ; rm -f /tmp/mercury-probe-out.$$ ; echo`)
      check('probe with redirected stdout on a TTY → STILL interactive (stdin law; the splash self-guards stdout)', verdictOf(r.out) === '1', r.out.slice(0, 60))
    }
    {
      const r = spawnSync('node', ['-e', SPLASH_VERSION_TTY_PROBE_JS, '--'], { encoding: 'utf8', env: chainEnv(), timeout: 30_000, input: '' })
      check('probe on pipes → verdict 0 (stdin is not a TTY)', r.status === 0 && verdictOf(r.stdout ?? '') === '0', (r.stdout ?? '').slice(0, 60))
      check('probe prints the real node version first', (r.stdout ?? '').trim().startsWith(process.versions.node))
    }
    {
      const r = runProbePty(`node -e '${probeQ}' -- --version ; echo`)
      check('probe with a skip flag on a real TTY → verdict 0 (args ride behind --)', verdictOf(r.out) === '0', r.out.slice(0, 60))
    }
    {
      const r = runProbePty(`node -e '${probeQ}' -- 'fix (this) thing' ; echo`)
      check('probe with a positional prompt on a real TTY → verdict 1 (a prompt IS a takeover)', verdictOf(r.out) === '1', r.out.slice(0, 60))
    }
  }
}

//
section('(8) the skip-verb set DERIVES from the product\'s registered verb surface (FN-015 rank 7)')
{
  // A hand-written literal missed `health` (the primary name `doctor` is an
  // alias of), `show`, `editor` and `upgrade`: those verbs met the enter
  // screen, Esc stood the launcher down with exit 0, and the verb never ran.
  // The template now censuses main.tsx's `program.command(...)` sites and
  // aliases, the launcher-fast-path loop rows, cli.tsx's fast-path routes
  // and its dead set; this section pins the census against an independent
  // raw count so a registration the census cannot read reds here.
  const repo = join(import.meta.dir, '..', '..')
  const mainTsx = readFileSync(join(repo, 'src', 'main.tsx'), 'utf8')
  const cliTsx = readFileSync(join(repo, 'src', 'entrypoints', 'cli.tsx'), 'utf8')
  type Surface = { commands: Array<{ name: string; aliases: string[] }>; fastPath: string[]; dead: string[] }
  const derive = (templates as Record<string, unknown>).verbSurfaceFromSource as ((m: string, c: string) => Surface) | undefined
  const skipFrom = (templates as Record<string, unknown>).splashSkipVerbsFrom as ((s: Surface) => string[]) | undefined
  check('the template exports the source census (verbSurfaceFromSource) and the derivation (splashSkipVerbsFrom)', typeof derive === 'function' && typeof skipFrom === 'function')
  if (derive && skipFrom) {
    const surface = derive(mainTsx, cliTsx)
    const names = surface.commands.map(c => c.name)
    const aliases = surface.commands.flatMap(c => c.aliases)
    // Independent raw count: every quoted top-level registration site plus
    // every row of the fast-path loop.
    const rawSites = (mainTsx.match(/\bprogram\s*\.command\('/g) ?? []).length
    const loopBlock = /for \(const \[name, usage\] of \[([\s\S]*?)\] as const\)/.exec(mainTsx)
    const rawLoopRows = loopBlock ? (loopBlock[1]!.match(/^\s*\['/gm) ?? []).length : 0
    check(`the census is complete against the raw registration count (${rawSites} sites + ${rawLoopRows} loop rows)`, rawSites + rawLoopRows === surface.commands.length && rawSites >= 10 && rawLoopRows === 2, `${surface.commands.length} censused: ${names.join(',')}`)
    for (const verb of ['health', 'show', 'editor', 'update', 'install', 'mcp', 'auth', 'extensions', 'setup-token', 'agents', 'themis', 'daemon', 'acp']) {
      check(`the census reads the registered verb '${verb}'`, names.includes(verb))
    }
    check("the census reads the aliases 'doctor' (of health) and 'upgrade' (of update)", aliases.includes('doctor') && aliases.includes('upgrade') && surface.commands.find(c => c.name === 'health')?.aliases.includes('doctor') === true)
    check("the census reads cli.tsx's fast-path routes (daemon · join · join-kit · acp)", ['daemon', 'join', 'join-kit', 'acp'].every(v => surface.fastPath.includes(v)))
    check("the census reads cli.tsx's dead set (ps · logs · list · sync · remote · rc …)", ['ps', 'logs', 'list', 'sync', 'remote', 'rc'].every(v => surface.dead.includes(v)) && surface.dead.length >= 10)
    const derived = skipFrom(surface)
    check('SPLASH_SKIP_VERBS IS the derived set (sorted, unique)', JSON.stringify([...SPLASH_SKIP_VERBS]) === JSON.stringify(derived), `${SPLASH_SKIP_VERBS.join(' ')} ≠ ${derived.join(' ')}`)
    for (const verb of ['health', 'doctor', 'show', 'editor', 'update', 'upgrade', 'install', 'daemon', 'acp', 'join', 'join-kit', 'ps', 'logs', 'list']) {
      check(`the skip set carries '${verb}'`, SPLASH_SKIP_VERBS.includes(verb))
    }
    check('every registered name and alias is in the skip set (nothing registered can meet the enter screen)', [...names, ...aliases].every(v => SPLASH_SKIP_VERBS.includes(v)))
    check('no unregistered word rides the skip set (completion · error · export · log · task · up were never verbs)', ['completion', 'error', 'export', 'log', 'task', 'up'].every(v => !SPLASH_SKIP_VERBS.includes(v)))
    // The generated launchers carry the derived set verbatim.
    const posixT = posixLauncher(policy)
    const cmdGen = cmdLauncher(policy)
    const ps1Gen = ps1Launcher(policy)
    check('POSIX launcher case arm carries the derived set', posixT.includes(`${derived.join('|')}) MERCURY_TAKEOVER=0 ;;`))
    check('CMD launcher for-loop carries the derived set', cmdGen.includes(`for %%v in (${derived.join(' ')}) do`))
    check('PS1 launcher array carries the derived set', ps1Gen.includes(`@(${derived.map(v => `'${v}'`).join(',')})`))
    // The operator launcher (scripts/ops) is a hand-maintained shell script:
    // its case arm must equal the derived set, pinned here.
    const ops = readFileSync(join(repo, 'scripts', 'ops', 'launcher-mercury.sh'), 'utf8')
    const opsArm = /^\s*([a-z-]+(?:\|[a-z-]+)+)\) MERCURY_TAKEOVER=0 ;;/m.exec(ops)
    const opsVerbs = opsArm ? opsArm[1]!.split('|').sort() : []
    check('the operator launcher case arm equals the derived set', JSON.stringify(opsVerbs) === JSON.stringify(derived), `ops: ${opsVerbs.join(' ')}`)
  }
  // The dead-subcommand refusal must be visible even under a launcher hold:
  // the hold releases first and the line lands through writeSync.
  const deadGuard = cliTsx.slice(cliTsx.indexOf('DEAD_SUBCOMMANDS.has(args[0]'))
  check('the dead-subcommand refusal releases the launcher alt-hold before printing', /releaseLauncherAltHoldNow\(\)/.test(deadGuard.slice(0, 900)))
  check('the dead-subcommand refusal lands through writeSync (a win32 TTY stream write is async and the exit can discard it)', /writeSync\(2,/.test(deadGuard.slice(0, 900)))
}

rmSync(base, { recursive: true, force: true })

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ LAUNCHER PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
