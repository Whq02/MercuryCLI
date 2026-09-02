#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPulseArena } from '../pulse/lib/pulseArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const RECEIPTS = join(HERE, 'receipts')

const ESC = String.fromCharCode(27)
const sgrClick = (col: number, row: number): string =>
  `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`
const CREW_ROW = 6
const CREW_COL = 10

const turns: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'Agent',
    input: {
      description: 'poise probe',
      prompt: 'Count to three slowly.',
      subagent_type: 'general-purpose',
      run_in_background: true,
    },
    preText: 'Spawning the probe agent.',
  },
  { kind: 'paced', deltas: Array.from({ length: 9 }, (_, i) => `count ${i + 1}. `), gapMs: 600 },
  { kind: 'text', text: 'Probe launched.' },
  { kind: 'text', text: 'Settled.' },
  { kind: 'text', text: 'Complete.' },
  { kind: 'text', text: 'Spare.' },
]

const run = await runPulseArena({
  turns,
  sends: [
    '2000:\\r',
    '6000:spawn the probe\\r',
    `8200:${sgrClick(CREW_COL, CREW_ROW)}`,
    `8900:${sgrClick(CREW_COL, CREW_ROW)}`,
    `16500:${ESC}`,
  ],
  seconds: 20,
  cols: 120,
  rows: 40,
  keep: true,
})

const grab = spawnSync(
  '/usr/bin/python3',
  [
    SCREENGRAB,
    run.paths.drive,
    '120',
    '40',
    '8000',
    '9600',
    '15500',
    '17300',
    '-1',
  ],
  { encoding: 'utf8' },
)
if (grab.status !== 0) {
  console.error(`screengrab failed: ${grab.stderr}`)
  process.exit(2)
}
const { screens } = JSON.parse(grab.stdout) as { screens: { atMs: number; rows: string[] }[] }
const frame = (atMs: number): { atMs: number; rows: string[] } => {
  const f = screens.find(s => s.atMs === atMs)
  if (!f) throw new Error(`no frame @${atMs}`)
  return f
}

const pre = frame(8000)
const crewIdx = pre.rows.findIndex(r => r.includes('poise pro'))
if (crewIdx + 1 !== CREW_ROW) {
  console.error(`INCONCLUSIVE: CREW row at ${crewIdx + 1}, clicked ${CREW_ROW}`)
  process.exit(2)
}

const running = frame(9600)
if (!running.rows.some(r => r.includes('viewing'))) {
  console.error('INCONCLUSIVE: drill did not enter the agent view')
  console.error(running.rows.filter(r => r.trim()).join('\n'))
  process.exit(2)
}

const completed = frame(15500)
const afterEsc = frame(17300)

const lines: string[] = []
const log = (s: string): void => {
  lines.push(s)
  console.log(s)
}
const has = (f: { rows: string[] }, needle: string | RegExp): boolean =>
  f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))

log('── PR-03/PR-06 (D3/D4) local-agent view states + return paths ──')
log('')
log('RUNNING agent view (drilled via CREW rail):')
log(`  "Viewing @" header row present:            ${has(running, /Viewing @/i)}`)
log(`  thin \`── poise probe ──\` target rule:      ${has(running, /─ poise probe ─/)}`)
log(`  breadcrumb "Main ‹" present:               ${has(running, /Main ‹/)}`)
log(`  "esc main" return hint present:            ${has(running, /esc main/i)}`)
log(`  footer "↓ manage" affordance:              ${has(running, /↓ manage/)}`)
log(`  CREW row state:                            ${running.rows.find(r => r.includes('poise pro'))?.trim().slice(0, 46)}`)
log('')
log('COMPLETED agent view (view held through completion):')
log(`  still attached (viewing marker):           ${has(completed, 'viewing')}`)
log(`  "Viewing @" header row present:            ${has(completed, /Viewing @/i)}`)
log(`  footer "↓ manage" affordance:              ${has(completed, /↓ manage/)}`)
log(`  footer fallback hints:                     ${completed.rows[completed.rows.length - 1]?.trim().slice(0, 60)}`)
log('')
log('CREW main-root (D4) across all frames:')
const railRows = [...new Set(screens.flatMap(f => f.rows.map(r => r.slice(0, 24).trim()).filter(Boolean)))]
log(`  distinct rail row texts seen: ${railRows.join(' | ')}`)
log(`  any MAIN/root/team-lead row in CREW:       ${railRows.some(r => /main|mercury|lead|root/i.test(r) && !/no open|no notes/.test(r))}`)
log('')
log('esc from the COMPLETED view:')
log(`  back on main transcript (viewing gone):    ${!has(afterEsc, 'viewing')}`)
log(`  main transcript rows visible again:        ${has(afterEsc, 'spawn the probe')}`)
log(`  agent CREW row after esc:                  ${afterEsc.rows.find(r => r.includes('poise pro'))?.trim().slice(0, 46)}`)

for (const s of screens) {
  lines.push(`\n════ screen @${s.atMs}ms ════`)
  lines.push(s.rows.filter(r => r.trim() !== '').join('\n'))
}

mkdirSync(RECEIPTS, { recursive: true })
writeFileSync(join(RECEIPTS, 'pr03-pr06-head-6fe78a3d.txt'), lines.join('\n'))
console.log('\nreceipt: scripts/render-continuity/receipts/pr03-pr06-head-6fe78a3d.txt')
run.cleanup()
process.exit(0)
