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

console.log('── FLUX S10 polish sweep (shipped artifact) ──')

const run = await runArtifactArena({
  seedCwd: { 'polish-probe.txt': 'one line of probe content\n' },
  turns: cwd => [
    { kind: 'tool_use', name: 'Read', input: { file_path: `${cwd}/polish-probe.txt` }, preText: 'reading the probe file now. ', whenModel: 'opus' },
    { kind: 'text', text: 'settled prose after the tool.', whenModel: 'opus' },
  ],
  sends: ['4500:hello', '5300:\\r', '10500:Λ', '11000:Θ'],
  seconds: 13,
  keep: true,
  extraEnv: { MERCURY_LIVE_GLYPHS: '1' },
})

const res = spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', '-1'],
  { encoding: 'utf8', timeout: 60_000 },
)
const fin = (
  JSON.parse(res.stdout) as {
    screens: {
      rows: string[]
      cursor?: { x: number; y: number; hidden: boolean }
      reverseCells?: [number, number][]
    }[]
  }
).screens[0]!
const flat = fin.rows.join('\n')

check('P3a settled prose painted', flat.includes('settled prose after the tool.'))
check('P3b resolved read wears ◌', flat.includes('◌'))
check('P3c composer usable', /type a prompt|↵ sends|\? for shortcuts/.test(flat) || flat.includes('ΛΘ'))

const sweepRows = fin.rows.filter(r => !r.includes('← back') && !r.includes('esc interrupts'))
check('P1 no ◐◓◑◒ running family after settle (outside the status row\'s resting glyph)', !/[◐◓◑◒]/.test(sweepRows.join('\n')))

const caretDrawn = (fin.reverseCells ?? []).some(([, y]) => fin.cursor !== undefined && Math.abs(y - fin.cursor.y) <= 1)
check(
  'P2a a caret is visible at settle (hardware cursor OR drawn inverse cell)',
  (fin.cursor !== undefined && !fin.cursor.hidden) || caretDrawn,
  `cursor=${JSON.stringify(fin.cursor)} reverseNearCursor=${caretDrawn}`,
)
const composerRowIdx = fin.rows.findIndex(r => r.includes('ΛΘ'))
check('P2b post-settle glyphs echoed', composerRowIdx >= 0)
check(
  'P2c cursor sits on the composer row',
  fin.cursor !== undefined && composerRowIdx >= 0 && Math.abs(fin.cursor.y - composerRowIdx) <= 1,
  `cursor.y=${fin.cursor?.y} composerRow=${composerRowIdx}`,
)
run.cleanup()

console.log(failures === 0 ? '✅ FLUX polish-sweep GREEN' : `❌ FLUX polish-sweep RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
