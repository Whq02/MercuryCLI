#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { spawnCaptureSync, captureExitDetail } from '../lib/spawnCapture.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const work = mkdtempSync(join(tmpdir(), 'vshot-ready-'))
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) console.log('    hint: fix the ready, stable, send and refusal handling in scripts/ui/vshot.py (the readyText, stableTicks, sends and progressBudgetTicks settings); checks 13 also read captureExitDetail in scripts/lib/spawnCapture.ts')
  if (!cond) failures++
}

const CHILD = [
  'python3',
  '-u',
  '-c',
  'import time;print("BOOT");time.sleep(1.0);print("READY-SENTINEL");time.sleep(60)',
]

interface Cap {
  seconds: number
  gridText: string
  status: number | null
  stderr: string
  payload: {
    sendReceipts?: Array<{ atTick: number }>
    readyAt?: number | null
    endedAtTick?: number
    endReason?: string
    readyTextDeclared?: string[]
    refusals?: Array<{ code: string; message: string; summary: string; ceilingTicks: number; seen: string }>
  }
}
function capture(cfg: Record<string, unknown>, scale = '1'): Cap {
  const cfgPath = join(work, `cfg-${Math.random().toString(36).slice(2)}.json`)
  const outPath = cfgPath.replace('.json', '-out.json')
  writeFileSync(cfgPath, JSON.stringify({ cols: 60, rows: 8, argv: CHILD, out: outPath, ...cfg }))
  const t0 = Date.now()
  const r = spawnCaptureSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(60_000),
    env: { ...process.env, MERCURY_VSHOT_BUDGET_SCALE: scale },
  })
  const seconds = (Date.now() - t0) / 1000
  const payload = JSON.parse(readFileSync(outPath, 'utf8'))
  return { seconds, gridText: r.stdout ?? '', status: r.status, stderr: r.stderr ?? '', payload }
}

console.log('════ vshot observed-ready laws ════')
{
  const c = capture({ total: 50, readyText: 'READY-SENTINEL' })
  check(
    `1. READY: exits early (${c.seconds.toFixed(1)}s ≪ the 10s budget) with the text on the grid`,
    c.seconds < 6 && c.gridText.includes('READY-SENTINEL'),
    `${c.seconds}s`,
  )
  check(
    '1b. READY receipt: readyAt recorded, endReason ready, exit 0',
    c.status === 0 && typeof c.payload.readyAt === 'number' && c.payload.endReason === 'ready',
    JSON.stringify({ status: c.status, readyAt: c.payload.readyAt, endReason: c.payload.endReason }),
  )
}
{
  const c = capture({ total: 8, readyText: 'NEVER-THERE' })
  check(
    `2. DEADLINE: never-ready runs the FULL fixed budget (${c.seconds.toFixed(1)}s ≥ 1.6s)`,
    c.seconds >= 1.6,
    `${c.seconds}s`,
  )
  check(
    '2b. NEVER-READY refuses: non-zero exit carrying the diagnostic',
    c.status !== 0 && /NEVER-READY/.test(c.stderr),
    `status=${c.status} stderr=${JSON.stringify(c.stderr.slice(0, 140))}`,
  )
  check(
    '2c. NEVER-READY receipt: readyAt null, endReason budget',
    c.payload.readyAt === null && c.payload.endReason === 'budget',
    JSON.stringify({ readyAt: c.payload.readyAt, endReason: c.payload.endReason }),
  )
}
{
  const c = capture({ total: 50, readyText: 'READY-SENTINEL', sends: [{ atTick: 12, data: 'x' }] })
  const receipts = c.payload.sendReceipts ?? []
  check(
    `3. SENDS: no exit before the tick-12 send dispatched (${c.seconds.toFixed(1)}s ≥ 2.4s, receipt present)`,
    c.seconds >= 2.4 && c.seconds < 9 && receipts.length === 1,
    `${c.seconds}s receipts=${JSON.stringify(receipts)}`,
  )
}
{
  const c = capture({ total: 10 })
  check(
    `4. ABSENT: no readyText ⇒ fixed duration (${c.seconds.toFixed(1)}s ≥ 2.0s)`,
    c.seconds >= 2.0,
    `${c.seconds}s`,
  )
}
{
  const c = capture({
    total: 60,
    readyText: 'READY-SENTINEL',
    sends: [{ atTick: 40, awaitText: 'READY-SENTINEL', data: 'x' }],
  })
  const receipts = c.payload.sendReceipts ?? []
  check(
    `5. AWAIT-SEND: gated send fired early (receipt tick ${receipts[0]?.atTick} < 20) and capture ended ${c.seconds.toFixed(1)}s ≪ 12s`,
    receipts.length === 1 && (receipts[0]?.atTick ?? 99) < 20 && c.seconds < 7,
    `${c.seconds}s receipts=${JSON.stringify(receipts)}`,
  )
}
{
  const c = capture({
    total: 14,
    sends: [{ atTick: 9, awaitText: 'NEVER-THERE', data: 'x' }],
  })
  const receipts = c.payload.sendReceipts ?? []
  check(
    `6. AWAIT-DEADLINE: unseen awaitText degrades to the atTick schedule (receipt tick ${receipts[0]?.atTick} ≥ 9)`,
    receipts.length === 1 && (receipts[0]?.atTick ?? 0) >= 9,
    JSON.stringify(receipts),
  )
}

{
  const c = capture({ total: 50, stableTicks: 4 })
  check(
    `7. STABLE-ALONE HAZARD: a mid-load pause reads as settled (exited ${c.seconds.toFixed(1)}s, pre-sentinel) — needles are mandatory in annotations`,
    c.seconds < 6 && !c.gridText.includes('READY-SENTINEL'),
    `${c.seconds}s`,
  )
}
{
  const anim = [
    'python3',
    '-u',
    '-c',
    'import time\nwhile True: print("tick", time.time()); time.sleep(0.1)',
  ]
  const c = capture({ total: 12, stableTicks: 4, argv: anim })
  check(
    `8. ANIMATED: never-stable runs the FULL budget (${c.seconds.toFixed(1)}s ≥ 2.4s)`,
    c.seconds >= 2.4,
    `${c.seconds}s`,
  )
}
{
  const c = capture({ total: 50, stableTicks: 3, readyText: 'READY-SENTINEL' })
  check(
    `9. COMPOSED: ready+stable exits early with the needle present (${c.seconds.toFixed(1)}s ≪ 10s)`,
    c.seconds < 6 && c.gridText.includes('READY-SENTINEL'),
    `${c.seconds}s`,
  )
}

{
  const c = capture({
    total: 60,
    readyText: 'READY-SENTINEL',
    sends: [
      { atTick: 40, awaitText: 'BOOT', data: 'a' },
      { afterPrevTicks: 3, data: 'b' },
    ],
  })
  const r = c.payload.sendReceipts ?? []
  const gap = (r[1]?.atTick ?? 0) - (r[0]?.atTick ?? 0)
  check(
    `10. RELATIVE: send 2 fired ${gap} ticks after send 1 (want ≈3), whole capture ${c.seconds.toFixed(1)}s ≪ 12s`,
    r.length === 2 && gap >= 3 && gap <= 5 && c.seconds < 8,
    `receipts=${JSON.stringify(r)} ${c.seconds}s`,
  )
}

{
  const movie = capture(
    {
      total: 60,
      readyText: 'READY-SENTINEL',
      sends: [
        { atTick: 4, data: 'a' },
        { afterPrevTicks: 2, data: 'b' },
      ],
    },
    '3',
  )
  const r = movie.payload.sendReceipts ?? []
  const gap = (r[1]?.atTick ?? 0) - (r[0]?.atTick ?? 0)
  check(
    `11a. MOVIE: at scale 3 the blind tick-4 send fires at ~tick 12 (${r[0]?.atTick}) and the relative gap triples (${gap} ≈ 6)`,
    r.length === 2 && (r[0]?.atTick ?? 0) >= 12 && (r[0]?.atTick ?? 99) <= 16 && gap >= 6 && gap <= 8,
    `receipts=${JSON.stringify(r)}`,
  )
  check(
    `11b. MOVIE: observed-ready still ends the scaled scene early (${movie.seconds.toFixed(1)}s ≪ the 36s scaled budget)`,
    movie.status === 0 && movie.seconds < 12,
    `${movie.seconds}s status=${movie.status}`,
  )
  const fixed = capture({ total: 10 }, '3')
  check(
    `11c. CARVE-OUT: a pure fixed-window capture stays AUTHORED at scale 3 (${fixed.seconds.toFixed(1)}s ≈ 2s, not 6s)`,
    fixed.seconds >= 2.0 && fixed.seconds < 4.5,
    `${fixed.seconds}s`,
  )
  const stretched = capture({ total: 8, readyText: 'NEVER-THERE' }, '3')
  check(
    `11d. DEADLINE SCALES: a declared-ready scene's never-ready budget runs scaled (${stretched.seconds.toFixed(1)}s ≥ 4.0s, ended budget)`,
    stretched.seconds >= 4.0 && stretched.payload.endReason === 'budget' && stretched.status !== 0,
    `${stretched.seconds}s ${stretched.payload.endReason}`,
  )
}

{
  const awaitPattern = String.raw`\A[^\n]*╭─+╮(?=[\s\S]*POPUP-READY)(?=[\s\S]*\n│[❯›][^\n]*│(?: *\n| *\Z))`
  const send = { atTick: 1, awaitText: 'POPUP-READY', awaitPattern, requireAwait: true, awaitSettleTicks: 2, data: '', mark: 'popup' }
  for (const missing of ['first row', 'composer row']) {
    const initial = `\x1b[2J\x1b[H${missing === 'first row' ? '' : '╭────────╮'}\x1b[3;1HPOPUP-READY${missing === 'composer row' ? '' : '\x1b[7;1H│❯ message atlas │'}`
    const c = capture({ total: 6, sends: [send], argv: ['python3', '-u', '-c', `import time;print(${JSON.stringify(initial)},end='',flush=True);time.sleep(60)`] })
    check(`12. FRAME: a popup without its ${missing} never satisfies the sample gate`, c.status === 4 && (c.payload.sendReceipts ?? []).length === 0, `status=${c.status} receipts=${JSON.stringify(c.payload.sendReceipts)}`)
  }
  const initial = '\x1b[2J\x1b[H╭────────╮\x1b[3;1HPOPUP-READY'
  const c = capture({ total: 20, readyText: 'POPUP-READY', sends: [send], argv: ['python3', '-u', '-c', `import time;print(${JSON.stringify(initial)},end='',flush=True);time.sleep(0.8);print('\\x1b[7;1H│❯ message atlas │',end='',flush=True);time.sleep(60)`] })
  check('12. FRAME: the sample waits until popup, first row and composer coexist', c.status === 0 && c.payload.sendReceipts?.length === 1 && c.payload.sendReceipts[0]!.atTick >= 6, `status=${c.status} receipts=${JSON.stringify(c.payload.sendReceipts)}`)
}

{
  const c = capture({ total: 6, readyText: 'FINAL-NEVER-THERE', sends: [{ data: '', requireAwait: true, awaitText: 'SEND-NEVER-THERE', mark: 'missing' }] })
  const refusals = c.payload.refusals ?? []
  check('13. REFUSAL: ready failure retains the undelivered-send diagnosis too', c.status === 3 && refusals.some(r => r.code === 'NEVER-READY') && refusals.some(r => r.code === 'UNDELIVERED-SENDS'), JSON.stringify({ status: c.status, refusals }))
  check('13. REFUSAL: the receipt says never settled, the ceiling, and the screen it saw', refusals.length === 2 && refusals.every(r => r.ceilingTicks === 6 && r.seen.includes('BOOT') && /never settled.*ceiling/.test(r.message)), JSON.stringify(refusals))
  check('13. REFUSAL: stdout and stderr carry every refusal verbatim', refusals.length === 2 && refusals.every(r => c.stderr.includes(r.message) && c.gridText.includes(r.message)), c.stderr)
  check('13. REFUSAL: a legacy tail-only exit row keeps all refusal codes, ceiling and observed screen', [c.stderr.slice(-200), c.gridText.slice(-200)].every(tail => ['NEVER-READY', 'UNDELIVERED-SENDS', 'never settled', 'ceiling', 'saw='].every(word => tail.includes(word))) && refusals.every(r => r.summary.length <= 190 && c.stderr.trimEnd().endsWith(r.summary)), c.stderr.slice(-200))
  const healthy = capture({ total: 20, readyText: 'READY-SENTINEL' })
  check('13. REFUSAL: a settled capture records no refusal and does not pollute its frame echo', healthy.status === 0 && Array.isArray(healthy.payload.refusals) && healthy.payload.refusals.length === 0 && !healthy.gridText.includes('[vshot]'), healthy.stderr)
  const cfgPath = join(work, 'discarded-return.json')
  writeFileSync(cfgPath, JSON.stringify({ cols: 60, rows: 8, total: 3, argv: CHILD, out: join(work, 'discarded-return-out.json'), readyText: 'NEVER' }))
  const entry = join(ROOT, 'scripts/lib/spawnCapture.ts')
  const silentCaller = spawnSync(process.execPath, ['--eval', `import { spawnCaptureSync } from ${JSON.stringify(entry)}; spawnCaptureSync('/usr/bin/python3', ${JSON.stringify([VSHOT, cfgPath])}, { encoding: 'utf8', timeout: 10000 });`], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, MERCURY_VSHOT_BUDGET_SCALE: '1' } })
  check('13. REFUSAL: even a caller discarding the returned result prints the exit row and refusal', silentCaller.status === 0 && /capture exit=3.*ceiling=10000ms/.test(silentCaller.stderr) && /NEVER-READY: never settled/.test(silentCaller.stderr) && /saw=/.test(silentCaller.stderr), silentCaller.stderr)
  const timedOut = captureExitDetail({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('capture expired'), { code: 'ETIMEDOUT' }), stderr: '' }, 1234)
  check('13. REFUSAL: a killed capture without stderr still names status, signal, timeout and ceiling', ['exit=null', 'SIGTERM', 'ETIMEDOUT', '1234ms'].every(word => timedOut.includes(word)), timedOut)
}

{
  const progressChild = (finish: boolean): string[] => ['python3', '-u', '-c', [
    'import time',
    'print("FIRST-MARK", flush=True)',
    'input()',
    'time.sleep(2.5)',
    'print("SECOND-MARK", flush=True)',
    'input()',
    ...(finish ? ['time.sleep(2.5)', 'print("FINAL-MARK", flush=True)', 'time.sleep(60)'] : ['while True: print("unrelated output", flush=True); time.sleep(0.05)']),
  ].join('\n')]
  const sends = [
    { requireAwait: true, awaitText: 'FIRST-MARK', data: '\r' },
    { requireAwait: true, awaitText: 'SECOND-MARK', data: '\r' },
  ]
  const fixed = capture({ total: 20, readyText: 'FINAL-MARK', sends, argv: progressChild(true) })
  check('14. PROGRESS control: without an opt-in the original whole-capture ceiling still refuses', fixed.status !== 0 && fixed.payload.endReason === 'budget')
  const progress = capture({ total: 20, progressBudgetTicks: 20, readyText: 'FINAL-MARK', sends, argv: progressChild(true) })
  check('14. PROGRESS: each observed send gives the next product mark its own bounded wait', progress.status === 0 && progress.payload.endReason === 'ready' && progress.payload.sendReceipts?.length === 2 && (progress.payload.readyAt ?? 0) >= 20, JSON.stringify(progress.payload))
  const stalled = capture({ total: 20, progressBudgetTicks: 20, readyText: 'FINAL-MARK', sends, argv: progressChild(false) })
  const lastSend = stalled.payload.sendReceipts?.at(-1)?.atTick
  check('14. PROGRESS: unrelated output cannot renew the wait or satisfy its missing mark', stalled.status !== 0 && stalled.payload.endReason === 'budget' && lastSend !== undefined && stalled.payload.refusals?.some(row => row.code === 'NEVER-READY' && row.ceilingTicks === lastSend + 20) === true, JSON.stringify(stalled.payload))
}

{
  const account = spawnSync('/usr/bin/python3', ['-c', 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)'], { encoding: 'utf8' }).stdout.trim()
  const scratchHome = join(work, 'scratch-home')
  const pinned = join(work, 'pinned')
  const store = join(account, '.mercury')
  const profile = join(account, '.mercury2')
  const linkToStore = join(work, 'link-to-the-store')
  const linkToProfile = join(work, 'link-to-a-profile')
  mkdirSync(scratchHome)
  symlinkSync(store, linkToStore)
  symlinkSync(profile, linkToProfile)
  const where = "the two refusals stand ahead of the capture slot in scripts/ui/vshot.py (_child_config_home, _operators_own_store); the tree's two guards are configHomeIsReal in scripts/lib/loginDriverGuard.ts and suite_home_guard in scripts/lib/suite-env.sh"
  type Names = { HOME: string; MERCURY_CONFIG_DIR?: string; MERCURY_HOME?: string }
  interface Row { name: string; names: Names; cfg?: Record<string, unknown>; own: boolean; guardStill?: string }
  const rows: Row[] = [
    { name: 'no pin, HOME the account home', names: { HOME: account }, own: true },
    { name: 'an empty pin, HOME the account home', names: { HOME: account, MERCURY_CONFIG_DIR: '' }, own: true },
    { name: 'a scratch pin, HOME the account home', names: { HOME: account, MERCURY_CONFIG_DIR: pinned }, own: false },
    { name: 'the pin names the store', names: { HOME: account, MERCURY_CONFIG_DIR: store }, own: true },
    { name: 'the pin is a link to the store', names: { HOME: account, MERCURY_CONFIG_DIR: linkToStore }, own: true },
    { name: 'the pin names a profile store', names: { HOME: account, MERCURY_CONFIG_DIR: profile }, own: true },
    { name: 'the pin is a link to a profile store', names: { HOME: account, MERCURY_CONFIG_DIR: linkToProfile }, own: true },
    { name: 'the pin names the store under a scratch HOME', names: { HOME: scratchHome, MERCURY_CONFIG_DIR: store }, own: true },
    { name: 'no pin under a scratch HOME', names: { HOME: scratchHome }, own: false, guardStill: 'a proof entry with no pin is given a proof home wherever HOME points; the staged install drives stand on a scratch HOME with no pin' },
    { name: 'no pin, MERCURY_HOME on a scratch folder', names: { HOME: account, MERCURY_HOME: pinned }, own: false, guardStill: 'MERCURY_HOME is the launcher word, an operator pin and never a proof pin' },
    { name: 'no pin, MERCURY_HOME on the store, a scratch HOME', names: { HOME: scratchHome, MERCURY_HOME: store }, own: true },
    { name: 'a scratch pin over MERCURY_HOME on the store', names: { HOME: account, MERCURY_CONFIG_DIR: pinned, MERCURY_HOME: store }, own: false },
    { name: 'a relative pin from a config whose cwd is the account home', names: { HOME: account, MERCURY_CONFIG_DIR: '.mercury' }, cfg: { cwd: account }, own: true },
    { name: "the pin names .mercury under a scratch HOME", names: { HOME: scratchHome, MERCURY_CONFIG_DIR: join(scratchHome, '.mercury') }, own: false, guardStill: "the product's default store follows HOME, so the guard holds HOME's .mercury beside the account's" },
  ]
  let started = 0
  const start = (names: Names, cfg: Record<string, unknown> = {}): { refused: boolean; status: number | null; words: string; ran: boolean; left: string[] } => {
    const at = join(work, `home-${++started}`)
    const temp = join(at, 'tmp')
    mkdirSync(temp, { recursive: true })
    const witness = join(at, 'witness')
    const cfgPath = join(at, 'cfg.json')
    writeFileSync(cfgPath, JSON.stringify({ cols: 40, rows: 4, total: 3, argv: ['/usr/bin/python3', '-c', 'import sys; open(sys.argv[1], "w").write("ran")', witness], out: join(at, 'out.json'), ...cfg }))
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, MERCURY_PROCESS_LEDGER_DIR: join(at, 'ledger'), HOME: names.HOME }
    for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const) {
      if (names[name] === undefined) delete env[name]
      else env[name] = names[name]
    }
    const r = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(30_000), env })
    const ran = existsSync(witness)
    return { refused: r.status !== 0 && !ran, status: r.status, words: (r.stderr ?? '').trim(), ran, left: [...readdirSync(temp), ...['out.json', 'ledger'].filter(name => existsSync(join(at, name)))] }
  }
  const guardSays = new Map<Row, boolean>()
  for (const home of [account, scratchHome]) {
    const asked = rows.filter(row => row.names.HOME === home)
    const script = `import { configHomeIsReal } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'loginDriverGuard.ts'))}; console.log(JSON.stringify(${JSON.stringify(asked.map(row => ({ names: row.names, cwd: row.cfg?.cwd })))}.map(row => configHomeIsReal(row.names, row.cwd))))`
    const said = spawnSync(process.execPath, ['--eval', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: home } }).stdout.trim().split('\n').at(-1) ?? ''
    const answers: boolean[] = said.startsWith('[') ? JSON.parse(said) : []
    asked.forEach((row, i) => { if (typeof answers[i] === 'boolean') guardSays.set(row, answers[i]) })
  }
  const shellTemp = join(work, 'shell-guard-tmp')
  mkdirSync(shellTemp)
  const shellSays = (row: Row): boolean | undefined => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: row.names.HOME, TMPDIR: shellTemp, BUN: '/usr/bin/false' }
    for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const) {
      const value = row.names[name]
      if (value !== undefined) env[name] = value
    }
    const r = spawnSync('bash', ['-c', '. "$1" || exit 78; suite_home_guard "$2"; printf "%s\\n" "${MERCURY_CONFIG_DIR:-}"', '_', join(ROOT, 'scripts', 'lib', 'suite-env.sh'), join(ROOT, 'scripts', 'ui-2', 'run-all.sh')], { cwd: typeof row.cfg?.cwd === 'string' ? row.cfg.cwd : ROOT, encoding: 'utf8', env })
    return r.status === 0 ? (r.stdout.trim().split('\n').at(-1) ?? '') !== (row.names.MERCURY_CONFIG_DIR ?? '') : undefined
  }
  const refusals: Array<ReturnType<typeof start>> = []
  for (const row of rows) {
    const got = start(row.names, row.cfg)
    if (got.refused) refusals.push(got)
    const guard = guardSays.get(row)
    const shell = shellSays(row)
    const real = row.own || row.guardStill !== undefined
    check(
      `15. HOME: ${row.name}: the driver ${row.own ? 'refuses' : 'starts its child'}${row.guardStill ? `; the tree's two guards still say real, the more careful (${row.guardStill})` : ", as the tree's two guards say"}`,
      got.refused === row.own && got.ran === !row.own && guard === real && shell === real,
      `${JSON.stringify({ status: got.status, ran: got.ran, guard: guard ?? 'no answer', shellGuard: shell ?? 'no answer', words: got.words.slice(0, 200) })}; ${where}`,
    )
  }
  check("15. HOME: every refusal is one sentence that names the operator's own config home and the name to set", refusals.length === rows.filter(row => row.own).length && refusals.every(got => /refusing to start its child on the operator's own config home \(.+\): set MERCURY_CONFIG_DIR to a scratch folder/.test(got.words) && !got.words.includes('\n')), `${JSON.stringify(refusals.map(got => got.words.slice(0, 160)))}; ${where}`)
  check('15. HOME: a refusal stands before the fork and before any file of the run (no ledger, no receipt, nothing under its temp root)', refusals.length > 0 && refusals.every(got => got.left.length === 0 && got.status === 1), `${JSON.stringify(refusals.map(got => ({ status: got.status, left: got.left })))}; ${where}`)
  for (const carried of [{ MERCURY_CONFIG_DIR: join(work, 'the-config-says') }, {}]) {
    const got = start({ HOME: account, MERCURY_CONFIG_DIR: pinned }, { env: carried })
    check(`15. ENV: a config that carries env (${Object.keys(carried).length} names) is refused on a scratch home too, in one sentence that says where the environment goes`, got.refused && got.status === 1 && got.left.length === 0 && /refusing a config that carries env: .*the environment vshot\.py itself was started with/.test(got.words) && !got.words.includes('\n'), `${JSON.stringify(got)}; ${where}`)
  }
}
rmSync(work, { recursive: true, force: true })
if (failures === 0) {
  console.log(' ✅ VSHOT OBSERVED-READY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} VSHOT-READY FAILURE(S)`)
process.exit(1)
