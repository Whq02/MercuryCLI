#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

type Screen = { atMs: number; rows: string[]; cursor?: { x: number; y: number; hidden: boolean }; reverseCells?: [number, number][] }
const stamps = readFileSync(run.paths.drive, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => (JSON.parse(line) as { ts?: number }).ts)
  .filter((ts): ts is number => typeof ts === 'number')
const endMs = stamps.length > 0 ? stamps[stamps.length - 1]! - stamps[0]! : 0
const BLINK_PERIOD_MS = 1200
const tailOffsets = Array.from({ length: BLINK_PERIOD_MS / 100 + 1 }, (_, i) => Math.max(0, endMs - BLINK_PERIOD_MS + i * 100))
const res = spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', ...tailOffsets.map(String), '-1'],
  { encoding: 'utf8', timeout: 60_000 },
)
const screens = (JSON.parse(res.stdout) as { screens: Screen[] }).screens
const fin = screens.find(s => s.atMs === -1)!
const flat = fin.rows.join('\n')

check('P3a settled prose painted', flat.includes('settled prose after the tool.'), `the final screen must show the text turn after the Read tool; the last rows were ${JSON.stringify(fin.rows.slice(-12))}; the arena run may have ended early, so read the drive capture at ${run.paths.drive}`)
check('P3b the resolved Read row starts directly with Read and no pending mark', fin.rows.some(r => /│\s+Read\b/.test(r) && !r.includes('◌')), `the resolved Read row must start with Read and no pending mark; rows with Read: ${JSON.stringify(fin.rows.filter(r => r.includes('Read')))}`)
check('P3c composer usable', /type a prompt|↵ sends|\? for shortcuts/.test(flat) || flat.includes('ΛΘ'), 'the composer must show its placeholder or the typed glyphs on the final screen; the typed text may not have reached the composer')

const sweepRows = fin.rows.filter(r => !r.includes('← back') && !r.includes('esc interrupts'))
check('P1 no ◐◓◑◒ running family after settle (outside the status row\'s resting glyph)', !/[◐◓◑◒]/.test(sweepRows.join('\n')), `a running spinner glyph stays on screen after the turn settled; rows: ${JSON.stringify(sweepRows.filter(r => /[◐◓◑◒]/.test(r)))}`)

const caretOn = (s: Screen): boolean =>
  (s.cursor !== undefined && !s.cursor.hidden) ||
  (s.reverseCells ?? []).some(([, y]) => fin.cursor !== undefined && Math.abs(y - fin.cursor.y) <= 1)
const blinkFrames = screens.filter(s => s.atMs >= 0)
const caretFrames = blinkFrames.filter(caretOn).length
check(
  'P2a a caret is visible at settle (hardware cursor OR drawn inverse cell, on some frame of the last blink period)',
  caretOn(fin) || caretFrames > 0,
  `cursor=${JSON.stringify(fin.cursor)} · caret on ${caretFrames} of ${blinkFrames.length} frames over the last ${BLINK_PERIOD_MS} ms · phases=${blinkFrames.map(s => (caretOn(s) ? '1' : '0')).join('')}`,
)
const composerRowIdx = fin.rows.findIndex(r => r.includes('ΛΘ'))
check('P2b post-settle glyphs echoed', composerRowIdx >= 0, 'the typed glyphs (the two Greek letters sent at 10500 and 11000 ms) are not on any row of the final screen; the composer did not echo input after the turn settled')
check(
  'P2c cursor sits on the composer row',
  fin.cursor !== undefined && composerRowIdx >= 0 && Math.abs(fin.cursor.y - composerRowIdx) <= 1,
  `cursor.y=${fin.cursor?.y} composerRow=${composerRowIdx}`,
)
run.cleanup()

console.log(failures === 0 ? '✅ FLUX polish-sweep GREEN' : `❌ FLUX polish-sweep RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
