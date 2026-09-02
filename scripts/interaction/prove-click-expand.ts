#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DUNE_FAINT } from '../../src/components/mercuryPalette.ts'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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

type Click = { x: number; y: number; atTick: number } & Record<string, unknown>

function capture(
  tag: string,
  clicks: Click[],
  total: number,
  extra: Record<string, unknown> = {},
): { lines: string[]; grid: Cell[][] } | null {
  const cfg = scenario('click-expand', 80, 40) as Record<string, unknown>
  cfg['sends'] = clicks.map(({ x, y, ...schedule }) => ({
    ...schedule,
    data: `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`,
  }))
  cfg['total'] = total
  Object.assign(cfg, extra)
  const gridPath = `/tmp/click-expand-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/click-expand-${tag}-cfg-${process.pid}.json`
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
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  return { lines: grid.map(r => r.map(c => c.c).join('')), grid }
}

console.log('============================================================')
console.log(' click-to-toggle — collapsed tool/agent results (disclosure)')
console.log('============================================================')

const src = (p: string) => readFileSync(p, 'utf8')
check(
  'AgentTool gates click-expand (isResultTruncated wired)',
  src('src/tools/AgentTool/AgentTool.tsx').includes('isResultTruncated,') &&
    src('src/tools/AgentTool/UI.tsx').includes('export function isResultTruncated'),
)
check(
  'AgentTool verbose reveals the report (not transcript-only)',
  src('src/tools/AgentTool/UI.tsx').includes('(isTranscriptMode || verbose) && content'),
)
check(
  'Grep + Glob + TaskOutput gate click-expand',
  src('src/tools/GrepTool/GrepTool.ts').includes('isResultTruncated,') &&
    src('src/tools/GlobTool/GlobTool.ts').includes('isResultTruncated,') &&
    src('src/tools/TaskOutputTool/TaskOutputTool.tsx').includes('isResultTruncated('),
)
check(
  'fork Glob renderer honors verbose (file list branch)',
  src('src/tools/GlobTool/UI.tsx').includes('opts.verbose && filenames.length > 0'),
)
check(
  'Messages.tsx error rows gate on the fold owner',
  /if \(\(result as \{ is_error\?: boolean \}\)\.is_error\) \{\s*verdict = true/.test(src('src/components/Messages.tsx')) &&
    /\)\.isResultTruncated\?\.\(record\) === true/.test(src('src/components/Messages.tsx')) &&
    src('src/components/FallbackToolUseErrorMessage.tsx').includes('export function isToolErrorResultTruncated'),
)
check(
  'dist ships the 4 new isResultTruncated gates (11 method keys)',
  (readFileSync('dist/mercury.mjs', 'utf8').match(/isResultTruncated/g)?.length ?? 0) >= 11,
)

const base = capture('base', [], 70)
let agentY = -1
let globY = -1
let errY = -1
if (base) {
  const rowOf = (needle: string): number => base.lines.findIndex(l => l.includes(needle))
  agentY = rowOf('Done (3 tool uses')
  globY = rowOf('Searched for 1 pattern')
  errY = rowOf('The target file could not be read')
  check('baseline: agent Done row present', agentY >= 0)
  if (agentY < 0) dumpFrame('baseline frame — the agent Done row is absent', base.lines)
  check('baseline: agent report HIDDEN', rowOf('REPORT-LINE') === -1)
  check(
    'baseline: agent row carries the ⌄ cue',
    agentY >= 0 && (base.lines[agentY]!.includes('⌄') || (base.lines[agentY + 1] ?? '').includes('⌄')),
  )
  check('baseline: glob group collapsed', globY >= 0 && rowOf('GlobTool/prompt.ts') === -1)
  check(
    'baseline: error card folded (stack frames hidden)',
    errY >= 0 && rowOf('+3 stack frames') >= 0 && rowOf('at Object.openSync') === -1,
  )
}

const SETTLED = { minTick: 10, awaitStableTicks: 10, requireAwait: true } as const
if (base && agentY >= 0) {
  const t = capture(
    'toggle',
    [
      { x: 10, y: agentY + 1, atTick: 110, awaitText: 'Done (3 tool uses', ...SETTLED },
      { x: 10, y: agentY + 1, atTick: 150, awaitText: 'REPORT-LINE', ...SETTLED },
    ],
    170,
    { stableTicks: 4 },
  )
  if (t) {
    const rowOf = (needle: string): number => t.lines.findIndex(l => l.includes(needle))
    check('toggle: agent report hidden again after 2nd click', rowOf('REPORT-LINE') === -1)
    const doneY = rowOf('Done (3 tool uses')
    check('toggle: agent Done row back on screen', doneY >= 0)
    check(
      'toggle: the ⌄ cue is back (honest fold marker)',
      doneY >= 0 && ((t.lines[doneY] ?? '').includes('⌄') || (t.lines[doneY + 1] ?? '').includes('⌄')),
    )
  }
} else {
  check('toggle leg ran', false, 'baseline rows missing')
}

if (base && globY >= 0 && errY >= 0) {
  const e = capture(
    'grow',
    [
      { x: 10, y: globY + 1, atTick: 110, awaitText: 'Searched for 1 pattern', ...SETTLED },
      { x: 12, y: errY + 1, atTick: 150, awaitText: 'GlobTool/prompt.ts', ...SETTLED },
    ],
    170,
    { stableTicks: 4 },
  )
  if (e) {
    const rowOf = (needle: string): number => e.lines.findIndex(l => l.includes(needle))
    const fileRow = rowOf('GlobTool/prompt.ts')
    check('glob click: file list revealed', fileRow >= 0 && rowOf('GlobTool.ts') >= 0)
    check(
      'glob click: expanded block wears the DUNE_FAINT bg',
      fileRow >= 0 &&
        e.grid[fileRow]!.some(c => c.bg?.toLowerCase() === DUNE_FAINT.slice(1).toLowerCase()),
    )
    check('error click: raw stack frames revealed', rowOf('at Object.openSync') >= 0)
    check('error click: fold row gone', rowOf('+3 stack frames') === -1)
  }
} else {
  check('grow leg ran', false, 'baseline rows missing')
}

cleanupScenario('click-expand')

{
  const cfg = scenario('tool-lifecycle', 120, 40)
  const gridPath = `/tmp/tool-lifecycle-${process.pid}.json`
  const cfgPath = `/tmp/tool-lifecycle-cfg-${process.pid}.json`
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
    check('lifecycle: PTY capture ran', false, res.stderr?.slice(0, 200) ?? '')
  } else {
    const lines = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid.map(r =>
      r.map(c => c.c).join(''),
    )
    const editRows = lines.filter(l => l.includes('lifecycle-demo.txt'))
    check('lifecycle: ONE visible card for the resolved Edit id', editRows.length >= 1 && new Set(editRows.map(l => l.trim())).size <= 2, `rows=${editRows.length}`)
    const metaRows = lines.filter(l => l.includes('· +1/-1'))
    check('lifecycle: the settled ± meta rides the header EXACTLY once', metaRows.length === 1, `rows=${metaRows.length}: ${metaRows.map(l => l.trim()).join(' | ')}`)
    if (editRows.length === 0 || metaRows.length !== 1) dumpFrame('lifecycle frame — the Edit header is absent', lines)
    check(
      'lifecycle: the ± lane did NOT suppress the diff card (hunks still paint)',
      lines.some(l => l.includes('-alpha')) && lines.some(l => l.includes('+omega')),
    )
    check(
      'lifecycle: the filtered unresolved Bash paints NO ghost card',
      !lines.some(l => l.includes('sleep 999') || l.includes('Long-running fixture command')),
    )
  }
}

{
  const atum = src('src/components/messages/AssistantToolUseMessage.tsx')
  check(
    'queued state derives from the live id sets',
    atum.includes('const resolved = lookups.resolvedToolUseIDs.has(param.id)') &&
      atum.includes('const inProgress = inProgressToolUseIDs.has(param.id)') &&
      atum.includes('const queued = !resolved && !inProgress'),
  )
  check(
    'queued card renders ONLY on the unresolved branch',
    /if \(queued\) \{\s*try \{\s*queuedMessage =\s*tool\.renderToolUseQueuedMessage\?\.\(parsedInput\.data, \{/.test(atum),
  )
  check(
    'the ± meta lane is settled-only (no invented counts on queued/errored)',
    /EDIT_META_TOOLS\.has\(param\.name\) &&\s*resolved &&\s*!errored &&\s*!verbose &&\s*!isTranscriptMode &&/.test(atum) &&
      atum.includes('if (!Array.isArray(patch)) return null') &&
      atum.includes('if (added === 0 && removed === 0) return null'),
  )
}

{
  const run = (clicks: Array<{ x: number; y: number }>, total: number): string[] | null => {
    const cfg = { ...scenario('two-bash-click', 80, 40) }
    cfg.sends = clicks.map(k => ({
      atTick: 110,
      minTick: 10,
      awaitText: 'bash command',
      awaitStableTicks: 10,
      data: `\x1b[<0;${k.x};${k.y}M\x1b[<0;${k.x};${k.y}m`,
    }))
    cfg.total = total
    const gridPath = `/tmp/click-expand-twobash-${process.pid}.json`
    const cfgPath = `/tmp/click-expand-twobash-cfg-${process.pid}.json`
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
  const twoBase = run([], 90)
  const rows = twoBase
    ? twoBase.map((l, i) => (/bash command/.test(l) ? i : -1)).filter(i => i >= 0)
    : []
  check('two-bash baseline shows BOTH collapsed rows', rows.length === 2, `rows=${JSON.stringify(rows)}`)
  if (rows.length === 2) {
    const afterTop = run([{ x: 20, y: rows[0]! + 1 }], 130)
    check(
      'clicking the FURTHER-UP row expands it (echo hi revealed)',
      afterTop !== null && afterTop.some(l => l.includes('Bash echo hi')),
      afterTop === null
        ? 'capture failed'
        : afterTop.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | '),
    )
    const afterBot = run([{ x: 20, y: rows[1]! + 1 }], 130)
    check(
      'clicking the newest row expands it (shasum revealed)',
      afterBot !== null && afterBot.some(l => l.includes('shasum -a 256')),
      afterBot === null
        ? 'capture failed'
        : afterBot.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | '),
    )
    const jitter = (() => {
      const cfg = { ...scenario('two-bash-click', 80, 40) }
      const y = rows[0]! + 1
      cfg.sends = [
        {
          atTick: 110,
          minTick: 10,
          awaitText: 'bash command',
          awaitStableTicks: 10,
          data: `\x1b[<0;20;${y}M\x1b[<32;21;${y}M\x1b[<0;21;${y}m`,
        },
      ]
      cfg.total = 130
      const gridPath = `/tmp/click-expand-jitter-${process.pid}.json`
      const cfgPath = `/tmp/click-expand-jitter-cfg-${process.pid}.json`
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
    })()
    check(
      'a one-cell drift click still toggles (the slop law)',
      jitter !== null && jitter.some(l => l.includes('Bash echo hi')),
      jitter === null
        ? 'capture failed'
        : jitter.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | '),
    )
  }
}

console.log()
if (failures) {
  console.log(`❌ click-expand proof: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ click-expand proof green')
