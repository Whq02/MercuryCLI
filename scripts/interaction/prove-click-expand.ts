#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DUNE_FAINT } from '../../src/screen/theme/mercuryPalette.ts'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}

type Cell = { c: string; bg?: string }
type Grid = { grid: Cell[][] }

function dumpFrame(label: string, lines: string[]): void {
  console.log(`      ┌ ${label}`)
  lines.forEach((line, index) => {
    const row = line.trimEnd()
    if (row !== '') console.log(`      │ ${String(index).padStart(2, ' ')} ${row}`)
  })
  console.log('      └')
}

const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const SETTLED = { minTick: 10, awaitSettleTicks: 4, requireAwait: true } as const
const clickOn = (needle: string, atTick: number): Record<string, unknown> => ({
  targetText: needle,
  targetDx: 2,
  awaitText: needle,
  atTick,
  data: CLICK,
  ...SETTLED,
})

function capture(
  tag: string,
  sends: Array<Record<string, unknown>>,
  total: number,
  extra: Record<string, unknown> = {},
): { lines: string[]; grid: Cell[][] } | null {
  const cfg = scenario('click-expand', 80, 50) as Record<string, unknown>
  cfg['sends'] = sends
  cfg['total'] = total
  Object.assign(cfg, extra)
  const gridPath = `${tmpdir()}/click-expand-${tag}-${process.pid}.json`
  const cfgPath = `${tmpdir()}/click-expand-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '', 'the vshot.py capture of the click-expand scenario (scripts/ui/renderScenarios.ts) exited non-zero; run scripts/ui/vshot.py on the config it printed and read its stderr')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  return { lines: grid.map(r => r.map(c => c.c).join('')), grid }
}

console.log('============================================================')
console.log(' click-to-toggle — collapsed tool/agent results (disclosure)')
console.log('============================================================')


const base = capture('base', [], 70)
let agentY = -1
let globY = -1
let errY = -1
if (base) {
  const rowOf = (needle: string): number => base.lines.findIndex(l => l.includes(needle))
  agentY = rowOf('Done (3 tool uses')
  globY = rowOf('Searched for 1 pattern')
  errY = rowOf('Error: ENOENT: no such file or directory')
  check('baseline: agent Done row present', agentY >= 0, '', 'the click-expand scenario in scripts/ui/renderScenarios.ts must paint an agent row reading Done (3 tool uses; check the synthetic session it writes and how the agent row renders')
  if (agentY < 0) dumpFrame('baseline frame — the agent Done row is absent', base.lines)
  check('baseline: agent report HIDDEN', rowOf('REPORT-LINE') === -1, '', 'a collapsed agent result must not show its report; see isItemClickable and the expansion state in src/screen/messages-list/useRowExpansion.ts')
  check(
    'baseline: agent row carries the ⌄ cue',
    agentY >= 0 && (base.lines[agentY]!.includes('⌄') || (base.lines[agentY + 1] ?? '').includes('⌄')),
    '',
    'a collapsed agent row must carry the ⌄ cue on its Done row or the row below it; see hiddenAgentToolUses in src/tools/crewmate/rows.tsx',
  )
  check('baseline: glob group collapsed', globY >= 0 && rowOf('GlobTool/prompt.ts') === -1, '', 'the Searched for 1 pattern group must paint collapsed with its file list hidden until clicked')
  check(
    'baseline: Edit says its first error clause with stack frames hidden',
    errY >= 0 && rowOf('+3 stack frames') === -1 && rowOf('at Object.openSync') === -1 && rowOf('The target file could not be read') === -1,
    '',
    'a collapsed tool error must show only its first clause and keep the +3 stack frames fold and the raw frames hidden; see isItemClickable in src/screen/messages-list/useRowExpansion.ts',
  )
}

if (base && agentY >= 0) {
  const t = capture(
    'toggle',
    [
      clickOn('Done (3 tool uses', 110),
      clickOn('REPORT-LINE', 150),
    ],
    170,
    { stableTicks: 4 },
  )
  if (t) {
    const rowOf = (needle: string): number => t.lines.findIndex(l => l.includes(needle))
    check('toggle: agent report hidden again after 2nd click', rowOf('REPORT-LINE') === -1, '', 'the second click on the open agent report must collapse it again; see toggleExpandedRow in src/screen/messages/transcriptMemory.ts')
    const doneY = rowOf('Done (3 tool uses')
    check('toggle: agent Done row back on screen', doneY >= 0, '', 'after the collapse the Done (3 tool uses row must be painted again; see src/screen/messages-list/useRowExpansion.ts')
    check(
      'toggle: the ⌄ cue is back (honest fold marker)',
      doneY >= 0 && ((t.lines[doneY] ?? '').includes('⌄') || (t.lines[doneY + 1] ?? '').includes('⌄')),
      '',
      'the collapsed agent row must show the ⌄ cue again after the toggle; see src/tools/crewmate/rows.tsx and src/screen/messages-list/useRowExpansion.ts',
    )
  }
} else {
  check('toggle leg ran', false, 'baseline rows missing', 'fix the baseline checks above first; the agent Done row was not found in the click-expand scenario frame')
}

if (base && globY >= 0 && errY >= 0) {
  const e = capture(
    'grow',
    [
      clickOn('Searched for 1 pattern', 110),
      { ...clickOn('Error: ENOENT: no such file or directory', 150), awaitText: 'GlobTool/prompt.ts' },
    ],
    170,
    { stableTicks: 4 },
  )
  if (e) {
    const rowOf = (needle: string): number => e.lines.findIndex(l => l.includes(needle))
    const fileRow = rowOf('GlobTool/prompt.ts')
    check('glob click: file list revealed', fileRow >= 0 && rowOf('GlobTool.ts') >= 0, '', 'a click on the Searched for 1 pattern row must expand its file list; see isItemClickable and toggleExpandedRow wiring in src/screen/messages-list/useRowExpansion.ts')
    check(
      'glob click: expanded block wears the DUNE_FAINT bg',
      fileRow >= 0 &&
        e.grid[fileRow]!.some(c => c.bg?.toLowerCase() === DUNE_FAINT.slice(1).toLowerCase()),
      '',
      'the expanded block must paint DUNE_FAINT (src/screen/theme/mercuryPalette.ts) as its background on the revealed rows',
    )
    check('error click: raw stack frames revealed', rowOf('at Object.openSync') >= 0, '', 'a click on the collapsed error row must reveal its raw stack frames; see isItemClickable in src/screen/messages-list/useRowExpansion.ts')
    check('error click: fold row gone', rowOf('+3 stack frames') === -1, '', 'once the error is expanded the +3 stack frames fold row must no longer be painted')
  }
} else {
  check('grow leg ran', false, 'baseline rows missing', 'fix the baseline checks above first; the glob or error row was not found in the click-expand scenario frame')
}

cleanupScenario('click-expand')

{
  const cfg = scenario('tool-lifecycle', 120, 50)
  const gridPath = `${tmpdir()}/tool-lifecycle-${process.pid}.json`
  const cfgPath = `${tmpdir()}/tool-lifecycle-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  cleanupScenario('tool-lifecycle')
  if (res.status !== 0) {
    check('lifecycle: PTY capture ran', false, res.stderr?.slice(0, 200) ?? '', 'the vshot.py capture of the tool-lifecycle scenario (scripts/ui/renderScenarios.ts) exited non-zero; run scripts/ui/vshot.py on the config it printed and read its stderr')
  } else {
    const lines = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid.map(r =>
      r.map(c => c.c).join(''),
    )
    const editRows = lines.filter(l => l.includes('lifecycle-demo.txt'))
    check('lifecycle: ONE visible card for the resolved Edit id', editRows.length >= 1 && new Set(editRows.map(l => l.trim())).size <= 2, `rows=${editRows.length}`, 'a resolved Edit tool id must paint one card, not one per event; the tool-lifecycle scenario in scripts/ui/renderScenarios.ts shows the session it replays')
    const metaRows = lines.filter(l => l.includes('· +1/-1'))
    check('lifecycle: the settled ± meta rides the header EXACTLY once', metaRows.length === 1, `rows=${metaRows.length}: ${metaRows.map(l => l.trim()).join(' | ')}`, 'the settled +1/-1 meta must appear on the Edit header once and not again in a second row; look at how the Edit header is rendered in src/tools/FileEditTool')
    if (editRows.length === 0 || metaRows.length !== 1) dumpFrame('lifecycle frame — the Edit header is absent', lines)
    check(
      'lifecycle: the ± lane did NOT suppress the diff card (hunks still paint)',
      lines.some(l => l.includes('-alpha')) && lines.some(l => l.includes('+omega')),
      '',
      'the diff hunks (-alpha and +omega) must still paint under the Edit header; the settled meta must not replace the diff card',
    )
    check(
      'lifecycle: the Bash its run left open does not stand as a queued card once the window has opened on the record (nothing waits)',
      !lines.some(l => l.includes('waiting…')),
      lines.filter(l => l.includes('sleep 999') || l.includes('waiting')).map(l => l.trim()).join(' | '),
      'a Bash left open in the replayed record must settle into a Ran row, not stay as a waiting card; the tool-lifecycle scenario is in scripts/ui/renderScenarios.ts',
    )
    check(
      'lifecycle: it stands answered, as a settled "Ran" row',
      lines.some(l => /Ran \d+ bash command/.test(l)),
      lines.filter(l => /bash command|sleep 999/.test(l)).map(l => l.trim()).join(' | ') || '(no such row painted)',
      'the open Bash must show as a settled Ran N bash command row once the record is loaded',
    )
  }
}


{
  const run = (tag: string, sends: Array<Record<string, unknown>>, total: number): string[] | null => {
    const cfg = { ...scenario('two-bash-click', 80, 40) } as Record<string, unknown>
    cfg['sends'] = sends
    cfg['total'] = total
    const gridPath = `${tmpdir()}/click-expand-twobash-${tag}-${process.pid}.json`
    const cfgPath = `${tmpdir()}/click-expand-twobash-${tag}-cfg-${process.pid}.json`
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
    const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
      },
    })
    if (res.status !== 0) return null
    const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
    return grid.map(r => r.map(c => c.c).join(''))
  }
  const bashRows = (lines: string[]): string => lines.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | ')
  const twoBase = run('base', [], 90)
  const rows = twoBase
    ? twoBase.map((l, i) => (/bash command/.test(l) ? i : -1)).filter(i => i >= 0)
    : []
  check('two-bash baseline shows BOTH collapsed rows', rows.length === 2, `rows=${JSON.stringify(rows)}`, 'the two-bash-click scenario in scripts/ui/renderScenarios.ts must paint exactly two collapsed bash command rows; a null capture means vshot.py exited non-zero')
  if (rows.length === 2) {
    const afterTop = run('top', [{ ...clickOn('bash command', 110), targetDx: 0 }], 130)
    check(
      'clicking the FURTHER-UP row expands it (echo hi revealed)',
      afterTop !== null && afterTop.some(l => l.includes('Bash echo hi')),
      afterTop === null ? 'capture failed' : bashRows(afterTop),
      'a click on the upper bash command row must expand it; see isItemClickable in src/screen/messages-list/useRowExpansion.ts',
    )
    const afterBot = run(
      'bottom',
      [
        { ...clickOn('bash command', 110), targetDx: 0 },
        { ...clickOn('bash command', 150), targetDx: 0, awaitText: 'Bash echo hi' },
      ],
      170,
    )
    check(
      'clicking the newest row expands it (shasum revealed)',
      afterBot !== null && afterBot.some(l => l.includes('shasum -a 256')),
      afterBot === null ? 'capture failed' : bashRows(afterBot),
      'a click on the newest bash command row must expand it while the upper one is open; see isItemClickable in src/screen/messages-list/useRowExpansion.ts',
    )
    const jitter = run(
      'jitter',
      [
        { ...clickOn('bash command', 110), targetDx: 0, data: '\x1b[<0;{X};{Y}M' },
        { targetText: 'bash command', targetDx: 1, afterPrevTicks: 1, data: '\x1b[<32;{X};{Y}M\x1b[<0;{X};{Y}m' },
      ],
      130,
    )
    check(
      'a one-cell drift click still toggles (the slop law)',
      jitter !== null && jitter.some(l => l.includes('Bash echo hi')),
      jitter === null ? 'capture failed' : bashRows(jitter),
      'a press and release one cell apart must still toggle the row; see the click handling that calls toggleExpandedRow from src/screen/messages/transcriptMemory.ts',
    )
  }
}

console.log()
if (failures) {
  console.log(`❌ click-expand proof: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ click-expand proof green')
