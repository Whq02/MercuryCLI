#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const vb = (await import('./visualBaseline.ts')) as Record<string, unknown>
const { DEFAULT_MASKS, GRIDS_DIR, neutralizeGrid, firstDivergence } = vb as typeof import('./visualBaseline.ts')
type StoredGrid = import('./visualBaseline.ts').StoredGrid
type RawGrid = import('./visualBaseline.ts').RawGrid
const oneRow = (text: string): StoredGrid => ({ schema: 1, cols: text.length, rows: 1, text: [text], styles: [[[0, 4, 'x', 'default', 0]]] })
const same = (a: string, b: string, masks: readonly string[] = DEFAULT_MASKS): boolean =>
  neutralizeGrid(oneRow(a), [...masks]).text[0] === neutralizeGrid(oneRow(b), [...masks]).text[0]
const kept = (row: string, masks: readonly string[] = DEFAULT_MASKS): boolean => neutralizeGrid(oneRow(row), [...masks]).text[0] === row

const left150 = '╭──────────────────────╮│ 13:00:01 [sam] ❯ first task' + ' '.repeat(72) + '││  '
const idle150 = left150 + 'idle' + ' '.repeat(16) + '│'
const dash150 = left150 + '—' + ' '.repeat(19) + '│'
const left160 = '╭───────────────────────────╮│ 13:00:01 [sam] ❯ first task' + ' '.repeat(72) + '││   '
const idle160 = left160 + 'idle' + ' '.repeat(20) + '│'
const dash160 = left160 + '—' + ' '.repeat(23) + '│'

section("§1 the workflow chip's idle measure is a capture-timing token: both spellings digest the same")
check('the 150-column row reads the same with idle and with the dash', same(idle150, dash150), JSON.stringify(neutralizeGrid(oneRow(dash150), [...DEFAULT_MASKS]).text[0]))
check('the 160-column row (three spaces after the border) reads the same too', same(idle160, dash160))
check('the mask is one named entry of the default set', typeof vb.IDLE_MEASURE_MASK === 'string' && DEFAULT_MASKS.includes(vb.IDLE_MEASURE_MASK as string))
const masked = (row: string): string => neutralizeGrid(oneRow(row), [...DEFAULT_MASKS]).text[0]
check('the masked row keeps the rest of the row (only the chip is absorbed)', masked(idle150).endsWith('│') && masked(idle150).includes('❯ first task'), masked(idle150))

section('§2 the mask reaches nothing else')
check('a dash inside a value is untouched', kept('╭──────────────────────╮││  ctx — · 1000k       │'))
check("a title ending in a dash is untouched", kept('╭──────────────────────╮││  second task —       │'))
check('a resting status row with the word idle is untouched', kept('│ work · idle · 3 files                                                 │'))
const stored = readdirSync(GRIDS_DIR).filter(f => f.endsWith('.grid.json'))
const only = typeof vb.IDLE_MEASURE_MASK === 'string' ? [vb.IDLE_MEASURE_MASK as string] : []
let touchedElsewhere = 0
let touchedChip = 0
for (const file of stored) {
  const grid = JSON.parse(readFileSync(join(GRIDS_DIR, file), 'utf8')) as StoredGrid
  const out = neutralizeGrid(grid, only).text
  for (let y = 0; y < grid.rows; y++) {
    if (out[y] === grid.text[y]) continue
    if (y > 0 && grid.text[y - 1].includes('⤳ WORKFLOW')) touchedChip++
    else touchedElsewhere++
  }
}
check(`across the ${stored.length} stored grids the mask touches only the row under a WORKFLOW header`, only.length === 1 && touchedChip > 0 && touchedElsewhere === 0, `chip rows ${touchedChip}, other rows ${touchedElsewhere}`)

section('§3 a capture that never settles is refused at once with what it saw — never a blind longer wait')
type AttemptResult = { status: number | null; stderr: string; stdout: string; grid?: RawGrid }
const run = vb.runCaptureAttempts as undefined | ((id: string, run: (attempt: number) => AttemptResult, judge: (g: RawGrid) => { ok: boolean; reason: string }, opts: { log?: (line: string) => void; refused?: (res: AttemptResult, kind: string) => string }) => { grid: RawGrid; stdout: string; attempts: number })
check('the attempts runner exists beside the masks', typeof run === 'function')
if (typeof run === 'function') {
  const good: RawGrid = { cols: 1, rows: 1, grid: [[{ c: 'x', fg: 'default', bg: 'default', bold: false, rev: false }]] }
  const ok = (): { ok: boolean; reason: string } => ({ ok: true, reason: '' })
  const neverReady = "[vshot] UNDELIVERED-SENDS: 1 of 4 sends never became due (first stuck: 'RECENT'). The journey did not happen as written.\n"
  {
    const attemptsSeen: number[] = []
    const lines: string[] = []
    let kept: { kind: string; stdout: string } | null = null
    let threw: unknown = null
    try {
      run('frame--101x30--dark--truecolor--full', attempt => {
        attemptsSeen.push(attempt)
        return { status: 4, stderr: neverReady, stdout: 'the last frame' }
      }, ok, { log: l => lines.push(l), refused: (res, kind) => { kept = { kind, stdout: res.stdout }; return '/kept/here' } })
    } catch (e) {
      threw = e
    }
    check('a never-settled capture is refused after ONE attempt — no retry, no longer budget', attemptsSeen.join(',') === '1' && lines.length === 0, attemptsSeen.join(','))
    check('the refusal is a CaptureRefusal naming the entry and the stuck needle', threw instanceof Error && threw.name === 'CaptureRefusal' && threw.message.includes('[frame--101x30--dark--truecolor--full]') && threw.message.includes("first stuck: 'RECENT'"), String(threw).slice(0, 200))
    check('what it saw is handed to the keeper (the last frame) and the kept path is named in the refusal', kept !== null && (kept as { kind: string; stdout: string }).kind === 'never-ready' && (kept as { kind: string; stdout: string }).stdout === 'the last frame' && String(threw).includes('/kept/here'), JSON.stringify(kept))
  }
  {
    const kinds = vb.captureRefusalKind as (status: number | null, stderr: string) => string
    check('vshot exits 3 and 4 are never-ready, 5 is never-still, a wall kill is wall, anything else is refused', kinds(3, '') === 'never-ready' && kinds(4, '') === 'never-ready' && kinds(5, '') === 'never-still' && kinds(null, '') === 'wall' && kinds(1, 'boom') === 'refused')
  }
  {
    const attemptsSeen: number[] = []
    const lines: string[] = []
    const r = run('frame--y', attempt => {
      attemptsSeen.push(attempt)
      return { status: 0, stderr: '', stdout: String(attempt), grid: good }
    }, () => (attemptsSeen.length === 1 ? { ok: false, reason: 'chrome marker missing' } : { ok: true, reason: '' }), { log: l => lines.push(l) })
    check('an oracle rejection of a settled frame retries once at the same ceiling and names the oracle', r.attempts === 2 && attemptsSeen.join(',') === '1,2' && lines.length === 1 && lines[0]!.includes('oracle') && lines[0]!.includes('same ceiling'), lines.join(' | '))
  }
  {
    const lines: string[] = []
    const r = run('frame--z', () => ({ status: 0, stderr: '', stdout: 'first', grid: good }), ok, { log: l => lines.push(l) })
    check('a clean first capture is one attempt and no retry line', r.attempts === 1 && lines.length === 0)
  }
}

section('§4 a stored grid that the fresh capture matches under the masks stands; a moved cell rewrites it')
const stands = vb.storedGridStands as undefined | ((stored: StoredGrid | null, fresh: StoredGrid, masks: string[]) => boolean)
check('the keep decision exists beside the masks', typeof stands === 'function')
if (typeof stands === 'function') {
  const two = (a: string, b: string): StoredGrid => ({ schema: 1, cols: a.length, rows: 2, text: [a, b], styles: [[], []] })
  const held = two('│⤳ WORKFLOW            │', '│  idle                │')
  const timing = two('│⤳ WORKFLOW            │', '│  —                   │')
  const moved = two('│⤳ WORKFLOW            │', '│  running             │')
  check('only the idle measure differs → the stored grid stands', stands(held, timing, [...DEFAULT_MASKS]) === true)
  check('a real change → the stored grid is rewritten', stands(held, moved, [...DEFAULT_MASKS]) === false)
  check('no stored grid → written', stands(null, timing, [...DEFAULT_MASKS]) === false)
  check('the decision is the divergence read the check uses', firstDivergence(held, timing, [...DEFAULT_MASKS]) === null && firstDivergence(held, moved, [...DEFAULT_MASKS]) !== null)
}

section('§5 whole-frame drive comparisons use the stored masks')
const critterDrive = readFileSync(join(import.meta.dir, '../critters/prove-critter-mini-drive.ts'), 'utf8')
check('the critter drive compares compacted captures through the default masks', /firstDivergence\(compact\(a\), compact\(b\), DEFAULT_MASKS\)/.test(critterDrive))
check('the sprite cell checks remain exact', critterDrive.includes('!sameCell(boot[3 + r]'))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
