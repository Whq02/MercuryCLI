#!/usr/bin/env bun
// gate-watch: src/screen/renderer/frame-writer.ts src/screen/renderer/terminalBidiFrame.ts src/screen/renderer/bidi.ts src/screen/renderer/terminal-session/terminalTextCells.ts
// gate-watch: src/screen/composer/text-input/** scripts/ui/rtlTerminalRows.ts scripts/streaming/artifactArena.ts scripts/lib/fixtureApi.ts
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { TerminalRows } from './rtlTerminalRows.ts'

requireDist()

const COLS = 120
const ROWS = 26
const LINE = 'مرحبا بالعالم، هذا سطر تجريبي'
const PARAGRAPH =
  'البحر عالم واسع يغطي معظم سطح الأرض، وفيه آلاف الأنواع من الكائنات الحية التي تعيش في أعماقه. يمنحنا البحر الغذاء والملح ويربط بين القارات عبر طرق التجارة منذ آلاف السنين. تتغير ألوانه مع الضوء من الأزرق إلى الأخضر، وتتحرك أمواجه بفعل الرياح والقمر. علينا أن نحافظ على نظافته وثرواته للأجيال القادمة.'
const TABLE = [
  '| البحر | حقيقة |',
  '| --- | --- |',
  '| البحر الأحمر | يضم ثلاث مئة نوع من المرجان |',
  '| البحر الميت | أخفض بقعة على سطح الأرض |',
  '| البحر الأبيض المتوسط | يطل عليه أكثر من عشرين بلدا |',
].join('\n')
const ANSWER = `${PARAGRAPH}\n\n${TABLE}\n\nANSWER-END`
const FIRST_REPLY = 'REPLY-ONE'
const SECOND_PROMPT = 'Answer in Arabic only now'

const frameDir = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : undefined
if (frameDir) mkdirSync(frameDir, { recursive: true })
const saveRows = (name: string, rows: TerminalRows | null): void => {
  if (frameDir && rows) writeFileSync(join(frameDir, `${name}.txt`), rows.cells.map((row, y) => (rows.lead[y]! + row.map((cell, x) => (rows.inverse[y]![x] ? `[${cell}]` : cell)).join('')).trimEnd()).join('\n') + '\n')
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const HINT_WHOLE = 'what to change: emitDirtyCells in src/screen/renderer/frame-writer.ts writes a row that holds right-to-left letters whole when any of its cells changes'

const deltas: string[] = []
for (let at = 0; at < ANSWER.length; at += 9) deltas.push(ANSWER.slice(at, at + 9))
const turns: ScriptedTurn[] = [
  { kind: 'text', text: `تم الاستلام. ${FIRST_REPLY}`, whenBody: 'باللم' },
  { kind: 'paced', deltas, gapMs: 45, whenBody: SECOND_PROMPT },
]
const READY = 'Type a prompt'
const key = (needle: string, ms: number, text: string): string => `after:${needle}:${ms}:${text}`
const sends: string[] = [key(READY, 1200, `\\x1b[200~${LINE}\\x1b[201~`)]
let at = 2600
for (let i = 0; i < 5; i++, at += 160) sends.push(key(READY, at, '\\x1b[D'))
at += 700
for (let i = 0; i < 10; i++, at += 160) sends.push(key(READY, at, '\\x1b[D'))
at += 700
sends.push(key(READY, at, '\\x01'))
at += 800
for (let i = 0; i < 11; i++, at += 160) sends.push(key(READY, at, '\\x1b[C'))
at += 700
sends.push(key(READY, at, '\\x7f'))
at += 500
sends.push(key(READY, at, '\\x7f'))
at += 1000
sends.push(key(READY, at, '\\x05'))
at += 1400
sends.push(key(READY, at, '\\r'))
sends.push(key(FIRST_REPLY, 1500, SECOND_PROMPT))
sends.push(key(FIRST_REPLY, 2600, '\\r'))
sends.push(key('ANSWER-END', 2500, '\\x1b[5~'))
sends.push(key('ANSWER-END', 4000, '\\x1b[6~'))
const NARROW = 61
const RESIZE_PAINT = '\x1b[?25l\x1b[1;1H'
const PAGE_UP = '\x1b[5~'

type Scene = { rows: TerminalRows; atRest: TerminalRows | null; run: ArenaRun; resized: boolean }

async function scene(terminal: string): Promise<Scene> {
  const run = await runArtifactArena({
    turns,
    sends,
    seconds: 60,
    cols: COLS,
    rows: ROWS,
    keep: true,
    resizes: [`44000:${NARROW}:${ROWS}`, `49000:${COLS}:${ROWS}`],
    extraEnv: { TERM_PROGRAM: terminal },
  })
  if (frameDir) copyFileSync(run.paths.drive, join(frameDir, `${terminal}.drive.jsonl`))
  const decoder = new TextDecoder('utf-8')
  const events: Array<{ ts: number; kind: 'in' | 'out'; bytes: Buffer }> = []
  for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
    if (line === '') continue
    const row = JSON.parse(line) as { ts?: number; sent?: number; b64?: string }
    if (row.b64 === undefined) continue
    const bytes = Buffer.from(row.b64, 'base64')
    if (row.sent !== undefined) events.push({ ts: row.sent, kind: 'in', bytes })
    else if (row.ts !== undefined) events.push({ ts: row.ts, kind: 'out', bytes })
  }
  events.sort((a, b) => a.ts - b.ts)
  const rows = new TerminalRows(COLS, ROWS)
  let atRest: TerminalRows | null = null
  const widths = [NARROW, COLS]
  for (const event of events) {
    if (event.kind === 'out') {
      let text = decoder.decode(event.bytes, { stream: true })
      for (let cut = text.indexOf(RESIZE_PAINT); cut >= 0 && widths.length > 0; cut = text.indexOf(RESIZE_PAINT)) {
        rows.feed(text.slice(0, cut))
        atRest ??= rows.snapshot()
        rows.resize(widths.shift()!)
        rows.feed(RESIZE_PAINT)
        text = text.slice(cut + RESIZE_PAINT.length)
      }
      rows.feed(text)
      continue
    }
    if (event.bytes.toString('utf8') === PAGE_UP) atRest ??= rows.snapshot()
  }
  rows.endFrame()
  return { rows, atRest, run, resized: widths.length === 0 }
}

const HINT_ORDER = 'what to change: shapeBidiForTerminal in src/screen/renderer/bidi.ts'
const plain = (cell: string): string => cell.replace(/[\u2066-\u2069]/g, '')

function tableLines(rows: TerminalRows): string[] {
  const lines: string[] = []
  for (const y of rows.rtlRows()) {
    const columns: number[] = []
    rows.cells[y]!.forEach((cell, x) => {
      if (plain(cell) === '│') columns.push(x)
    })
    if (columns.length >= 5) lines.push(columns.join(','))
  }
  return lines
}

console.log('============================================================')
console.log(' right-to-left rows on the wire: the typing box, a streamed answer, a resize, a scroll back')
console.log('============================================================')

const [apple, iterm] = await Promise.all([scene('Apple_Terminal'), scene('iTerm.app')])
try {
  saveRows('apple-at-rest', apple.atRest)
  saveRows('apple-last', apple.rows)
  saveRows('iterm-at-rest', iterm.atRest)
  if (frameDir) writeFileSync(join(frameDir, 'faults.json'), JSON.stringify({ apple: apple.rows.faults, iterm: iterm.rows.faults }, null, 1))
  for (const [name, { rows, run, resized }] of [['Apple_Terminal', apple], ['iTerm.app', iterm]] as const) {
    const report = run.outcome.report
    check(`${name}: the scene ran to its end (both turns answered, every key delivered)`, run.fixture.messageRequests().length >= 2 && report !== null && report.unfired.length === 0, `the arena did not finish, so the checks below mean nothing · ${JSON.stringify(report ?? run.outcome.reason)}`)
    check(`${name}: the window was narrowed to ${NARROW} columns and widened back, and the screen was painted again each time`, resized, 'the two paints that follow a resize were not seen in the recording, so the resize checks below mean nothing')
    check(`${name}: the screen held right-to-left rows`, rows.rtlRows().length >= 4, String(rows.rtlRows().length))
    const partial = rows.faults.filter(fault => fault.what === 'written in part')
    check(
      `${name}: a row that holds right-to-left letters is written whole in every frame (the typing box at each key, the answer while it streams, after the resize, after the scroll back)`,
      partial.length === 0,
      `${HINT_WHOLE} · ${partial.length} rows written in part, the first: frame ${partial[0]?.frame} row ${partial[0]?.row} (${partial[0]?.detail})`,
    )
    const unpaired = rows.faults.filter(fault => fault.what === 'unpaired marks')
    check(
      `${name}: every direction mark a row holds has its pair after every frame`,
      unpaired.length === 0,
      `${HINT_WHOLE} · ${unpaired.length} rows with unpaired marks, the first: frame ${unpaired[0]?.frame} row ${unpaired[0]?.row} (${unpaired[0]?.detail})`,
    )
  }
  const rest = apple.atRest
  check(
    'Apple_Terminal: the whole answer stood on the screen before the scroll back and the resize',
    rest !== null && rest.rtlRows().length >= 4 && rest.cells.some(row => row.join('').includes('ANSWER-END')),
    `the keys ran late on a loaded machine, so the checks of the answer at rest below mean nothing; run this test alone · ${rest?.rtlRows().length} right-to-left rows`,
  )
  const lines = rest === null ? [] : tableLines(rest)
  check(
    "Apple_Terminal: the table's lines stand in the same columns in each of its four rows",
    lines.length >= 4 && lines.every(columns => columns === lines[0]),
    `${HINT_ORDER} · ${lines.join(' | ')}`,
  )
} finally {
  apple.run.cleanup()
  iterm.run.cleanup()
}

if (failures > 0) {
  console.error(`\nprove-rtl-rows-drive: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-rtl-rows-drive: all green')
process.exit(0)
