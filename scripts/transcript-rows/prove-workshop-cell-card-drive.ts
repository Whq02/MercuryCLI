#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ADMITTED, check, drive, endLeg, FACE_READY, finish, joined, printFrame, requireCaptureDriver, rowsHaving, scratch, startLeg,
} from '../computer/computerDriveKit.ts'

const argOf = (name: string): string | undefined => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const output = argOf('--output') === undefined ? undefined : resolve(argOf('--output')!)
if (output !== undefined) mkdirSync(output, { recursive: true })
const driver = requireCaptureDriver('workshop-cell-card')
const ESC = String.fromCharCode(27)

const CELL_ID = 'cell-js-g1-1'
const CODE = [
  "function check(n) { if (n > 2) throw new Error('the ledger is out of balance\\nexpected 3 rows, found 5\\nsee the audit for the missing pair') }",
  "for (const row of [1, 2, 3, 4, 5]) console.log('row ' + row)",
  'check(5)',
].join('\n')
const ERROR_HEAD = 'Error: the ledger is out of balance'
const ERROR_SECOND = 'expected 3 rows, found 5'
const ERROR_THIRD = 'see the audit for the missing pair'
const HINT = `└ view the card: /tasks ${CELL_ID} · click to open`
const CARD_TITLE = `Mercury — workshop · ${CELL_ID}`
const BOARD_TITLE = 'Mercury — tasks'
const since = (rows: string[], needle: string): string[] => {
  const at = rows.findIndex(r => r.includes(needle))
  return at < 0 ? [] : rows.slice(at)
}
const TURNS = [
  { kind: 'tool_use' as const, name: 'Workshop', input: { cells: [{ language: 'js', title: 'ledger check', code: CODE }] } },
  { kind: 'text' as const, text: 'The ledger check failed; the cell says why.' },
]
const SIZES = [
  { cols: 80, rows: 21 },
  { cols: 80, rows: 14 },
  { cols: 82, rows: 17 },
  { cols: 120, rows: 40 },
]

const keep = (tag: string, label: string, rows: string[]): void => {
  if (output === undefined) return
  writeFileSync(join(output, `${tag}-${label}.txt`), rows.join('\n') + '\n')
}

for (const size of SIZES) {
  const tag = `workshop-cell-card-${size.cols}x${size.rows}`
  console.log(`\n── ${tag}: a cell fails with a three-line error; the row, the card, esc back ──`)
  const leg = await startLeg(tag, TURNS, null)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify({ permissions: { allow: ['Workshop'] } }))
  const sends = [
    { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    { atTick: 120, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '' },
    { afterPrevTicks: 3, data: 'run the ledger check\r' },
    { atTick: 999, awaitText: 'the cell says why', minTick: 5, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'row' },
    { afterPrevTicks: 3, data: `/tasks ${CELL_ID}\r` },
    { atTick: 999, awaitText: 'esc close', minTick: 3, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'card' },
    { afterPrevTicks: 3, data: ESC },
    { atTick: 999, awaitText: ADMITTED, minTick: 3, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'back' },
    { afterPrevTicks: 3, data: '/tasks no-such-cell\r' },
    { atTick: 999, awaitText: 'esc close', minTick: 3, awaitSettleTicks: 4, requireAwait: true, data: '', mark: 'unknown' },
    { afterPrevTicks: 3, data: ESC },
    { atTick: 999, awaitText: ADMITTED, minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: '', mark: 'end' },
  ]
  const result = await drive(driver, leg, size, sends, 700, { MERCURY_COMPUTER_USE: undefined })
  await endLeg(leg)
  check(`${tag}: the journey ran to its last mark (engine exit 0)`, result.status === 0 && result.marks.end !== undefined, `exit=${result.status} marks=${Object.keys(result.marks).join(',')} ${result.stderr.slice(-400)}`)
  for (const label of ['row', 'card', 'back', 'unknown']) {
    const frame = result.marks[label]
    if (frame !== undefined) {
      printFrame(`${tag} ${label}`, frame)
      keep(tag, label, frame)
    }
  }
  const row = result.marks.row ?? []
  const card = since(result.marks.card ?? [], CARD_TITLE)
  const back = result.marks.back ?? []
  const unknown = result.marks.unknown ?? []
  const tall = size.rows >= 21
  check(`${tag}: the inline row keeps today's shape (the error card's message lines and its folded frames; its head line on a tall window)`, !tall || (rowsHaving(row, ERROR_SECOND) && rowsHaving(row, '+2 stack frames') && (size.rows < 40 || rowsHaving(row, `▲ Error: [${CELL_ID}] failed`))))
  check(`${tag}: the inline row offers the way to the card in the product's own words`, rowsHaving(row, HINT))
  check(`${tag}: the card is up (the workshop center with the cell's id, esc close)`, card.length > 0 && rowsHaving(card, 'esc close'))
  check(`${tag}: the card names the cell's language and title`, rowsHaving(card, 'js · ledger check'))
  check(`${tag}: the card carries the code`, rowsHaving(card, 'check(5)') || rowsHaving(card, 'function check(n)'))
  check(`${tag}: the card carries the error past its first line`, rowsHaving(card, ERROR_HEAD) && rowsHaving(card, ERROR_SECOND))
  if (size.rows >= 21) check(`${tag}: the whole error is on the card`, rowsHaving(card, ERROR_THIRD) && rowsHaving(card, `at check (${CELL_ID}`))
  check(`${tag}: the card says the state, the duration and the generation`, /failed · \d+ms · gen 1/.test(joined(card)))
  check(`${tag}: the card counts the output lines it shows`, /\d of 5 lines shown|5 output lines/.test(joined(card)))
  check(`${tag}: esc returns to the chat with the row still there`, rowsHaving(back, ADMITTED) && (!tall || rowsHaving(back, ERROR_HEAD)))
  check(`${tag}: an unknown id still answers with the board, never a card`, rowsHaving(unknown, BOARD_TITLE) && !rowsHaving(unknown, CARD_TITLE) && !rowsHaving(unknown, 'js · ledger check'))
}

finish('workshop-cell-card')
