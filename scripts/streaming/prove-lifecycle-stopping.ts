#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runArtifactArena } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── FLUX S7 honest stopping state (shipped artifact) ──')

const run = await runArtifactArena({
  turns: [{ kind: 'hang', deltas: ['thinking about it ', 'very carefully ', 'and slowly '], whenModel: 'opus' }],
  sends: ['4500:hello', '5300:\\r', 'after:thinking about it:800:\\x1b'],
  seconds: 15,
  probe: true,
  keep: true,
})

const escSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\x1b')
check('Esc delivered', escSend !== undefined, 'the arena never sent the Esc byte; check the \'after:thinking about it:800:\\x1b\' send in this file: the scripted turn must paint "thinking about it" for it to fire (see run.sendLog and run.outcome.unfired)')
const escTs = escSend?.sent ?? 0

let interruptedPaintTs: number | undefined
{
  const strip = (s: string): string =>
    s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
  let tail = ''
  for (const t of run.teeLines) {
    if (t.ts < escTs) continue
    tail += strip(t.content ?? '')
    if (/[Ii]nterrupted/.test(tail)) {
      interruptedPaintTs = t.ts
      break
    }
    if (tail.length > 8192) tail = tail.slice(-4096)
  }
}
check(
  'L1 the interrupt drain settles fast (Interrupted paints ≤2s after Esc)',
  interruptedPaintTs !== undefined && interruptedPaintTs - escTs < 2000,
  (interruptedPaintTs !== undefined ? `${Math.round(interruptedPaintTs - escTs)}ms after Esc` : 'never painted') + ' · the interrupt path after Esc must settle and paint the Interrupted row within 2s; look at the interrupt handling the Chat screen uses (interruptingKey in src/screen/chat/useChatFocusedSeat.ts) and what the tee capture at run.paths.tee shows after Esc',
)

const stoppingPaints = run.teeLines.filter(
  t => t.ts >= escTs && (t.content ?? '').includes('stopping'),
)
check('L3 fast drain: no stopping flash painted', stoppingPaints.length === 0, `${stoppingPaints.length} writes · a drain that settles within the fast window must not paint the word stopping; isStopping (src/screen/chat/useChatFocusedSeat.ts) feeds spinnerSlotReserved in src/screen/chat/useChatStatus.tsx, so check what delays the status strip from leaving the stopping state`)

const res = spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', '-1'],
  { encoding: 'utf8', timeout: 60_000 },
)
const fin = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!
const flat = fin.rows.join('\n')
check('L4a partial text preserved', flat.includes('thinking about it'), 'the streamed partial text must stay on screen after the interrupt; the settled screen was grabbed from run.paths.drive with screengrab.py')
check('L4b Interrupted marker painted', /[Ii]nterrupted/.test(flat), 'the settled screen has no Interrupted marker; the interrupted turn must leave an Interrupted row behind')
check('L4c no stopping on the settled screen', !flat.includes('stopping'), 'the word stopping is still on the settled screen; the status strip must return to idle once the interrupt drains (isStopping in src/screen/chat/useChatFocusedSeat.ts)')
check('L4d composer idle hints returned', /[Tt]ype a prompt|↵ sends/.test(flat), 'the composer did not return to its idle hints ("type a prompt" or "↵ sends") after the interrupt settled')
run.cleanup()

console.log(failures === 0 ? '✅ FLUX lifecycle-stopping GREEN' : `❌ FLUX lifecycle-stopping RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
