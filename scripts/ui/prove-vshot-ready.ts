#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

rmSync(work, { recursive: true, force: true })
if (failures === 0) {
  console.log(' ✅ VSHOT OBSERVED-READY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} VSHOT-READY FAILURE(S)`)
process.exit(1)
