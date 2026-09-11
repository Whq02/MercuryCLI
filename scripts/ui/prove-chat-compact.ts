#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  ADMITTED, check, childEnv, DIST, drive, endLeg, FACE_READY, finish, joined, netlines, nonLoopback,
  printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg,
} from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { CRITTERS, cellColor, squareDockArtFor, type CritterDef } from '../../src/utils/cockpit/critterData.ts'
import { composeCritterFrame } from '../../src/components/mercury-ui/CritterArt.tsx'
import { compactBandForm, compactBandRows } from '../../src/components/mercury-ui/geometry.ts'
import { compactModeChip, compactSummaryHint } from '../../src/components/mercury-ui/compactModeChip.ts'

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }

const argOf = (name: string): string | undefined => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const dist = argOf('--dist') ?? DIST
const label = argOf('--label') ?? 'this tree'
const driver = requireCaptureDriver('chat-compact')
const tree = basename(ROOT)
const SOVEREIGN_ARGV = ['--dangerously-bypass-permissions']
const SOVEREIGN_SETTINGS = { skipSovereignConsentPrompt: true }
const HINT_TEXTS = ['? for shortcuts', 'for commands + files', 'ctrl+t activity', 'for a new line', 'shift + ↵']
const SESSIONS_LINE = /^(\d+ sessions? on · \d+ monitors? here · \d+ agents? here|S:\d+ · M:\d+ · A:\d+|S:\d+ · M:\d+ …|S:\d+ …|…)\s+(⇧← (?:boot face|concourse)|shift\+← (?:boot face|concourse))$/
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
const cellsAt = (grid: Grid, y: number): Cell[] => grid[y] ?? []

function glyphRows(def: CritterDef, art: string[]): string[] {
  const lines: string[] = []
  for (let r = 0; r < art.length; r += 2) {
    let line = ''
    const top = art[r] ?? ''
    const bot = art[r + 1] ?? ''
    const width = Math.max(top.length, bot.length)
    for (let c = 0; c < width; c++) {
      const t = top[c]
      const b = bot[c]
      if (t === 'P' && b === 'P') { line += '●'; continue }
      const tc = cellColor(def, t)
      const bc = cellColor(def, b)
      line += tc !== undefined ? '▀' : bc !== undefined ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines
}

function expectedSprites(form: 'square' | 'dock'): Array<{ name: string; lines: string[] }> {
  return CRITTERS.map(def => {
    const tinted = form === 'dock' ? { ...def, square: squareDockArtFor(def.name) } : def
    const { art } = composeCritterFrame(tinted, { square: true, pupil: '●', gazeKey: '', swayPhase: 0, sleepPhase: null })
    return { name: def.name, lines: glyphRows(tinted, art) }
  })
}

function spriteMatch(rows: string[], form: 'square' | 'dock'): string {
  const candidates = expectedSprites(form)
  for (const candidate of candidates) {
    const width = candidate.lines[0]?.length ?? 0
    const ok = candidate.lines.every((line, i) => (rows[i] ?? '').padEnd(1 + width).slice(1, 1 + width) === line)
    if (ok) return candidate.name
  }
  return ''
}

function bandChecks(tag: string, cols: number, rows: number, grid: Grid, chip: 'sovereign' | null): void {
  const text = textRows(grid)
  const form = compactBandForm(cols, rows)
  const bandRows = compactBandRows(cols, rows)
  const all = joined(text)
  check(`${tag}: the grid has the exact physical dimensions`, grid.length === rows && grid.every(row => row.length === cols))
  check(`${tag}: no shortcut hint text anywhere`, !HINT_TEXTS.some(hint => all.includes(hint)), HINT_TEXTS.filter(hint => all.includes(hint)).join(' | '))
  check(`${tag}: no size refusal replaced the chat`, !/resize to continue|terminal too small|too small for|needs \d+(?: columns|[×x]\d+)/.test(all))
  const modelRows = text.map((line, i) => (line.includes('Opus 5') ? i : -1)).filter(i => i >= 0)
  check(`${tag}: the model appears on exactly one row`, modelRows.length === 1, JSON.stringify(modelRows))
  if (form === 'square' || form === 'dock') {
    const artLines = bandRows - 1
    const critter = spriteMatch(text.slice(0, artLines), form)
    check(`${tag}: rows 1-${artLines} carry the session critter's ${form} form at column 2`, critter !== '', text.slice(0, artLines).map(l => JSON.stringify(l.slice(0, 16))).join(' '))
    check(`${tag}: the rule closes the band on row ${bandRows}`, text[artLines] === '─'.repeat(cols), JSON.stringify(text[artLines] ?? ''))
    const factsAt = form === 'square' ? 16 : 14
    const facts = (y: number): string => (text[y] ?? '').slice(factsAt)
    if (form === 'square') {
      check(`${tag}: the square's top air row is blank`, text[0] === '')
      check(`${tag}: row 2 is the lockup and the readiness`, /^✶ Mercury · ● ready$/.test(facts(1)), JSON.stringify(facts(1)))
      check(`${tag}: row 3 is the model, the effort and the context`, /^Opus 5 · effort \S+(?: \(asked\))? · ctx —$/.test(facts(2)), JSON.stringify(facts(2)))
      check(`${tag}: row 4 is the directory, the branch and the tree state`, new RegExp(`^${tree}(?: ⌥ \\S+)?(?: · (?:clean|uncommitted))?$`).test(facts(3)), JSON.stringify(facts(3)))
      check(`${tag}: row 5 carries no turn count on a fresh session`, facts(4) === '', JSON.stringify(facts(4)))
      check(`${tag}: row 6 is the critter alone`, facts(5) === '', JSON.stringify(facts(5)))
    } else {
      check(`${tag}: row 1 folds the lockup, the readiness, the model, the effort and the context`, /^✶ Mercury · ● ready · Opus 5 · effort \S+(?: \(asked\))? · ctx —$/.test(facts(0)), JSON.stringify(facts(0)))
      check(`${tag}: row 2 is the directory and the branch`, new RegExp(`^${tree}(?: ⌥ \\S+)?$`).test(facts(1)), JSON.stringify(facts(1)))
      check(`${tag}: row 3 is the critter alone`, facts(2) === '', JSON.stringify(facts(2)))
    }
    check(`${tag}: the tree state and the turn count never reach the chip line`, !text.slice(bandRows).some(l => /uncommitted|⤳/.test(l)))
  } else if (form === 'line') {
    check(`${tag}: row 1 is the one identity line`, new RegExp(`^✶ Mercury · ● ready · Opus 5 · effort \\S+(?: \\(asked\\))? · ctx — · ${tree}(?: ⌥ \\S+)?$`).test(text[0] ?? ''), JSON.stringify(text[0] ?? ''))
    check(`${tag}: the rule closes the band on row 2`, text[1] === '─'.repeat(cols), JSON.stringify(text[1] ?? ''))
    check(`${tag}: no critter under 20 rows`, !text.some(l => /[▀▄]{3,}/.test(l)))
  } else {
    check(`${tag}: no band under 14 rows`, !all.includes('✶ Mercury') && !text.some(l => /^─+$/.test(l)))
  }
  const last = rows - 1
  check(`${tag}: the sessions line is the last row with the way back at its right edge`, SESSIONS_LINE.test(text[last] ?? '') && (text[last] ?? '').length === cols, JSON.stringify(text[last] ?? ''))
  const bordered = rows - bandRows >= 14
  const inputAt = bordered ? last - 2 : last - 1
  check(`${tag}: the composer sits directly above the sessions line`, /^(?:│)?❯ /.test(text[inputAt] ?? '') && (text[inputAt] ?? '').includes(ADMITTED), JSON.stringify(text[inputAt] ?? ''))
  if (bordered) {
    check(`${tag}: the composer keeps its rounded frame`, (text[last - 1] ?? '').startsWith('╰') && (text[last - 3] ?? '').startsWith('╭'), `${JSON.stringify(text[last - 3] ?? '')} / ${JSON.stringify(text[last - 1] ?? '')}`)
  }
  const chipAt = bordered ? last - 4 : last - 2
  const chipRow = text[chipAt] ?? ''
  if (chip === 'sovereign') {
    const expected = compactModeChip('sovereign')!.text
    check(`${tag}: the mode chip line sits directly above the composer`, chipRow.startsWith(expected), JSON.stringify(chipRow))
  } else if (form !== 'none') {
    check(`${tag}: no chip line in default mode with nothing needing you`, !/sovereign|need you|permissions unreported/.test(chipRow) && !chipRow.includes('Opus 5'), JSON.stringify(chipRow))
  } else {
    check(`${tag}: under 14 rows the model returns to the chip line`, /^Opus 5 · effort/.test(chipRow), JSON.stringify(chipRow))
  }
  const lines = text.filter(l => l.trim() !== '')
  check(`${tag}: nothing is shown twice (ready · ctx · sessions on)`, ['● ready', 'ctx —', 'sessions on'].every(needle => lines.filter(l => l.includes(needle)).length <= 1))
}

const idleSends = (cols: number, rows: number): unknown[] => [
  { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
  { atTick: 100, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '' },
  { atTick: 999, awaitText: compactBandForm(cols, rows) === 'square' && cols >= 100 ? ADMITTED : cols >= 60 ? '0 agents here' : 'A:0', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'idle' },
]

async function capture(tag: string, cols: number, rows: number, sends: unknown[], opts: { turns?: Parameters<typeof startLeg>[1]; argv?: string[]; resizes?: unknown[]; total?: number; settings?: Record<string, unknown> }): Promise<{ marks: Map<string, Mark>; status: number | null; log: string; leg: Awaited<ReturnType<typeof startLeg>> }> {
  const leg = await startLeg(tag, opts.turns ?? [{ kind: 'text', text: 'Finished.' }], null)
  if (opts.settings !== undefined) writeFileSync(join(leg.home, 'settings.json'), JSON.stringify(opts.settings))
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const log = join(scratch, `${tag}-engine.log`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), dist, '--chat', ...(opts.argv ?? [])], cwd: ROOT, cols, rows, sends, resizes: opts.resizes ?? [], total: opts.total ?? 200, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_COMPUTER_USE: undefined }), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs((opts.total ?? 200) * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(log, output)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    for (const mark of payload.marks ?? []) marks.set(mark.label, mark)
  }
  return { marks, status, log, leg }
}

console.log(`chat compact artifacts: ${scratch} (build: ${label}, dist: ${dist})`)

for (const [cols, rows] of [[90, 31], [80, 24], [82, 17], [40, 10]] as const) {
  const tag = `chat-idle-${cols}x${rows}`
  const run = await capture(tag, cols, rows, idleSends(cols, rows), {})
  try {
    check(`${tag}: the boot and the chat painted (engine exit 0)`, run.status === 0 && run.marks.has('idle'), `exit=${run.status}; ${run.log}`)
    const idle = run.marks.get('idle')
    if (idle === undefined) continue
    printFrame(`${tag} idle`, textRows(idle.grid))
    bandChecks(tag, cols, rows, idle.grid, null)
    check(`${tag}: the drive stayed on loopback`, nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    await endLeg(run.leg)
  }
}

{
  const wide = await capture('chat-sovereign-120x40', 120, 40, idleSends(120, 40), { argv: SOVEREIGN_ARGV, settings: SOVEREIGN_SETTINGS })
  let wideChipFg = ''
  try {
    check('sovereign 120x40: the full cockpit painted', wide.status === 0 && wide.marks.has('idle'), `exit=${wide.status}; ${wide.log}`)
    const idle = wide.marks.get('idle')
    if (idle !== undefined) {
      const text = textRows(idle.grid)
      printFrame('chat-sovereign-120x40 idle', text)
      const bandAt = text.findIndex(l => l.includes('sovereign mode on'))
      check('sovereign 120x40: the full cockpit paints its mode band', bandAt >= 0)
      const cell = cellsAt(idle.grid, bandAt).find(c => c.c === '⊠')
      wideChipFg = cell?.fg ?? ''
      check('sovereign 120x40: the band wears a real colour', wideChipFg !== '' && wideChipFg !== 'default', wideChipFg)
    }
  } finally {
    await endLeg(wide.leg)
  }
  const tag = 'chat-sovereign-stream-80x24'
  const run = await capture(tag, 80, 24, [
    ...idleSends(80, 24),
    { afterPrevTicks: 3, data: 'stream the compact chat\r' },
    { atTick: 999, awaitText: 'compact-stream-003', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'streaming' },
    { afterPrevTicks: 3, data: '\u001b' },
    { atTick: 999, awaitText: 'Interrupted', minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'interrupted' },
  ], {
    argv: SOVEREIGN_ARGV,
    settings: SOVEREIGN_SETTINGS,
    turns: [{ kind: 'paced', deltas: Array.from({ length: 120 }, (_, i) => `compact-stream-${String(i).padStart(3, '0')}\n`), gapMs: 250 }, { kind: 'text', text: 'Finished.' }],
    total: 400,
  })
  try {
    check(`${tag}: the boot, the stream and the interrupt ran (engine exit 0)`, run.status === 0 && run.marks.has('idle') && run.marks.has('streaming'), `exit=${run.status}; ${run.log}`)
    const idle = run.marks.get('idle')
    if (idle !== undefined) {
      printFrame(`${tag} idle`, textRows(idle.grid))
      bandChecks(`${tag} idle`, 80, 24, idle.grid, 'sovereign')
      const text = textRows(idle.grid)
      const chipAt = text.findIndex(l => l.startsWith(compactModeChip('sovereign')!.text))
      const cell = cellsAt(idle.grid, chipAt).find(c => c.c === '⊠')
      check(`${tag}: the chip wears the colour the wide mode band wears (${wideChipFg})`, chipAt >= 0 && cell !== undefined && cell.fg === wideChipFg && wideChipFg !== '', `${cell?.fg ?? '(no chip)'}`)
      const tail = cellsAt(idle.grid, chipAt).slice(compactModeChip('sovereign')!.text.length).find(c => c.c.trim() !== '')
      check(`${tag}: nothing after the chip on its line at idle`, tail === undefined, tail?.c ?? '')
    }
    const streaming = run.marks.get('streaming')
    if (streaming !== undefined) {
      const text = textRows(streaming.grid)
      printFrame(`${tag} streaming`, text)
      const chipAt = text.findIndex(l => l.startsWith(compactModeChip('sovereign')!.text))
      const composerTop = text.findIndex(l => l.startsWith('╭'))
      check(`${tag}: the chip line keeps its place directly above the composer while streaming`, chipAt >= 0 && composerTop === chipAt + 1, `chip=${chipAt} composer=${composerTop}`)
      const activity = text[chipAt - 1] ?? ''
      check(`${tag}: the glyph line rides directly above the chip line`, activity.startsWith('✶') && activity.includes('tokens') && /thinking|writing|working|waiting/.test(activity), JSON.stringify(activity))
      check(`${tag}: the band keeps the lockup without the readiness word while the turn runs`, text.some(l => l.includes('✶ Mercury')) && !text.some(l => l.includes('● ready')))
      check(`${tag}: the sessions line carries the interrupt rung beside the way back`, /esc interrupts · ⇧← (?:boot face|concourse)$/.test(text[23] ?? ''), JSON.stringify(text[23] ?? ''))
      check(`${tag}: the model still appears on exactly one row while streaming`, text.filter(l => l.includes('Opus 5')).length === 1)
    }
    check(`${tag}: the drive stayed on loopback`, nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    await endLeg(run.leg)
  }
}

{
  const tag = 'chat-resize-journey'
  const gate = { requireAwait: true, minTick: 3, awaitStableTicks: 6, awaitSettleTicks: 2 }
  const run = await capture(tag, 120, 40, [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
    { ...gate, awaitText: ADMITTED, data: '', mark: 'full-1' },
    { ...gate, awaitText: ADMITTED, data: '', mark: 'r90x31' },
    { ...gate, awaitText: ADMITTED, data: '', mark: 'r80x24' },
    { ...gate, awaitText: ADMITTED, data: '', mark: 'r82x17' },
    { ...gate, awaitText: ADMITTED, data: '', mark: 'full-2' },
  ], {
    resizes: [
      { afterMark: 'full-1', afterMs: 400, cols: 90, rows: 31 },
      { afterMark: 'r90x31', afterMs: 400, cols: 80, rows: 24 },
      { afterMark: 'r80x24', afterMs: 400, cols: 82, rows: 17 },
      { afterMark: 'r82x17', afterMs: 400, cols: 120, rows: 40 },
    ],
    total: 500,
  })
  try {
    check(`${tag}: the journey ran as written (engine exit 0)`, run.status === 0, `exit=${run.status}; ${run.log}`)
    const labels = ['full-1', 'r90x31', 'r80x24', 'r82x17', 'full-2']
    check(`${tag}: every mark exists`, labels.every(l => run.marks.has(l)), labels.filter(l => !run.marks.has(l)).join(', '))
    for (const l of labels) {
      const mark = run.marks.get(l)
      if (mark !== undefined) printFrame(`${tag} ${l} (${mark.cols}x${mark.rows})`, textRows(mark.grid))
    }
    const at = (l: string): Mark | undefined => run.marks.get(l)
    for (const [l, cols, rows] of [['r90x31', 90, 31], ['r80x24', 80, 24], ['r82x17', 82, 17]] as const) {
      const mark = at(l)
      if (mark === undefined) continue
      check(`${tag} ${l}: the mark was taken at ${cols}x${rows}`, mark.cols === cols && mark.rows === rows, `${mark.cols}x${mark.rows}`)
      if (mark.cols === cols && mark.rows === rows) bandChecks(`${tag} ${l}`, cols, rows, mark.grid, null)
    }
    const first = at('full-1')
    const second = at('full-2')
    if (first !== undefined && second !== undefined) {
      check(`${tag}: both full marks are 120x40`, first.cols === 120 && first.rows === 40 && second.cols === 120 && second.rows === 40)
      const bytes = (g: Grid): string => g.map(row => row.map(c => `${c.c}|${c.fg}|${c.bg}|${c.bold ? 1 : 0}${c.rev ? 1 : 0}`).join('\t')).join('\n')
      check(`${tag}: the full cockpit returns byte-identical (every cell, colour and attribute)`, bytes(first.grid) === bytes(second.grid), textRows(second.grid).filter((l, i) => l !== textRows(first.grid)[i]).slice(0, 3).join(' | '))
      const fullText = joined(textRows(first.grid))
      check(`${tag}: the full cockpit keeps its own chrome (SESSIONS card, the shortcut hint, no band rule)`, fullText.includes('SESSIONS') && fullText.includes('? for shortcuts') && !textRows(first.grid).some(l => /^─+$/.test(l)))
    }
    check(`${tag}: the drive stayed on loopback`, nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    await endLeg(run.leg)
  }
}

{
  const chip = compactModeChip('sovereign')
  check('the chip owner spells the sovereign chip as approved', chip !== null && chip.text === '⊠ sovereign · auto-approved' && chip.tone === 'bypass')
  check('the chip owner paints nothing for the default mode', compactModeChip('default') === null)
  check('the chip owner names an unreported mode', compactModeChip(null)?.text === 'permissions unreported')
  check('the sessions line hint folds the focus, the interrupt rung and the way back in order', compactSummaryHint({ focused: true, vimInsert: true, escHint: 'esc interrupts', stripHint: '⇧← concourse' }) === '↵ details · esc back' && compactSummaryHint({ focused: false, vimInsert: true, escHint: 'esc interrupts', stripHint: '⇧← concourse' }) === 'INSERT · esc interrupts · ⇧← concourse' && compactSummaryHint({ focused: false, vimInsert: false, escHint: '', stripHint: '' }) === '')
  check('the band form ladder is the approved one', compactBandForm(90, 31) === 'square' && compactBandForm(80, 26) === 'square' && compactBandForm(80, 25) === 'dock' && compactBandForm(80, 20) === 'dock' && compactBandForm(82, 19) === 'line' && compactBandForm(82, 14) === 'line' && compactBandForm(40, 13) === 'none' && compactBandForm(20, 31) === 'line')
  check('the band rows follow the forms', compactBandRows(90, 31) === 7 && compactBandRows(80, 24) === 4 && compactBandRows(82, 17) === 2 && compactBandRows(40, 10) === 0)
}

finish('chat-compact')
