#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'
import { grabScreens, requireDist, runArtifactArena, visibleText, type PtyRead } from './artifactArena.ts'

requireDist()
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the POSIX capture driver is unavailable — ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}

const PTYDRIVE = join(import.meta.dir, 'ptydrive.py')
const PTYDRIVE_STILL_MS = 400
const PTYDRIVE_SETTLE_CEILING_MS = 2000
type SendRecord = { sent: number; atMs: number; b64: string; after?: string; paintAt?: number; settledAt?: number; stillMs?: number; ceiling?: boolean }
const COMPOSER = 'Type a prompt'
const COLS = 100
const ROWS = 30

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type DriveRow = Partial<SendRecord> & { ts?: number; anchor?: number; shiftMs?: number; needle?: string }

function driveRows(path: string): DriveRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as DriveRow)
}

function firstPaint(reads: readonly PtyRead[], needle: string): PtyRead | undefined {
  let carry = ''
  for (const r of reads) {
    const window = (carry + r.text).slice(-16384)
    if (visibleText(window).includes(needle)) return r
    carry = window
  }
  return undefined
}

function lastReadBefore(reads: readonly PtyRead[], ts: number): PtyRead | undefined {
  let last: PtyRead | undefined
  for (const r of reads) if (r.ts <= ts) last = r
  return last
}

function echoAfter(reads: readonly PtyRead[], sentTs: number, word: string): PtyRead | undefined {
  let carry = ''
  for (const r of reads) {
    const window = (carry + r.text).slice(-16384)
    if (r.ts >= sentTs && visibleText(window).includes(word)) return r
    carry = window
  }
  return undefined
}

section('§1 the first key on a fresh composer: sent at once, it lands on the settled frame')
{
  const WORD = 'firstkeyprobe'
  const run = await runArtifactArena({
    cols: COLS,
    rows: ROWS,
    turns: [{ kind: 'text', text: 'Spare.' }],
    sends: [`after:${COMPOSER}:0:${WORD}`],
    seconds: 12,
    keep: true,
  })
  const reads = run.ptyReads
  const t0 = reads[0]?.ts ?? 0
  const paint = firstPaint(reads, 'Typeaprompt')
  const send = run.sendLog[0] as SendRecord | undefined
  check('the composer painted and the first key was sent', paint !== undefined && send !== undefined, `paint ${paint === undefined ? 'never' : `+${paint.ts - t0}ms`} · driver: ${run.driverOut.trim().slice(-200)}`)
  if (paint !== undefined && send !== undefined) {
    const before = lastReadBefore(reads, send.sent)
    const quietBefore = before === undefined ? -1 : send.sent - before.ts
    const echo = echoAfter(reads, send.sent, WORD)
    const [final] = grabScreens(run, COLS, ROWS, [-1])
    const composerRow = final!.rows.find(r => r.includes(WORD)) ?? ''
    const settleGap = typeof send.settledAt === 'number' && typeof send.paintAt === 'number' ? Math.round(send.settledAt - send.paintAt) : -1
    console.log(`  the composer's placeholder painted at +${paint.ts - t0}ms; the key was sent at +${send.sent - t0}ms (${send.sent - paint.ts}ms after the paint); the output had been still for ${quietBefore}ms; echo ${echo === undefined ? 'never' : `+${echo.ts - send.sent}ms after the send`}`)
    console.log(`  the driver's receipt: ${JSON.stringify({ paintAt: send.paintAt, settledAt: send.settledAt, stillMs: send.stillMs, ceiling: send.ceiling })} · frame settled ${settleGap < 0 ? '(no receipt)' : `${settleGap}ms after its first paint`}`)
    check(`the key went only once the output had held still for ${PTYDRIVE_STILL_MS}ms after the placeholder painted`, quietBefore >= PTYDRIVE_STILL_MS - 1, `still for ${quietBefore}ms before the send`)
    check('the send record carries the settled-paint receipt (paintAt, settledAt, stillMs) and no ceiling', typeof send.paintAt === 'number' && typeof send.settledAt === 'number' && typeof send.stillMs === 'number' && send.stillMs >= PTYDRIVE_STILL_MS - 1 && send.ceiling === false, JSON.stringify(send))
    check('the key landed: the typed word echoed in the composer and stands on the final frame', echo !== undefined && composerRow.includes(WORD), composerRow.trim() || '(the word is on no row)')
  }
  run.cleanup()
}

section('§2 the state anchor arms on the settled composer, so a fixed-ms rider types into a settled frame too')
{
  const WORD = 'riderprobe'
  const run = await runArtifactArena({
    cols: COLS,
    rows: ROWS,
    turns: [{ kind: 'text', text: 'Spare.' }],
    sends: [`4500:${WORD}`],
    seconds: 12,
    keep: true,
  })
  const rows = driveRows(run.paths.drive)
  const anchor = rows.find(r => typeof r.anchor === 'number')
  const reads = run.ptyReads
  const send = run.sendLog[0] as SendRecord | undefined
  const paint = firstPaint(reads, 'Typeaprompt')
  check('the anchor armed and the rider fired', anchor !== undefined && send !== undefined && paint !== undefined, `anchor ${JSON.stringify(anchor)} · driver: ${run.driverOut.trim().slice(-200)}`)
  if (anchor !== undefined && send !== undefined && paint !== undefined) {
    const before = lastReadBefore(reads, send.sent)
    const quietBefore = before === undefined ? -1 : send.sent - before.ts
    console.log(`  the anchor's receipt: ${JSON.stringify({ paintAt: anchor.paintAt, stillMs: anchor.stillMs, ceiling: anchor.ceiling, shiftMs: anchor.shiftMs })}; the rider went ${send.sent - paint.ts}ms after the placeholder painted, ${quietBefore}ms after the last output`)
    check(`the anchor record carries the settled-paint receipt (stillMs ≥ ${PTYDRIVE_STILL_MS}, no ceiling)`, typeof anchor.paintAt === 'number' && typeof anchor.stillMs === 'number' && anchor.stillMs >= PTYDRIVE_STILL_MS - 1 && anchor.ceiling === false, JSON.stringify(anchor))
    check('the rider typed 500ms after the SETTLED composer, never 500ms after its first paint', send.sent - paint.ts >= PTYDRIVE_STILL_MS + 500 - 60, `${send.sent - paint.ts}ms after the paint`)
    const echo = echoAfter(reads, send.sent, WORD)
    check('the rider landed (its word echoed)', echo !== undefined)
  }
  run.cleanup()
}

section('§3 the driver alone: a needle whose output never holds still fires at the ceiling and says so; a never-painted needle stays unfired')
{
  const scratch = mkdtempSync(join(tmpdir(), 'ptydrive-settle-'))
  const out = join(scratch, 'drive.jsonl')
  const res = spawnSync(
    driver.python,
    [PTYDRIVE, '--cols', '40', '--rows', '10', '--seconds', '5', '--out', out, '--send', 'after:hello:0:X', '--send', 'after:absent:0:N', '--', 'sh', '-c', 'printf hello; i=0; while [ $i -lt 32 ]; do printf x; sleep 0.1; i=$((i+1)); done'],
    { encoding: 'utf8', timeout: 30_000 },
  )
  const rows = driveRows(out)
  const sent = rows.find(r => typeof r.sent === 'number')
  const t0 = rows.find(r => typeof r.ts === 'number')?.ts ?? 0
  const report = (res.stdout ?? '').trim().split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'
  const parsed = JSON.parse(report) as { sends?: number; unfired?: string[] }
  console.log(`  the chatty child: X sent ${sent === undefined ? 'never' : `+${sent.sent! - t0}ms`} · ${JSON.stringify({ stillMs: sent?.stillMs, ceiling: sent?.ceiling })} · unfired ${JSON.stringify(parsed.unfired)}`)
  check(`a needle whose output never holds still fires at the ceiling (${PTYDRIVE_SETTLE_CEILING_MS}ms after its paint), recorded as such`, sent !== undefined && sent.ceiling === true && typeof sent.settledAt === 'number' && typeof sent.paintAt === 'number' && sent.settledAt - sent.paintAt >= PTYDRIVE_SETTLE_CEILING_MS - 60 && sent.settledAt - sent.paintAt <= PTYDRIVE_SETTLE_CEILING_MS + 400, JSON.stringify(sent))
  check('a needle that never paints never fires, and the closing report names it', parsed.sends === 1 && Array.isArray(parsed.unfired) && parsed.unfired.length === 1 && /'absent'.*never painted/.test(parsed.unfired[0] ?? ''), report)
  rmSync(scratch, { recursive: true, force: true })
}

section('§4 under the hosted capture profile the still window stays authored; the ceiling stretches with the movie')
{
  const scratch = mkdtempSync(join(tmpdir(), 'ptydrive-settle-'))
  const out = join(scratch, 'drive.jsonl')
  const res = spawnSync(
    driver.python,
    [PTYDRIVE, '--cols', '40', '--rows', '10', '--seconds', '3', '--out', out, '--send', 'after:hello:100:X', '--', 'sh', '-c', 'printf hello; sleep 1.2; printf tail; sleep 4'],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, MERCURY_VSHOT_BUDGET_SCALE: '2' } },
  )
  const rows = driveRows(out)
  const sent = rows.find(r => typeof r.sent === 'number')
  console.log(`  scale 2: ${JSON.stringify({ paintAt: sent?.paintAt, settledAt: sent?.settledAt, stillMs: sent?.stillMs, atMs: sent?.atMs })} · rc ${res.status}`)
  check('the still window is the authored 400ms at scale 2 (a state criterion never stretches)', sent !== undefined && typeof sent.stillMs === 'number' && sent.stillMs >= PTYDRIVE_STILL_MS - 1 && sent.stillMs < PTYDRIVE_STILL_MS + 150, JSON.stringify(sent))
  check('the delay after the settle rides the profile (100ms authored → 200ms)', sent !== undefined && typeof sent.settledAt === 'number' && typeof sent.atMs === 'number' && Math.round(sent.atMs - sent.settledAt) === 200, JSON.stringify(sent))
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-ptydrive-settle-gate: ALL LAWS HOLD' : `prove-ptydrive-settle-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
