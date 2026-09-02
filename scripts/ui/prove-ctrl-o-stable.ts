#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_HOME, writeSyntheticSession, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const BIN = join(ROOT, 'dist', 'mercury.mjs')
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-ctrl-o-stable')

{
  const repl = readFileSync(join(ROOT, 'src', 'screens', 'REPL.tsx'), 'utf8')
  const fls = (repl.match(/<FullscreenLayout[\s/>]/g) ?? []).length
  const mcp = (repl.match(/<MCPConnectionManager[\s/>]/g) ?? []).length
  check('A: exactly ONE <FullscreenLayout> in REPL (no transcript twin)', fls === 1, `${fls}`)
  check('A: NO <MCPConnectionManager> in REPL (the session runner manages MCP; nothing to survive the toggle)', mcp === 0, `${mcp}`)
  check('A: the unified mode flag drives the one skeleton', repl.includes('const inVirtualTranscript'))
  const legacy = repl.slice(repl.indexOf("if (screen === 'transcript' && !inVirtualTranscript)"))
  const legacyBlock = legacy.slice(0, legacy.indexOf('return transcriptReturn;'))
  check('A: the legacy dump branch has NO FullscreenLayout/MCP of its own', !legacyBlock.includes('<FullscreenLayout') && !legacyBlock.includes('<MCPConnectionManager'))
}

const CTRL_O = String.fromCharCode(15)
const PAGE_UP = '\x1b[5~'

function run(
  tag: string,
  sends: Array<{ atTick: number; data: string }>,
  total: number,
  teeComposed = false,
): { grid: string[]; composed: string } {
  const dir = mkdtempSync(join(tmpdir(), `ctrlo-${tag}-`))
  const gridPath = join(dir, 'grid.json')
  const composed = join(dir, 'composed.jsonl')
  const cfgPath = join(dir, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID], sends, total, cols: 120, rows: 44, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(HERE, 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(90_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
      ...(teeComposed ? { INK_COMPOSED_TEE: composed } : {}),
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_TURN_RECEIPT: '0',
    },
  })
  check(`${tag}: PTY run completed`, res.status === 0, res.stderr?.slice(0, 160) ?? '')
  let grid: string[] = []
  try {
    const parsed = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c?: string }>> }
    grid = parsed.grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd())
  } catch {
  }
  let composedText = ''
  try {
    composedText = readFileSync(composed, 'utf8')
  } catch {
  }
  rmSync(dir, { recursive: true, force: true })
  return { grid, composed: composedText }
}

writeSyntheticSession('tall', SID)
const refSends = [
  { atTick: 26, data: CTRL_O },
  { atTick: 32, data: PAGE_UP },
  { atTick: 34, data: PAGE_UP },
]
const ref = run('ref', refSends, 44)

writeSyntheticSession('tall', SID)
const rtSends = [...refSends, { atTick: 40, data: CTRL_O }, { atTick: 46, data: CTRL_O }]
const rt = run('roundtrip', rtSends, 58, true)

const CENTER_X = 26
const centerRows = (g: string[]) => g.slice(1, Math.max(0, g.length - 4)).map(r => r.slice(CENTER_X).trimEnd())
const refC = centerRows(ref.grid)
const rtC = centerRows(rt.grid)
const matchAtShift = (shift: number): number => {
  let hits = 0
  let total = 0
  for (let i = 0; i < refC.length; i++) {
    const a = refC[i] ?? ''
    const b = rtC[i + shift] ?? ''
    if (a === '' && b === '') continue
    total++
    if (a === b) hits++
  }
  return total === 0 ? 0 : hits / total
}
let bestShift = 0
let bestScore = -1
for (let sft = -3; sft <= 3; sft++) {
  const score = matchAtShift(sft)
  if (score > bestScore) {
    bestScore = score
    bestShift = sft
  }
}
if (process.env.CTRLO_DEBUG) console.log(`  · best shift ${bestShift} score ${(bestScore * 100).toFixed(1)}%`)
check(
  'B: reading position survives ctrl+o out→in (center rows match within ±3-row shift)',
  ref.grid.length > 0 && bestScore >= 0.9,
  `best shift ${bestShift}, ${(bestScore * 100).toFixed(1)}% rows matched`,
)
const lastTurnMarker = 'turn 18'
check(
  'B: round-trip did NOT reset to the bottom',
  !rtC.join('\n').includes(lastTurnMarker),
  'bottom content visible after round-trip',
)

let fullDamage = 0
for (const line of rt.composed.trim().split('\n')) {
  if (!line) continue
  try {
    const p = JSON.parse(line) as { phase?: string; reason?: string }
    if (p.phase === 'full-damage' && p.reason && /removed-child|moved|scroll/.test(p.reason)) fullDamage++
  } catch {
  }
}
check('C: ≤ 14 structural full-damage frames across the whole scrolled round-trip (2 flips + 2 PageUps + chrome swaps; a per-frame damage storm would be 3-5× this)', fullDamage <= 14, `${fullDamage}`)

cleanupScenario('ctrl-o-stable')
console.log(failures === 0 ? '\n✓ prove-ctrl-o-stable: all green' : `\n✗ prove-ctrl-o-stable: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
