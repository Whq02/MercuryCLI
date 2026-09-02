#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-direct-splash.ts — the launch splash on a
//  DIRECT `node dist/mercury.mjs` start (no launcher in front of it).
//    §1 the takeover gate (pure): the bare line on two TTYs runs; every
//       other shape names its skip reason
//    §2 asset resolution: beside the bundle → the config home → the source
//       tree; a torn pair never answers
//    §3 THE EXIT-CODE TABLE against the launcher's managed action block —
//       the block is EXECUTED under sh for every code, and the in-process
//       table must produce the same env markers and the same heal bytes
//       (one protocol, two hosts: the two can never drift)
//    §4 the entry seam: the direct road sits before the receipt consumer
//    §5 the ordinary build ships the pair beside the bundle
//    §6 the road on a REAL PTY (dist present · python3 pty + pyte): a bare
//       start paints the splash's lockup, then the Boot face; MERCURY_SPLASH
//       =off ⇒ the face directly; a prompt / --continue ⇒ no splash; a
//       launcher's marker pre-set ⇒ never a second splash; the asset moved
//       away ⇒ a plain boot, no error; Ctrl-C on the splash ⇒ exit 0 with
//       the screen restored and the cancel receipt left behind
//
//  Run: ~/.bun/bin/bun run scripts/node-runtime/prove-direct-splash.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { resolveProofHome } = await import('../lib/proofHome.ts')
const { vshotBudgetMs } = await import('../lib/captureDriver.ts')
const {
  applySplashExit,
  decideDirectSplash,
  resolveSplashAsset,
  SPLASH_ABNORMAL_HEAL,
  SPLASH_CORE,
  SPLASH_DRIVER,
  SPLASH_EXIT,
  shellExitCodeOf,
} = await import('../../src/substrate/directSplash.ts')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const BIN = join(ROOT, 'dist', 'mercury.mjs')
const BLOCK = join(ROOT, 'assets', 'splash', 'launcher-action-block.sh')

//
section('§1 the takeover gate — the bare line on two TTYs, nothing else')
{
  const tty = { stdinTTY: true, stdoutTTY: true }
  const env = {}
  check('bare + both TTYs ⇒ run', decideDirectSplash({ args: [], ...tty, env }).run === true)
  const skip = (args: string[], e: Record<string, string>, t = tty): string => {
    const d = decideDirectSplash({ args, ...t, env: e })
    return d.run ? 'run' : d.reason
  }
  check('a positional prompt is a journey ⇒ argv', skip(['fix the tests'], {}) === 'argv')
  check('--continue is a journey ⇒ argv', skip(['--continue'], {}) === 'argv')
  check('--resume is a journey ⇒ argv', skip(['--resume'], {}) === 'argv')
  check('a verb is a journey ⇒ argv', skip(['doctor'], {}) === 'argv')
  check('-p / --print ⇒ argv', skip(['-p', 'hi'], {}) === 'argv' && skip(['--print', 'hi'], {}) === 'argv')
  check('--help / --version ⇒ argv', skip(['--help'], {}) === 'argv' && skip(['--version'], {}) === 'argv')
  check('any flag at all ⇒ argv (the dash law)', skip(['--chat'], {}) === 'argv' && skip(['--rollback'], {}) === 'argv')
  check('stdout not a TTY ⇒ not-a-tty', skip([], {}, { stdinTTY: true, stdoutTTY: false }) === 'not-a-tty')
  check('stdin not a TTY ⇒ not-a-tty', skip([], {}, { stdinTTY: false, stdoutTTY: true }) === 'not-a-tty')
  check('a launcher handoff marker ⇒ launcher-handed-over (never two splashes)', skip([], { MERCURY_SPLASH_HANDOFF: '1' }) === 'launcher-handed-over')
  check('a launcher hold marker alone ⇒ launcher-handed-over', skip([], { MERCURY_ALT_HELD: '1' }) === 'launcher-handed-over')
  check('MERCURY_SPLASH=off ⇒ splash-off', skip([], { MERCURY_SPLASH: 'off' }) === 'splash-off')
  check('MERCURY_SPLASH=static ⇒ splash-static (the launchers never run the asset in that mode)', skip([], { MERCURY_SPLASH: 'static' }) === 'splash-static')
  check('MERCURY_NO_BANNER=1 ⇒ no-banner', skip([], { MERCURY_NO_BANNER: '1' }) === 'no-banner')
  check('an unrelated MERCURY_SPLASH value still runs', skip([], { MERCURY_SPLASH: 'full' }) === 'run')
}

//
section('§2 asset resolution — payload · home · source, a torn pair never answers')
{
  const present = new Set<string>()
  const exists = (p: string): boolean => present.has(p)
  const bundleDir = join('/opt', 'app', 'dist')
  const home = join('/home', 'op', '.mercury')
  const at = (dir: string, name: string): string => join(dir, name)
  const sourceDriver = join(bundleDir, '..', 'assets', 'splash', 'mercury-splash.mjs')
  const sourceCore = join(bundleDir, '..', 'assets', 'splash', SPLASH_CORE)
  check('nothing anywhere ⇒ null', resolveSplashAsset({ bundleDir, home, exists }) === null)
  present.add(at(bundleDir, SPLASH_DRIVER))
  check('a driver without its core beside the bundle is a torn pair ⇒ falls through to nothing', resolveSplashAsset({ bundleDir, home, exists }) === null)
  present.add(at(bundleDir, SPLASH_CORE))
  const payload = resolveSplashAsset({ bundleDir, home, exists })
  check('the pair beside the bundle answers first (payload)', payload?.rung === 'payload' && payload.driver === at(bundleDir, SPLASH_DRIVER))
  present.add(at(home, SPLASH_DRIVER))
  present.add(at(home, SPLASH_CORE))
  present.add(sourceDriver)
  present.add(sourceCore)
  check('…even when the home and the source tree carry it too', resolveSplashAsset({ bundleDir, home, exists })?.rung === 'payload')
  present.delete(at(bundleDir, SPLASH_DRIVER))
  present.delete(at(bundleDir, SPLASH_CORE))
  const homeHit = resolveSplashAsset({ bundleDir, home, exists })
  check('no pair beside the bundle ⇒ the config home (a deployed home)', homeHit?.rung === 'home' && homeHit.driver === at(home, SPLASH_DRIVER))
  present.delete(at(home, SPLASH_DRIVER))
  present.delete(at(home, SPLASH_CORE))
  const sourceHit = resolveSplashAsset({ bundleDir, home, exists })
  check('no deployed home ⇒ the source tree relative to the bundle (a source build)', sourceHit?.rung === 'source' && sourceHit.driver === sourceDriver)
  check('no home at all still resolves the source rung', resolveSplashAsset({ bundleDir, home: null, exists })?.rung === 'source')
  check('a source run with no bundle has no rung ⇒ null', resolveSplashAsset({ bundleDir: null, home, exists }) === null)
  present.delete(sourceCore)
  check('a torn source pair never answers', resolveSplashAsset({ bundleDir, home, exists }) === null)
}

//
section('§3 THE EXIT-CODE TABLE — the launcher block executed vs the in-process table')
{
  const block = readFileSync(BLOCK, 'utf8')
  check('the block is the managed launcher action block', block.includes('# MERCURY-SPLASH-ACTION-START') && block.includes('# MERCURY-SPLASH-ACTION-END'))
  // The block's heal rides "$MERCURY_NODE_BIN" -e '<js>': a stub node
  // records the JS it was handed, so the shell run reports the exact bytes
  // the block would write without any terminal in the loop.
  const arena = mkdtempSync(join(tmpdir(), 'direct-splash-block-'))
  const stub = join(arena, 'node-stub')
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\' "$2" > "$MERCURY_TEST_HEAL_OUT"\n')
  chmodSync(stub, 0o755)
  const script = join(arena, 'run.sh')
  // Source the block, then report the markers it exported; a stand-down
  // (the block's own `exit 0`) reports nothing.
  writeFileSync(script, `. "${BLOCK}"\nprintf 'HANDOFF=%s\\nHELD=%s\\n' "\${MERCURY_SPLASH_HANDOFF:-}" "\${MERCURY_ALT_HELD:-}"\n`)
  const unescape = (js: string): string => js.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  const runBlock = (code: number, fullscreen: string | undefined): { stoodDown: boolean; handoff: string; held: string; heal: string | null; status: number | null } => {
    const healOut = join(arena, `heal-${code}-${fullscreen ?? 'unset'}.txt`)
    rmSync(healOut, { force: true })
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, MERCURY_SA_EXIT: String(code), MERCURY_NODE_BIN: stub, MERCURY_TEST_HEAL_OUT: healOut }
    if (fullscreen !== undefined) env.MERCURY_FULLSCREEN = fullscreen
    const r = spawnSync('sh', [script], { encoding: 'utf8', env, timeout: 15_000 })
    const out = r.stdout ?? ''
    const handoff = /HANDOFF=(.*)/.exec(out)?.[1] ?? ''
    const held = /HELD=(.*)/.exec(out)?.[1] ?? ''
    let heal: string | null = null
    if (existsSync(healOut)) {
      const js = readFileSync(healOut, 'utf8')
      const lit = /process\.stdout\.write\("([^"]*)"\)/.exec(js)
      heal = lit ? unescape(lit[1]!) : js
    }
    return { stoodDown: !out.includes('HANDOFF='), handoff, held, heal, status: r.status }
  }
  const probe = runBlock(0, undefined)
  check('the block runs under sh (the probe leg reported its markers)', !probe.stoodDown && probe.status === 0, JSON.stringify(probe))
  check('the table names the block\'s three numbered codes (0 · 20 · 130)', SPLASH_EXIT.HANDOFF_HELD === 0 && SPLASH_EXIT.HANDOFF_RESTORED === 20 && SPLASH_EXIT.CANCEL === 130)
  for (const code of [0, 20, 130, 1, 7, 127, 255]) {
    for (const fullscreen of [undefined, '0', '1', 'false']) {
      const shell = runBlock(code, fullscreen)
      const env: Record<string, string | undefined> = fullscreen === undefined ? {} : { MERCURY_FULLSCREEN: fullscreen }
      let wrote = ''
      const verdict = applySplashExit(code, env, b => (wrote += b))
      const label = `code ${code} · MERCURY_FULLSCREEN ${fullscreen ?? 'unset'}`
      check(`${label}: stand-down agrees`, (verdict === 'cancel') === shell.stoodDown, `table ${verdict} · block ${shell.stoodDown ? 'stood down' : 'booted'}`)
      if (verdict === 'cancel') {
        check(`${label}: a cancel touches no marker and heals nothing`, env.MERCURY_SPLASH_HANDOFF === undefined && env.MERCURY_ALT_HELD === undefined && wrote === '')
        continue
      }
      check(`${label}: MERCURY_SPLASH_HANDOFF agrees`, (env.MERCURY_SPLASH_HANDOFF ?? '') === shell.handoff, `table '${env.MERCURY_SPLASH_HANDOFF ?? ''}' · block '${shell.handoff}'`)
      check(`${label}: MERCURY_ALT_HELD agrees`, (env.MERCURY_ALT_HELD ?? '') === shell.held, `table '${env.MERCURY_ALT_HELD ?? ''}' · block '${shell.held}'`)
      check(`${label}: the heal agrees byte-for-byte`, wrote === (shell.heal ?? ''), `table ${JSON.stringify(wrote)} · block ${JSON.stringify(shell.heal ?? '')}`)
    }
  }
  check('the heal constant is the block\'s exact bytes', runBlock(7, undefined).heal === SPLASH_ABNORMAL_HEAL)
  {
    // A spawn that never ran, or died by signal, carries no code: abnormal —
    // the heal, no marker, and the boot goes on (the floor law).
    const env: Record<string, string | undefined> = {}
    let wrote = ''
    const verdict = applySplashExit(null, env, b => (wrote += b))
    check('no exit code at all reads as abnormal (heal, no markers, boot)', verdict === 'boot' && wrote === SPLASH_ABNORMAL_HEAL && env.MERCURY_SPLASH_HANDOFF === undefined && env.MERCURY_ALT_HELD === undefined)
  }
  // The number the table reads is the SHELL's reading of the child's exit —
  // what the launcher's `$?` would carry: a normal exit passes through, a
  // death by signal is 128+n (SIGINT ⇒ 130 ⇒ a cancel, as under the
  // launcher), a spawn that never ran is 127 (abnormal).
  check('a normal exit passes through', shellExitCodeOf({ status: 20, signal: null }) === 20 && shellExitCodeOf({ status: 0, signal: null }) === 0)
  check('a splash killed by SIGINT reads 130 — the cancel, as a shell reports it', shellExitCodeOf({ status: null, signal: 'SIGINT' }) === SPLASH_EXIT.CANCEL)
  check('a splash killed by SIGTERM reads 143 — abnormal, as a shell reports it', shellExitCodeOf({ status: null, signal: 'SIGTERM' }) === 143)
  check('a spawn that never ran reads 127 — abnormal', shellExitCodeOf({ status: null, signal: null, error: new Error('ENOENT') }) === 127)
  check('no status and no signal reads 127 — abnormal, never a false handoff', shellExitCodeOf({ status: null, signal: null }) === 127)
  rmSync(arena, { recursive: true, force: true })
}

//
section('§4 the entry seam — the direct road runs before the receipt consumer')
{
  const cli = readFileSync(join(ROOT, 'src', 'entrypoints', 'cli.tsx'), 'utf8')
  const direct = cli.indexOf('runDirectSplash(')
  const consumer = cli.indexOf('consumeSplashHandover()')
  const versionFast = cli.indexOf("args[0] === '--version'")
  check('the cli entry calls the direct-splash owner', direct !== -1)
  check('…after the zero-import --version fast path', versionFast !== -1 && versionFast < direct)
  check('…before the splash-handover consumer (the consumer then runs unchanged)', consumer !== -1 && direct < consumer)
  check('…gated on the bare line and a TTY stdout before any import', /if \(args\.length === 0 && process\.stdout\.isTTY\) \{\s*\n[\s\S]{0,900}?runDirectSplash\(/.test(cli))
  check('…and a cancelled enter screen stands the boot down (exit 0)', /splash\.verdict === 'cancel'[\s\S]{0,400}?\n\s*return\n/.test(cli))
  const altHold = cli.indexOf("import('../ink/launcherAltHold.js')")
  check('the alt-hold consumer is imported only after the direct road (its marker is read at module evaluation)', altHold === -1 || altHold > direct)
  const owner = readFileSync(join(ROOT, 'src', 'substrate', 'directSplash.ts'), 'utf8')
  check('the owner spawns the asset on the runtime\'s own node with the terminal inherited', owner.includes('spawnSync(process.execPath, [asset.driver]') && owner.includes("stdio: 'inherit'") && owner.includes('windowsHide: false'))
  check('the owner mints the per-launch id before the splash (the launchers\' isolation law)', /MERCURY_LAUNCH_ID = `direct-/.test(owner))
}

//
section('§5 the ordinary build ships the pair beside the bundle')
if (!existsSync(BIN)) {
  console.log('  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it')
} else {
  const driver = join(ROOT, 'dist', SPLASH_DRIVER)
  const core = join(ROOT, 'dist', SPLASH_CORE)
  check('dist/splash.mjs sits beside mercury.mjs', existsSync(driver))
  check('dist/splash-core.mjs sits beside it (the pair)', existsSync(core))
  if (existsSync(driver) && existsSync(core)) {
    check('the shipped driver is the canonical asset byte-for-byte', readFileSync(driver).equals(readFileSync(join(ROOT, 'assets', 'splash', 'mercury-splash.mjs'))))
    check('the shipped core is the canonical asset byte-for-byte', readFileSync(core).equals(readFileSync(join(ROOT, 'assets', 'splash', SPLASH_CORE))))
  }
  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { splash?: { path?: string; core?: string } }) : null
  check('the manifest records the pair', manifest?.splash?.path === SPLASH_DRIVER && manifest?.splash?.core === SPLASH_CORE, JSON.stringify(manifest?.splash ?? null))
  const real = resolveSplashAsset({ bundleDir: join(ROOT, 'dist'), home: null })
  check('the runtime resolver answers the payload rung for this dist', real?.rung === 'payload' && real.driver === driver)
}

//
section('§6 the road on a real PTY')
const PY = '/usr/bin/python3'
const pyProbe = spawnSync(PY, ['-c', 'import pty, pyte'], { encoding: 'utf8', timeout: 15_000 })
if (!existsSync(BIN)) {
  console.log('  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it')
} else if (pyProbe.status !== 0) {
  console.log('  [SKIP] python3 pty + pyte unavailable — the PTY legs need the capture substrate')
} else {
  const COLS = 100
  const ROWS = 30
  const HOME = resolveProofHome([ROOT])
  const scratch = mkdtempSync(join(tmpdir(), 'direct-splash-pty-'))
  // The splash's lockup needle: the wordmark's top row from the visual-
  // contract baseline at this exact geometry (the first row carrying block
  // glyphs), so the pin is the recorded lockup, never a retyped string.
  const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts', 'visual-contract', 'baselines', `splash-lockup-${COLS}x${ROWS}.json`), 'utf8')) as { grid: Array<Array<{ c: string }>> }
  const baselineRows = baseline.grid.map(row => row.map(c => c.c).join('').trim())
  const WORDMARK = baselineRows.find(r => r.includes('█')) ?? ''
  check('the baseline carries a lockup wordmark row', WORDMARK.length > 0)
  // The hold frame's escape hatch is painted by the splash alone — the
  // runtime's face never writes it — so its bytes in the raw stream are the
  // proof that a splash ran and handed over.
  const HOLD_HINT = 'starting…  (stuck? type: reset↵)'
  const FACE_ROW = 'New Session'

  const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: HOME,
      MERCURY_HOME: HOME,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      TERM: 'xterm-256color',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_SPLASH_IDLE_MS: '20000',
      ...extra,
    }
    // The operator's own session may carry splash state — strip every
    // spelling the road reads unless the leg sets it deliberately.
    for (const k of ['MERCURY_SPLASH', 'MERCURY_NO_BANNER', 'MERCURY_FULLSCREEN', 'MERCURY_ALT_HELD', 'MERCURY_SPLASH_HANDOFF', 'MERCURY_LAUNCH_ID', 'MERCURY_SPLASH_CHAT', 'MERCURY_SPLASH_VIEW', 'MERCURY_SPLASH_ONESHOT', 'MERCURY_REDUCED_MOTION', 'MERCURY_LAUNCH_RIPPLE', 'NO_COLOR', 'MERCURY_TRUECOLOR']) {
      if (!(k in extra)) delete env[k]
    }
    return env
  }
  const resetHome = (): void => {
    for (const f of ['splash-action.json', 'splash-action.txt', 'boot-attempts.json']) rmSync(join(HOME, f), { force: true })
  }
  interface Capture {
    ok: boolean
    status: number | null
    stderr: string
    final: string[]
    marks: Record<string, string[]>
    raw: Buffer
    endReason: string
  }
  // A vshot capture: the final grid, every mark's grid, and the raw byte
  // stream (VSHOT_TEE) so splash-only bytes can be asserted directly.
  const capture = (tag: string, argv: string[], env: NodeJS.ProcessEnv, sends: unknown[], readyText: string | undefined, total: number): Capture => {
    const dir = join(scratch, tag)
    mkdirSync(dir, { recursive: true })
    const gridPath = join(dir, 'grid.json')
    const teePath = join(dir, 'tee.bin')
    const cfgPath = join(dir, 'cfg.json')
    writeFileSync(cfgPath, JSON.stringify({ argv, cols: COLS, rows: ROWS, total, out: gridPath, sends, ...(readyText ? { readyText, readySettleTicks: 3 } : {}) }))
    const r = spawnSync(PY, [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
      encoding: 'utf8',
      env: { ...env, VSHOT_TEE: teePath },
      timeout: vshotBudgetMs(120_000),
    })
    const rowsOf = (grid: Array<Array<{ c?: string }>>): string[] => grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd())
    let final: string[] = []
    const marks: Record<string, string[]> = {}
    let endReason = ''
    try {
      const parsed = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c?: string }>>; marks?: Array<{ label: string; grid: Array<Array<{ c?: string }>> }>; endReason?: string }
      final = rowsOf(parsed.grid)
      for (const m of parsed.marks ?? []) marks[m.label] = rowsOf(m.grid)
      endReason = parsed.endReason ?? ''
    } catch {
      /* the caller's assertions report it */
    }
    let raw = Buffer.alloc(0)
    try {
      // length-prefixed frames: >II (tick, len) + bytes
      const tee = readFileSync(teePath)
      const chunks: Buffer[] = []
      let off = 0
      while (off + 8 <= tee.length) {
        const len = tee.readUInt32BE(off + 4)
        chunks.push(tee.subarray(off + 8, off + 8 + len))
        off += 8 + len
      }
      raw = Buffer.concat(chunks)
    } catch {
      /* no tee ⇒ empty raw */
    }
    return { ok: r.status === 0, status: r.status, stderr: (r.stderr ?? '').slice(-600), final, marks, raw, endReason }
  }
  const hasRow = (rows: string[], needle: string): boolean => rows.some(r => r.includes(needle))
  const rawHas = (raw: Buffer, needle: string): boolean => raw.includes(Buffer.from(needle, 'utf8'))

  // — a bare start: the splash's lockup first, then the Boot face —
  resetHome()
  {
    const c = capture('bare', ['node', BIN], childEnv(), [{ awaitText: WORDMARK, atTick: 40, data: '', mark: 'lockup' }], FACE_ROW, 90)
    check('bare: the capture ran (the mark fired, the face became ready)', c.ok, `status ${c.status} · ${c.endReason} · ${c.stderr}`)
    const lockup = c.marks['lockup'] ?? []
    check('bare: the splash painted the lockup wordmark FIRST', hasRow(lockup, WORDMARK), lockup.slice(0, 8).join('\n'))
    check('bare: …with no Boot face card on that frame (the splash, not the face)', lockup.length > 0 && !hasRow(lockup, FACE_ROW))
    check('bare: the splash handed over through its hold frame (splash-only bytes in the stream)', rawHas(c.raw, HOLD_HINT))
    check('bare: the Boot face landed after the splash', hasRow(c.final, FACE_ROW), c.final.slice(0, 12).join('\n'))
    check('bare: the face shows the same wordmark (one scene across the seam)', hasRow(c.final, WORDMARK))
    check('bare: the hold frame is gone once the face painted', !hasRow(c.final, HOLD_HINT))
  }

  // — MERCURY_SPLASH=off: the Boot face directly —
  resetHome()
  {
    const c = capture('off', ['node', BIN], childEnv({ MERCURY_SPLASH: 'off' }), [{ awaitText: WORDMARK, atTick: 40, data: '', mark: 'first' }], FACE_ROW, 90)
    check('off: the capture ran', c.ok, `status ${c.status} · ${c.endReason} · ${c.stderr}`)
    check('off: no splash bytes in the stream', !rawHas(c.raw, HOLD_HINT))
    check('off: the wordmark appeared (the face paints it itself)', hasRow(c.marks['first'] ?? [], WORDMARK))
    check('off: the Boot face landed', hasRow(c.final, FACE_ROW))
  }

  // — a launcher already handed over: never a second splash —
  resetHome()
  {
    const c = capture('handoff-preset', ['node', BIN], childEnv({ MERCURY_SPLASH_HANDOFF: '1' }), [], FACE_ROW, 90)
    check('handoff pre-set: the capture ran', c.ok, `status ${c.status} · ${c.endReason} · ${c.stderr}`)
    check('handoff pre-set: no second splash (no splash bytes in the stream)', !rawHas(c.raw, HOLD_HINT))
    check('handoff pre-set: the Boot face landed (the consumer ran on an empty receipt — a plain boot)', hasRow(c.final, FACE_ROW))
  }

  // — a prompt argument / --continue: explicit journeys, no splash —
  for (const [tag, extra] of [['prompt', ['say hello']], ['continue', ['--continue']]] as const) {
    resetHome()
    const c = capture(tag, ['node', BIN, ...extra], childEnv(), [], undefined, 25)
    check(`${tag}: something painted (the boot went on)`, c.raw.length > 0, `status ${c.status} · ${c.stderr}`)
    check(`${tag}: no splash (no splash bytes in the stream)`, !rawHas(c.raw, HOLD_HINT))
  }

  // — the asset moved away: a plain boot, no error —
  resetHome()
  {
    const moved = join(scratch, 'moved', 'dist')
    mkdirSync(moved, { recursive: true })
    copyFileSync(BIN, join(moved, 'mercury.mjs'))
    copyFileSync(join(ROOT, 'dist', 'manifest.json'), join(moved, 'manifest.json'))
    const c = capture('moved', ['node', join(moved, 'mercury.mjs')], childEnv(), [], FACE_ROW, 90)
    check('moved: the capture ran', c.ok, `status ${c.status} · ${c.endReason} · ${c.stderr}`)
    check('moved: no splash (no rung carries the pair)', !rawHas(c.raw, HOLD_HINT))
    check('moved: the Boot face landed plain', hasRow(c.final, FACE_ROW))
    check('moved: no error surfaced', !rawHas(c.raw, 'Cannot find module') && !rawHas(c.raw, 'Mercury exited on an error'))
  }

  // — Ctrl-C on the splash: exit 0, the screen restored, the cancel receipt
  //   left behind (the runtime consumer never ran). Two worlds: the inline
  //   WAITING splash (MERCURY_FULLSCREEN=0 — it waits for a key), and the
  //   fullscreen CINEMATIC one, where the keystroke lands mid-animation —
  //   the driver sends it on the first repaint after the lockup frame, once
  //   the splash is inside its event loop with raw mode and its handlers
  //   armed (the human's own timing: never inside the first frame's tick).
  {
    const driver = join(scratch, 'cancel-driver.py')
    // A PTY driver of its own: feed the stream to pyte, send ^C when the
    // wordmark row is on screen (plus, when asked, the first repaint after
    // it), then read to EOF and report the exit status and the bytes written
    // after the keystroke.
    writeFileSync(
      driver,
      [
        'import json, os, pty, select, sys, time, fcntl, termios, struct',
        'import pyte',
        'cfg = json.load(open(sys.argv[1]))',
        'cols, rows = cfg["cols"], cfg["rows"]',
        'screen = pyte.Screen(cols, rows); stream = pyte.ByteStream(screen)',
        'pid, fd = pty.fork()',
        'if pid == 0:',
        '    os.environ["COLUMNS"], os.environ["LINES"] = str(cols), str(rows)',
        '    os.execvp(cfg["argv"][0], cfg["argv"])',
        'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))',
        'needle = cfg["needle"]; on_repaint = cfg.get("onRepaint", False); settle = cfg.get("settleMs", 0) / 1000.0',
        'sent = False; seen_at = None; seen_text = None; before = bytearray(); after = bytearray()',
        't0 = time.monotonic(); deadline = t0 + cfg["budget"]; hold_seen_before_send = False',
        'def rows_text():',
        '    return ["".join(screen.buffer[y][x].data for x in range(cols)) for y in range(rows)]',
        'while time.monotonic() < deadline:',
        '    r, _, _ = select.select([fd], [], [], 0.02)',
        '    if fd in r:',
        '        try:',
        '            data = os.read(fd, 65536)',
        '        except OSError:',
        '            break',
        '        if not data:',
        '            break',
        '        (after if sent else before).extend(data)',
        '        stream.feed(data)',
        '    if sent:',
        '        continue',
        '    text = rows_text()',
        '    if seen_at is None and any(needle in t for t in text):',
        '        seen_at = time.monotonic(); seen_text = "\\n".join(text)',
        '        continue',
        '    if seen_at is None:',
        '        continue',
        '    if cfg["holdHint"].encode("utf-8") in before:',
        '        hold_seen_before_send = True',
        '    due = (time.monotonic() - seen_at) >= settle',
        '    if on_repaint:',
        '        due = due and ("\\n".join(text) != seen_text)',
        '    if due:',
        '        os.write(fd, b"\\x03"); sent = True',
        'if time.monotonic() >= deadline:',
        '    os.kill(pid, 9)',
        '_, status = os.waitpid(pid, 0)',
        'code = os.waitstatus_to_exitcode(status)',
        'json.dump({"sent": sent, "code": code, "after": after.hex(), "before_len": len(before), "final": rows_text(), "holdSeenBeforeSend": hold_seen_before_send}, open(cfg["out"], "w"))',
      ].join('\n'),
    )
    const cancelLeg = (tag: string, env: NodeJS.ProcessEnv, opts: { onRepaint: boolean; settleMs: number }): void => {
      resetHome()
      const cfg = join(scratch, `${tag}-cfg.json`)
      const out = join(scratch, `${tag}-out.json`)
      writeFileSync(cfg, JSON.stringify({ argv: ['node', BIN], cols: COLS, rows: ROWS, needle: WORDMARK, holdHint: HOLD_HINT, budget: 40, out, ...opts }))
      const r = spawnSync(PY, [driver, cfg], { encoding: 'utf8', env, timeout: vshotBudgetMs(90_000) })
      check(`${tag}: the driver ran`, r.status === 0 && existsSync(out), `status ${r.status} · ${(r.stderr ?? '').slice(-400)}`)
      if (!existsSync(out)) return
      const res = JSON.parse(readFileSync(out, 'utf8')) as { sent: boolean; code: number; after: string; final: string[]; holdSeenBeforeSend: boolean }
      const after = Buffer.from(res.after, 'hex')
      check(`${tag}: Ctrl-C was sent while the splash held the screen`, res.sent && !res.holdSeenBeforeSend, res.sent ? 'the splash had already handed over' : 'the lockup never appeared')
      check(`${tag}: Mercury exited 0 (the launcher's stand-down, in-process)`, res.code === 0, `exit ${res.code}`)
      check(`${tag}: the screen was restored after the keystroke (alt screen closed, cursor shown — the tail)`, after.includes(Buffer.from('\x1b[?1049l')) && after.includes(Buffer.from('\x1b[?25h')))
      // No handoff ever happened: the hold frame is the splash's handover
      // gesture and the runtime paints nothing without it. (The WAITING
      // splash paints its own launcher card — the face's row words are not
      // a tell there; the cinematic frame carries no card, so they are.)
      check(`${tag}: no handoff after the keystroke (no hold frame — the runtime never painted)`, !after.includes(Buffer.from(HOLD_HINT)))
      if (opts.onRepaint) {
        check(`${tag}: the Boot face never painted`, !res.final.some(row => row.includes(FACE_ROW)) && !after.includes(Buffer.from(FACE_ROW)))
      }
      const receiptPath = join(HOME, 'splash-action.json')
      let receipt: { action?: string } | null = null
      try {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { action?: string }
      } catch {
        receipt = null
      }
      check(`${tag}: the splash's cancel receipt is left for the next sweep (the consumer never ran)`, receipt?.action === 'cancel', existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8').slice(0, 120) : 'no receipt')
    }
    cancelLeg('cancel-waiting', childEnv({ MERCURY_FULLSCREEN: '0' }), { onRepaint: false, settleMs: 300 })
    cancelLeg('cancel-cinematic', childEnv(), { onRepaint: true, settleMs: 0 })
  }
  resetHome()
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DIRECT-SPLASH PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
