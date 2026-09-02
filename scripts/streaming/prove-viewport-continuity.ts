#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markEpochs, runArtifactArena, type ArenaRun } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const LINES = 66
const deltas: string[] = []
for (let i = 1; i <= LINES; i++) {
  deltas.push(`vp-line-${String(i).padStart(2, '0')} `)
  deltas.push(`flux anchor probe\n`)
}
const LAST_NEEDLE = `vp-line-${LINES}`

function screens(run: ArenaRun, offsets: number[]): { atMs: number; rows: string[] }[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', ...offsets.map(String)],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (res.status !== 0) throw new Error(`screengrab failed: ${res.stderr}`)
  return (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
}

const flat = (rows: string[]): string => rows.join('\n')

console.log('── FLUX S6 viewport anchoring + scroll continuity (shipped artifact) ──')

{
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 40, whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 14,
    probe: true,
    keep: true,
  })
  const fin = screens(run, [-1])[0]!
  check('V1 follow-bottom: last line visible at stream end', flat(fin.rows).includes(LAST_NEEDLE))
  const follows = run.probe ? markEpochs(run.probe, 'scroll:follow').length : -1
  check('V2 positional follow fired during growth', follows > 5, `${follows} follow marks`)
  check('FOLLOW scene: fixture streamed fully', run.fixture.pacedEmits.length === deltas.length)
  run.cleanup()
}

{
  const WHEEL = '\\x1b[<64;60;20M'
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas, gapMs: 40, settleDelayMs: 1500, whenModel: 'opus' }],
    sends: [
      '4500:hello',
      '5300:\\r',
      `9600:${WHEEL}`,
      `9800:${WHEEL}`,
      `10000:${WHEEL}`,
      `10200:${WHEEL}`,
    ],
    seconds: 16,
    probe: true,
    keep: true,
  })
  const boot = run.teeLines[0]?.ts ?? 0
  const wheelAtDrive = run.sendLog.filter(s =>
    Buffer.from(s.b64, 'base64').toString('utf8').includes('[<64'),
  )
  const lastWheelTs = Math.max(...wheelAtDrive.map(s => s.sent))
  const streamEnd = (run.fixture.pacedEmits.at(-1)?.at ?? 0) - boot
  const SETTLE_AT = streamEnd + 1500
  const [beforeSettle, afterSettle, fin] = screens(run, [
    SETTLE_AT - 200,
    SETTLE_AT + 250,
    -1,
  ])
  check('SCROLL scene: wheels delivered', wheelAtDrive.length === 4, `${wheelAtDrive.length}`)

  const unsticks = run.probe
    ? markEpochs(run.probe, 'scroll:unstick').filter(t => t >= lastWheelTs - 1500).length
    : -1
  check('V3 unstick intent recorded at wheel time', unsticks > 0, `${unsticks} marks`)
  check('V4 not dragged back: last line NOT visible at end', !flat(fin!.rows).includes(LAST_NEEDLE))
  const visLines = (rows: string[]): string =>
    rows
      .map(r => (r.match(/vp-line-(\d+)/) ?? [])[1])
      .filter(Boolean)
      .join(',')
  check(
    'V5a scrolled-to region survives the settle swap',
    visLines(beforeSettle!.rows).length > 0 &&
      visLines(beforeSettle!.rows) === visLines(afterSettle!.rows),
    `settle−200ms=[${visLines(beforeSettle!.rows)}] settle+250ms=[${visLines(afterSettle!.rows)}]`,
  )
  const finFlat = flat(fin!.rows)
  check(
    'V5b the final view still holds the scrolled-to region (the settle never yanks the reader)',
    visLines(fin!.rows).length > 0 && visLines(fin!.rows) === visLines(afterSettle!.rows),
    `settle+250ms=[${visLines(afterSettle!.rows)}] final=[${visLines(fin!.rows)}]`,
  )
  check(
    'V5c the way back is offered on the final screen (the jump pill stands)',
    /\[ (\d+ new messages?|back to the bottom) · alt\+↓ \]/.test(finFlat),
    `pill-shaped rows: ${fin!.rows.filter(r => /new message|back to the bottom|alt\+/.test(r)).map(r => r.trim()).join(' | ') || 'none'}`,
  )
  const restick = run.probe
    ? markEpochs(run.probe, 'scroll:stick').filter(t => t > lastWheelTs).length +
      markEpochs(run.probe, 'scroll:restick').filter(t => t > lastWheelTs).length
    : -1
  check('V6 no re-stick behind the user', restick === 0, `${restick} stick marks after wheel`)
  run.cleanup()
}

console.log(failures === 0 ? '✅ FLUX viewport-continuity GREEN' : `❌ FLUX viewport-continuity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
