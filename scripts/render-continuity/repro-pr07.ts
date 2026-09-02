#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/repro-pr07.ts — (PO-12 scope) reproduction:
//  draft text across main -> agent A -> agent B -> main switches while both
//  agents stream.
//
//  One arena: a single main turn spawns TWO background agents in one
//  paced_tool_use turn (sidesteps the fixture FIFO race; both agents run
//  IDENTICAL paced scripts so their arrival order is harmless). Then:
//
//    · type a MAIN draft (no submit)
//    · drill agent at CREW row 6 — record what the composer now holds
//    · type more characters in the agent view
//    · drill agent at CREW row 7 — record the composer
//    · esc back — record the composer in main
//
//  The receipt records the draft's journey. Per-target drafts do not exist
//  at unfixed HEAD (teammateViewHelpers release() clears view state; the
//  composer is one shared input) — whichever shape (leak everywhere or loss
//  on switch) is observed is the PO-12 before-state.
//
//  Exit 0 = conclusive. Exit 2 = navigation drifted.
// ============================================================================
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

const agentInput = (name: string): Record<string, unknown> => ({
  description: name,
  prompt: 'Work quietly.',
  subagent_type: 'general-purpose',
  run_in_background: true,
})

// Identical scripts for both agents: the arrival race between their first
// calls cannot mis-assign content.
const agentPaced: ScriptedTurn = {
  kind: 'paced',
  deltas: Array.from({ length: 20 }, (_, i) => `working segment ${i + 1}. `),
  gapMs: 700,
}

const turns: ScriptedTurn[] = [
  {
    kind: 'paced_tool_use',
    preDeltas: ['Spawning both probes. '],
    gapMs: 200,
    tools: [
      { name: 'Agent', input: agentInput('alpha probe') },
      { name: 'Agent', input: agentInput('beta probe') },
    ],
  },
  agentPaced,
  agentPaced,
  { kind: 'text', text: 'Both launched.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare2.' },
  { kind: 'text', text: 'Spare3.' },
]

const run = await runPulseArena({
  turns,
  sends: [
    '2000:\\r',
    '6000:spawn both probes\\r',
    '11000:draft-main-text', // typed, NOT submitted
    `13000:${sgrClick(10, 6)}`,
    `13700:${sgrClick(10, 6)}`, // drill CREW row 6
    '15200:-plus-agent', // typed in the agent view
    `16700:${sgrClick(10, 7)}`,
    `17400:${sgrClick(10, 7)}`, // drill CREW row 7
    `19000:${ESC}`, // back toward main
  ],
  seconds: 24,
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
    '12800', // main view, draft typed
    '14600', // agent A view, post-drill
    '16400', // agent A view, extra chars typed
    '18300', // agent B view
    '20200', // after esc
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

// The composer content: the last row whose text (after any box border `│`)
// starts with the prompt glyph ❯. Main view wraps the composer in a bordered
// box (`│❯ …`); the agent view renders it borderless (`❯ …`) — that very
// difference is a D3 grammar observation, so both shapes are matched.
const composer = (f: { rows: string[] }): string => {
  const rows = f.rows.filter(r => {
    const t = r.trimStart()
    return t.startsWith('❯') || t.startsWith('│❯')
  })
  return rows.length ? rows[rows.length - 1].trim() : '(no composer row)'
}
const viewedTarget = (f: { rows: string[] }): string => {
  const rule = f.rows.find(r => /─ (alpha|beta) probe ─/.test(r))
  if (rule) return /alpha/.test(rule) ? 'alpha probe' : 'beta probe'
  return f.rows.some(r => r.includes('viewing')) ? 'an agent (unnamed rule)' : 'main'
}

const preDrill = frame(12800)
const crewRows = [6, 7].map(n => preDrill.rows[n - 1]?.slice(0, 24).trim())
if (!crewRows.some(r => r?.includes('pro'))) {
  console.error(`INCONCLUSIVE: CREW rows 6/7 are ${JSON.stringify(crewRows)}`)
  console.error(preDrill.rows.filter(r => r.trim()).join('\n'))
  process.exit(2)
}

const lines: string[] = []
const log = (s: string): void => {
  lines.push(s)
  console.log(s)
}

log('── PR-07 (PO-12) draft journey across main/agent/agent/main ──')
log(`CREW rows 6/7 at drill time: ${JSON.stringify(crewRows)}`)
log('')
for (const [atMs, label] of [
  [12800, 'main, after typing "draft-main-text"'],
  [14600, 'after drilling CREW row 6'],
  [16400, 'after typing "-plus-agent" in that view'],
  [18300, 'after drilling CREW row 7'],
  [20200, 'after esc'],
  [-1, 'final'],
] as [number, string][]) {
  const f = frame(atMs)
  log(`@${String(atMs).padStart(5)} ${label}:`)
  log(`        viewed target: ${viewedTarget(f)}`)
  log(`        composer:      ${composer(f).slice(0, 80)}`)
}

for (const s of screens) {
  lines.push(`\n════ screen @${s.atMs}ms ════`)
  lines.push(s.rows.filter(r => r.trim() !== '').join('\n'))
}

mkdirSync(RECEIPTS, { recursive: true })
writeFileSync(join(RECEIPTS, 'pr07-head-6fe78a3d.txt'), lines.join('\n'))
console.log('\nreceipt: scripts/render-continuity/receipts/pr07-head-6fe78a3d.txt')
run.cleanup()
process.exit(0)
