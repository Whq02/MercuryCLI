#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'workshop-cell-card-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { cellCardRows } = await import('../../src/tools/WorkshopTool/WorkshopCellCard.tsx')
const { cellCardFactsOf, cellCardOf, cellOpensCard, forgetCellCards, rememberCellCard } = await import('../../src/tools/WorkshopTool/cellCards.ts')
const { cellCardFactsOfResult, cellCardHint, renderToolResultMessage, renderToolUseErrorMessage } = await import('../../src/tools/WorkshopTool/UI.tsx')
type WorkshopCellResult = import('../../src/services/workshop/contracts.ts').WorkshopCellResult

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const cell = (over: Partial<WorkshopCellResult>): WorkshopCellResult => ({
  cellId: 'cell-js-g1-1',
  language: 'js',
  state: 'failed',
  generation: 1,
  runtimeKilled: false,
  durationMs: 12,
  valuePreview: '',
  outputTail: ['row 1', 'row 2', 'row 3', 'row 4', 'row 5'],
  displays: [],
  error: 'Error: the ledger is out of balance\nexpected 3 rows, found 5\nsee the audit for the missing pair\n  at check (cell-js-g1-1.js:1:32)\n  at cell-js-g1-1.js:3:1',
  nestedCalls: 0,
  ...over,
})

console.log('── the row budget: the error keeps its rows, the code clips first, the output folds when there is no room ──')
const SIZES = [
  { cols: 80, rows: 21 },
  { cols: 80, rows: 14 },
  { cols: 82, rows: 17 },
  { cols: 120, rows: 40 },
]
const CHROME_ROWS = 6
const bodyRowsOf = (plan: { code: number; error: number; output: number | null }, wanted: { error: number; killed: boolean }): number =>
  1 + plan.code + 1 + (wanted.killed ? 1 : 0) + 1 + plan.error + (wanted.error > plan.error ? 1 : 0) + (plan.output === null ? 0 : 2 + plan.output) + 1
for (const size of SIZES) {
  const wanted = { code: 3, error: 5, output: 5, killed: false }
  const plan = cellCardRows(size.rows, wanted)
  check(`${size.cols}x${size.rows}: the card's body fits the window (${bodyRowsOf(plan, wanted)} of ${size.rows - CHROME_ROWS} body rows)`, bodyRowsOf(plan, wanted) <= size.rows - CHROME_ROWS, JSON.stringify(plan))
  check(`${size.cols}x${size.rows}: the code keeps at least one row and the error at least as many as the code`, plan.code >= 1 && plan.error >= Math.min(wanted.error, plan.code), JSON.stringify(plan))
  if (size.rows >= 21) check(`${size.cols}x${size.rows}: the whole error and the whole code are on the card`, plan.error === wanted.error && plan.code === wanted.code, JSON.stringify(plan))
  if (size.rows <= 14) check(`${size.cols}x${size.rows}: the output folds into the state line and the code clips to one row`, plan.output === null && plan.code === 1, JSON.stringify(plan))
}
{
  const long = cellCardRows(40, { code: 60, error: 5, output: 5, killed: false })
  check('a long code block clips so the whole error and some output still show at 120x40', long.error === 5 && long.code < 60 && long.output !== null && long.output > 0, JSON.stringify(long))
  const huge = cellCardRows(40, { code: 3, error: 80, output: 5, killed: true })
  check('a huge error takes the rows the code does not need and the runtime-killed row is budgeted', huge.code === 3 && huge.error > 20 && bodyRowsOf(huge, { error: 80, killed: true }) <= 34, JSON.stringify(huge))
  const tiny = cellCardRows(8, { code: 3, error: 5, output: 5, killed: false })
  check('a window shorter than the chrome still yields a one-row code and a one-row error', tiny.code === 1 && tiny.error === 1 && tiny.output === null, JSON.stringify(tiny))
}

console.log('── the facts: a failed or timed-out cell opens a card, a succeeded cell none ──')
{
  forgetCellCards()
  const failed = cellCardFactsOf(cell({}), 'check(5)')
  check('a failed cell yields its facts with the code from the tool-use input', failed !== null && failed.code === 'check(5)' && failed.state === 'failed' && failed.error.startsWith('Error: the ledger') && failed.outputTail.length === 5)
  const timedOut = cellCardFactsOf(cell({ cellId: 'cell-js-g1-2', state: 'timed-out', error: undefined, runtimeKilled: true }), undefined)
  check('a timed-out cell yields its facts, the runtime-killed fact with them, an absent code as an empty string', timedOut !== null && timedOut.state === 'timed-out' && timedOut.runtimeKilled && timedOut.code === '' && timedOut.error === '')
  check('a succeeded cell opens no card', cellCardFactsOf(cell({ state: 'succeeded', error: undefined }), 'x') === null && !cellOpensCard({ state: 'succeeded' }))
  check('a cancelled cell opens no card', cellCardFactsOf(cell({ state: 'cancelled' }), 'x') === null)
  rememberCellCard(failed!)
  check('the board finds a remembered cell by its id', cellCardOf('cell-js-g1-1')?.code === 'check(5)')
  check('an unknown id finds nothing', cellCardOf('no-such-cell') === undefined)
  for (let i = 0; i < 60; i++) rememberCellCard({ ...failed!, cellId: `cell-js-g2-${i}` })
  check('the store is bounded and forgets the oldest first', cellCardOf('cell-js-g1-1') === undefined && cellCardOf('cell-js-g2-59') !== undefined && cellCardOf('cell-js-g2-10') !== undefined)
  forgetCellCards()
}

console.log('── the inline row: a failed call keeps the error card and gains the way to the card; a succeeded call is untouched ──')
{
  forgetCellCards()
  const failed = { cells: [cell({})], result: '[cell-js-g1-1] failed · 12ms · gen 1\nerror: Error: the ledger is out of balance\nexpected 3 rows, found 5\nsee the audit for the missing pair\n  at check (cell-js-g1-1.js:1:32)\n  at cell-js-g1-1.js:3:1\noutput:\n  row 1\n  row 2\n  row 3\n  row 4\n  row 5' }
  const input = { cells: [{ language: 'js' as const, code: 'check(5)' }] }
  check('the error road yields the failed cell\'s facts with the code from the tool-use input', cellCardFactsOfResult(failed, input).length === 1 && cellCardFactsOfResult(failed, input)[0]!.code === 'check(5)')
  check('a text-only result (another harness\'s transcript) yields no facts', cellCardFactsOfResult('Error: x', input).length === 0 && cellCardFactsOfResult(undefined, input).length === 0)
  const text = await renderToString(React.createElement(React.Fragment, null, renderToolUseErrorMessage(`<tool_use_error>${failed.result}</tool_use_error>`, { verbose: false, toolUseResult: failed, input })), 120)
  check('the failed row keeps the error card: the head, the message lines, the folded frames', text.includes('▲ Error: [cell-js-g1-1] failed') && text.includes('expected 3 rows, found 5') && text.includes('+2 stack frames'))
  check('the failed row offers the way to the card in the product\'s own words', text.includes(cellCardHint('cell-js-g1-1')) && cellCardHint('cell-js-g1-1') === '└ view the card: /tasks cell-js-g1-1 · click to open')
  check('painting the failed row remembers the cell for the board', cellCardOf('cell-js-g1-1')?.code === 'check(5)')
  const bare = await renderToString(React.createElement(React.Fragment, null, renderToolUseErrorMessage('<tool_use_error>Error: x</tool_use_error>', { verbose: false })), 120)
  check('an error result without cell facts paints the error card alone', bare.includes('▲ Error: x') && !bare.includes('view the card'))
  const succeeded = { cells: [cell({ cellId: 'cell-js-g1-2', state: 'succeeded', error: undefined, valuePreview: '42', outputTail: [] })], result: '' }
  const okText = await renderToString(React.createElement(React.Fragment, null, renderToolResultMessage(succeeded, [], { verbose: false })), 120)
  check('a succeeded cell\'s row is untouched and offers no card', okText.includes('= 42') && !okText.includes('view the card') && cellCardOf('cell-js-g1-2') === undefined)
}

console.log('── the error road hands every tool the structured result and the input; the Workshop renderer alone reads them ──')
{
  const ROOT = resolve(import.meta.dir, '..', '..')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(name)) files.push(path)
    }
  }
  walk(join(ROOT, 'src'))
  const parameterLists = (text: string): string[] => {
    const lists: string[] = []
    const re = /renderToolUseErrorMessage\s*(?::\s*(?:async\s*)?)?\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      let depth = 1
      let at = m.index + m[0].length
      const start = at
      while (at < text.length && depth > 0) {
        if (text[at] === '(') depth++
        else if (text[at] === ')') depth--
        at++
      }
      lists.push(text.slice(start, at - 1))
    }
    return lists
  }
  const owners = files.filter(f => !f.endsWith(join('src', 'Tool.ts')) && !f.includes(join('messages', 'UserToolResultMessage')) && parameterLists(readFileSync(f, 'utf8')).length > 0)
  const readers = owners.filter(f => parameterLists(readFileSync(f, 'utf8')).some(list => /toolUseResult|\binput\b/.test(list)))
  check(`${owners.length} error-renderer owners found (a census that reads at least the built-in tools)`, owners.length >= 40, String(owners.length))
  check('the Workshop renderer is the only error renderer that reads the structured result or the input', readers.length === 1 && readers[0]!.endsWith(join('WorkshopTool', 'UI.tsx')), readers.map(f => f.slice(ROOT.length + 1)).join(', '))
  const errorRoad = readFileSync(join(ROOT, 'src', 'components', 'messages', 'UserToolResultMessage', 'UserToolErrorMessage.tsx'), 'utf8')
  const dispatch = readFileSync(join(ROOT, 'src', 'components', 'messages', 'UserToolResultMessage', 'UserToolResultMessage.tsx'), 'utf8')
  check('the error road forwards the structured result and the input in the options the renderer already receives', errorRoad.includes('toolUseResult,\n      input,\n    })') && dispatch.includes('toolUseResult={message.toolUseResult}') && dispatch.includes("input={lookups.toolUseByToolUseID.get(toolUse.toolUse.id)?.input}"))
}

console.log(failures === 0 ? '✅ workshop cell card: green' : `❌ workshop cell card: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
