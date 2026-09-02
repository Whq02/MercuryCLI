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

console.log('── FLUX S7b tool-card lifecycle grammar (shipped artifact) ──')

const run = await runArtifactArena({
  turns: [
    { kind: 'tool_use', name: 'Bash', input: { command: 'touch lifecycle-probe.txt' }, whenModel: 'opus' },
    { kind: 'text', text: 'ok.', whenModel: 'opus' },
  ],
  sends: ['4500:hello', '5300:\\r', 'after:lifecycle-probe:1200:\\x1b'],
  seconds: 16,
  keep: true,
})

function screenAt(offsets: number[]): { atMs: number; rows: string[] }[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', ...offsets.map(String)],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
}

const boot = run.teeLines.find(l => typeof l.ts === 'number')?.ts ?? 0
const escTs = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\x1b')?.sent ?? 0
const askOffsets = [escTs - boot - 400, escTs - boot - 200, escTs - boot - 60]
const [ask400, ask200, ask60, fin] = screenAt([...askOffsets, -1])
const duringAsk = [ask400, ask200, ask60].find(s => s !== undefined && /lifecycle-probe/.test(s.rows.join('\n'))) ?? ask400
check('the ask frame and the final frame were both captured', duringAsk !== undefined && fin !== undefined, `escTs=${escTs} boot=${boot}`)
if (duringAsk === undefined || fin === undefined) {
  console.log(`❌ FLUX lifecycle-cards RED (${failures})`)
  process.exit(1)
}
const askFlat = duringAsk.rows.join('\n')
const finFlat = fin.rows.join('\n')

check('C2 permission card visible before Esc', /lifecycle-probe/.test(askFlat), askFlat.length < 200 ? 'screen empty' : 'command text not on screen')
if (!/lifecycle-probe/.test(askFlat)) {
  const keyed = duringAsk.rows.filter(r => /lifecycle|proceed|Yes|No,|Bash|touch|❯|Allow|permission|ask/i.test(r)).slice(0, 12)
  console.log(`  ── the ask frame (${duringAsk.atMs} ms): ${keyed.length} needle row(s)`)
  for (const r of keyed) console.log(`  │ ${r.trimEnd().slice(0, 118)}`)
}

const rowLine = duringAsk!.rows.find(r => r.includes('lifecycle-probe') && !r.includes('❯')) ?? ''
check('C1a no success dot while queued on the ask', !/●/.test(rowLine), JSON.stringify(rowLine.slice(0, 60)))
check('C1b no spark/read-settle on the pending row', !rowLine.includes('✶') && !rowLine.includes('◌'), JSON.stringify(rowLine.slice(0, 60)))

check('C3 denial lands the ✕ lead', finFlat.includes('✕'))

check('C4 composer idle hints returned', /[Tt]ype a prompt|↵ sends/.test(finFlat))

run.cleanup()

console.log(failures === 0 ? '✅ FLUX lifecycle-cards GREEN' : `❌ FLUX lifecycle-cards RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
