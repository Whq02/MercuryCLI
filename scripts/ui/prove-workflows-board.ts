#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scenario, cleanupScenario } from './renderScenarios.ts'
import {
  agentsDoneOf,
  phaseTone,
  workflowRollupLine,
} from '../../src/components/tasks/workflowRollup.js'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function capture(name: string, cols: number, rows: number): string {
  const gridPath = `/tmp/grid-${name}.json`
  const cfgPath = `/tmp/vshot-${name}.json`
  const cfg = { ...scenario(name, cols, rows), out: gridPath }
  try {
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(180000),
      env: { ...process.env },
    })
    if (res.status !== 0) {
      console.log(
        `  vshot failed (status ${res.status ?? 'null'}${res.signal ? ` · signal ${res.signal}` : ''}${res.error ? ` · ${String(res.error)}` : ''}):`,
        (res.stderr || '(empty stderr)').slice(0, 300),
      )
      failures++
      return ''
    }
    const parsed = JSON.parse(readFileSync(gridPath, 'utf8')) as {
      grid?: Array<Array<{ c?: string }>>
    }
    return Array.isArray(parsed.grid)
      ? parsed.grid.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n')
      : ''
  } finally {
    cleanupScenario(name)
  }
}

console.log('============================================================')
console.log(' live /workflows board — real-binary render regression guard')
console.log('============================================================')

check(
  'rollup grammar: agents · ◈ tokens · elapsed (the clock last)',
  workflowRollupLine({ agentsDone: 0, agentCount: 3, elapsedMs: 61_000, tokens: 287_300 }) ===
    '0/3 agents · ◈ 287.3k · 1m 1s',
  workflowRollupLine({ agentsDone: 0, agentCount: 3, elapsedMs: 61_000, tokens: 287_300 }),
)
check(
  'rollup grammar: honest omissions (no agents, no tokens)',
  workflowRollupLine({ agentsDone: 0, agentCount: 0, elapsedMs: 28_000, tokens: 0 }) === '28s',
  workflowRollupLine({ agentsDone: 0, agentCount: 0, elapsedMs: 28_000, tokens: 0 }),
)
check(
  'agentsDoneOf counts settled agents only',
  agentsDoneOf([{ state: 'done' }, { state: 'progress' }, { state: 'done' }]) === 2,
)
check(
  'phaseTone speaks the PhaseBlock table',
  phaseTone({ planned: false, agents: [{ state: 'done' }] }) === 'settled' &&
    phaseTone({ planned: false, agents: [{ state: 'progress' }] }) === 'active' &&
    phaseTone({ planned: false, agents: [{ state: 'error' }, { state: 'done' }] }) === 'error' &&
    phaseTone({ planned: true, agents: [] }) === 'pending',
)

const board = capture('workflows-live-past', 120, 40)
check('board is non-blank', board.replace(/\s/g, '').length > 0)
check('board titled "workflows" with a Past section', /workflows/.test(board) && /Past/.test(board), '')
check('a completed run lists from disk (restart-durable)', /substrate-carried/.test(board), '')
check('an orphaned "running" run renders STALE, not a spinner', /stale/i.test(board), '')
check(
  'the healed phase rollup reads 2/2 (1-based-era agents merged into planned)',
  /2\/2/.test(board),
  '',
)
check('phase-dot strip + settled count (●● 2/2)', /●● 2\/2/.test(board), '')
check('compact token rollup speaks ◈ (29.7k)', /◈ 29\.7k/.test(board), '')
check('settled run shows TOTAL runtime right-aligned (1m 0s)', /1m 0s/.test(board), '')
check(
  'stale run shows LAST-KNOWN runtime (heartbeat mtime − start = 1m 20s), not a growing clock',
  /1m 20s/.test(board),
  '',
)
check('side info pane carries the numbered Phases rail', /Phases/.test(board) && /1 design/.test(board) && /2 build/.test(board), '')
check('per-agent machine-head chips (✧) render in the rail', /✧/.test(board), '')
check('save control advertised on the recoverable row (S save)', /S save/.test(board), '')

const run = capture('workflows-live-run', 120, 40)
check('run view is non-blank', run.replace(/\s/g, '').length > 0)
check('phase separator names design with its rollup', /◆ 1 · design ─ 1\/1 done/.test(run), '')
check('phase separator names build with its rollup', /◆ 2 · build ─ 1\/1 done/.test(run), '')
check(
  'NO duplicate phase title (the healed off-by-one class)',
  (run.match(/· design ─/g) ?? []).length === 1,
  `found ${(run.match(/· design ─/g) ?? []).length}`,
)
check('agent lanes carry ◈ token marks', /◈/.test(run), '')
check('dossier in-row carries the dispatch prompt', /in {2}Design the \/substrate gate panel/.test(run), '')
check('dossier now-row reads settled with the tool count', /now settled · \d+ tool calls/.test(run), '')
check('dossier out-row carries the result', /out Design complete/.test(run), '')
check("dossier names the selected agent's machine head", /relay/.test(run), '')
check('save control advertised (scriptPath present)', /S save/.test(run), '')
check('inspect control advertised', /↵ inspect/.test(run), '')

const inspector = capture('workflows-live-inspector', 100, 40)
check('inspector is non-blank', inspector.replace(/\s/g, '').length > 0)
check(
  'inspector auto-loads the dispatch prompt (no extra keypress)',
  /the dispatch prompt/.test(inspector) && /substrate gate panel/.test(inspector),
  '',
)
check('inspector shows activity tool calls', /activity/.test(inspector) && /Read\(/.test(inspector), '')
check(
  'inspector shows an honest reasoning boundary',
  /reasoning/.test(inspector) && /no reasoning captured/.test(inspector),
  '',
)
check('inspector shows the returned result', /the returned result/.test(inspector) && /Design complete/.test(inspector), '')
check("inspector heads with the agent's machine head", /relay/.test(inspector), '')

const carry = capture('workflows-live-carryback', 120, 40)
check('carry-back capture is non-blank', carry.replace(/\s/g, '').length > 0)
check('carry-back returned to the board (Past section painted)', /Past/.test(carry) && /substrate-carried/.test(carry), '')
const carryLines = carry.split('\n')
check(
  'cursor carried back to the inspected row (▸ + stale-drifter on one line)',
  carryLines.some(l => l.includes('▸') && l.includes('stale-drifter')),
  carryLines.find(l => l.includes('▸'))?.trim().slice(0, 60) ?? 'no cursor line',
)
check(
  'row 0 did NOT steal the cursor back',
  !carryLines.some(l => l.includes('▸') && l.includes('substrate-carried')),
)

const arrows = capture('workflows-live-arrows', 120, 40)
check('arrows capture is non-blank', arrows.replace(/\s/g, '').length > 0)
const arrowLines = arrows.split('\n')
check(
  '↓↓↓ from empty Active lands WITHIN Past (▸ + stale-drifter on one line)',
  arrowLines.some(l => l.includes('▸') && l.includes('stale-drifter')),
  arrowLines.find(l => l.includes('▸'))?.trim().slice(0, 60) ?? 'no cursor line',
)
check(
  'the crossing passed THROUGH row 0 (cursor is not still on it)',
  !arrowLines.some(l => l.includes('▸') && l.includes('substrate-carried')),
)

{
  const run120 = capture('workflows-live-run', 120, 40)
  check('run view: dossier grows an ACTIVITY tail into the slack (act row)', /\bact\s+Read\(/.test(run120), '')
  check(
    'run view: activity tail carries the call result preview',
    run120.split('\n').some(l => /\bact\s+/.test(l) && /→/.test(l)),
    '',
  )
  const run80 = capture('workflows-live-run', 80, 40)
  check('run view @80: no horizontal overflow (footer intact)', /esc back/.test(run80))
  check('run view @80: dossier in-section WRAPS instead of clipping', /states, the component contract/.test(run80), '')

  const insp = capture('workflows-live-inspector', 120, 40)
  const inspLines = insp.split('\n')
  check(
    'inspector: section heads close with a hairline rule (level-3 framing)',
    inspLines.some(l => /in — the dispatch prompt ─{4,}/.test(l)) &&
      inspLines.some(l => /out — the returned result ─{4,}/.test(l)),
    inspLines.find(l => /dispatch prompt/.test(l))?.trim().slice(0, 70) ?? 'no in head',
  )
  check(
    'inspector: reasoning + activity heads rule too',
    inspLines.some(l => /reasoning ─{4,}/.test(l)) && inspLines.some(l => /activity — .*─{4,}/.test(l)),
    '',
  )
  check('inspector: no e-expand hint when nothing is clipped', !/e expand/.test(insp) && /esc \/ ← back/.test(insp), '')

  const long = capture('workflows-live-inspector-long', 120, 40)
  check('inspector-long: expanded via the real e key (footer reads e compact)', /e compact/.test(long), '')
  check('inspector-long: deep result lines visible after expand', /finding 8:/.test(long), '')
}

{
  const laneWordChecks = (grid: string, width: number): void => {
    const lines = grid.split('\n')
    check(`settled @${width}: paused run opened (harbor-sweep)`, /harbor-sweep/.test(grid), '')
    check(
      `settled @${width}: stranded lane reads 'stopped'`,
      lines.some(l => l.includes('sweep-south') && l.includes('· stopped')),
      lines.find(l => l.includes('sweep-south'))?.trim().slice(0, 70) ?? 'no lane',
    )
    check(
      `settled @${width}: operator-skipped lane reads 'skipped'`,
      lines.some(l => l.includes('mend-nets') && l.includes('· skipped')),
      lines.find(l => l.includes('mend-nets'))?.trim().slice(0, 70) ?? 'no lane',
    )
    check(
      `settled @${width}: neither settle lane wears the error word`,
      !lines.some(
        l => (l.includes('sweep-south') || l.includes('mend-nets')) && /\berror\b/.test(l),
      ),
      '',
    )
    check(
      `settled @${width}: no lane still claims running/queued (the stranded-word class)`,
      !lines.some(l => /sweep-south|mend-nets/.test(l) && /· (running|queued)/.test(l)),
      '',
    )
  }
  laneWordChecks(capture('workflows-live-settled', 120, 40), 120)
  laneWordChecks(capture('workflows-live-settled', 80, 40), 80)
  laneWordChecks(capture('workflows-live-settled', 150, 40), 150)
}

{
  const backoffChecks = (grid: string, width: number, wantHorizon: boolean): void => {
    const lines = grid.split('\n')
    check(`backoff @${width}: run view opened (stale-drifter)`, /stale-drifter/.test(grid), '')
    check(
      `backoff @${width}: the lane NAMES the provider wait`,
      lines.some(l => l.includes('scan') && l.includes('provider backoff')),
      lines.find(l => l.includes('scan'))?.trim().slice(0, 90) ?? 'no lane',
    )
    if (wantHorizon) {
      check(
        `backoff @${width}: retry attempt + horizon render`,
        /provider backoff · retry 2 · ~45s/.test(grid),
        '',
      )
    }
    check(`backoff @${width}: no lane claims bare 'thinking' for the wait`, !/thinking/.test(grid), '')
  }
  backoffChecks(capture('workflows-live-backoff', 120, 40), 120, true)
  backoffChecks(capture('workflows-live-backoff', 80, 40), 80, false)
}

console.log('')
if (failures > 0) {
  console.log(`RESULT: RED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: GREEN — live board + inspector paint from disk in the real binary')
