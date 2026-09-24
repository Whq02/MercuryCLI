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
const { cellCardFactsOf, cellCardOf, cellOpensCard, forgetCellCards, lastShellCallOf, rememberCellCard, shellCallHeadline } = await import('../../src/tools/WorkshopTool/cellCards.ts')
const { SHELL_CALL_OUTPUT_LINES, SHELL_CALLS_KEPT } = await import('../../src/services/workshop/contracts.ts')
const { lastOutputLines, shellCallLedger } = await import('../../src/services/workshop/shellCalls.ts')
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

console.log('── a bridged shell call: the facts carry its command and the last output lines; the row and the card paint them under the error ──')
{
  forgetCellCards()
  const SHELL_COMMAND = 'echo out-line; echo err-line >&2; exit 1'
  const ledger = shellCallLedger()
  const opened = ledger.open(1, 'tool', { name: 'Bash', input: { command: SHELL_COMMAND } })
  ledger.settle(opened, { code: 1, stdout: 'out-line\nerr-line\n\nExited with code 1\n\n', stderr: '' })
  check('the ledger opens a row for a Bash call only, with its command', opened !== null && opened.command === SHELL_COMMAND && ledger.open(2, 'tool', { name: 'Read', input: {} }) === null && ledger.open(3, 'inspect', { ref: 'x' }) === null)
  check('a settled call records its exit code and the last output lines, trailing blank lines dropped', opened?.code === 1 && JSON.stringify(opened?.outputTail) === JSON.stringify(['out-line', 'err-line', '', 'Exited with code 1']))
  check(`the last-lines reader keeps at most ${SHELL_CALL_OUTPUT_LINES}`, lastOutputLines(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')).length === SHELL_CALL_OUTPUT_LINES && lastOutputLines('a\nb')[0] === 'a')
  for (let i = 0; i < SHELL_CALLS_KEPT + 3; i++) ledger.open(10 + i, 'tool', { name: 'Bash', input: { command: `true ${i}` } })
  check(`the ledger keeps the last ${SHELL_CALLS_KEPT} calls`, ledger.calls.length === SHELL_CALLS_KEPT && ledger.calls[ledger.calls.length - 1]!.command === `true ${SHELL_CALLS_KEPT + 2}`)
  const refused = ledger.open(30, 'tool', { name: 'Bash', input: { command: 'nohup sleep 1 &' } })
  ledger.refuse(refused)
  check('a refused call is marked and keeps its command', refused?.refused === true && refused.command === 'nohup sleep 1 &' && refused.code === undefined)
  check('the headline names the command and the exit; a refusal names the command alone', shellCallHeadline({ ordinal: 1, command: SHELL_COMMAND, code: 1 }) === `${SHELL_COMMAND} · exit 1` && shellCallHeadline({ ordinal: 2, command: 'nohup sleep 1 &', refused: true }) === 'nohup sleep 1 &')

  const shellCell = cell({ cellId: 'cell-js-g1-3', error: 'Error: the command failed, stopping here\n  at cell-js-g1-3.js:2:7', outputTail: [], shellCalls: [{ ordinal: 1, command: SHELL_COMMAND, code: 1, outputTail: ['out-line', 'err-line', '', 'Exited with code 1'] }] })
  const shellFacts = cellCardFactsOf(shellCell, "const r = await mercury.tool('Bash', { command: 'echo out-line; echo err-line >&2; exit 1' })\nif (r.code !== 0) throw new Error('the command failed, stopping here')")
  check('the facts carry the shell calls and name the last one', shellFacts !== null && shellFacts.shellCalls.length === 1 && lastShellCallOf(shellFacts)?.command === SHELL_COMMAND)
  check('a cell row without the field (an older transcript) yields no shell calls', cellCardFactsOf(cell({}), 'x')?.shellCalls.length === 0)
  const plain = cellCardRows(40, { code: 3, error: 5, output: 5, killed: false })
  const withShell = cellCardRows(40, { code: 3, error: 5, output: 5, killed: false, shell: 1 + SHELL_CALL_OUTPUT_LINES })
  check('at 120x40 the shell block takes its rows without clipping the error or the code', withShell.shell === 1 + SHELL_CALL_OUTPUT_LINES && withShell.error === 5 && withShell.code === 3 && withShell.output !== null, JSON.stringify(withShell))
  check('a plan without a shell block is the plan as before', plain.shell === 0 && plain.error === 5 && plain.code === 3, JSON.stringify(plain))
  const short = cellCardRows(14, { code: 3, error: 5, output: 5, killed: false, shell: 1 + SHELL_CALL_OUTPUT_LINES })
  check('on a short window the shell block shrinks to the command line and the error and the code keep a row each', short.shell === 1 && short.error >= 1 && short.code >= 1 && short.output === null, JSON.stringify(short))
  const shellResult = { cells: [shellCell], result: '[cell-js-g1-3] failed · 12ms · gen 1 · 1 bridge call(s)\nerror: Error: the command failed, stopping here\n  at cell-js-g1-3.js:2:7' }
  const shellInput = { cells: [{ language: 'js' as const, code: shellFacts!.code }] }
  for (const columns of [178, 120]) {
    const row = await renderToString(React.createElement(React.Fragment, null, renderToolUseErrorMessage(`<tool_use_error>${shellResult.result}</tool_use_error>`, { verbose: false, toolUseResult: shellResult, input: shellInput })), columns)
    check(`at ${columns} columns the failed row paints the command and its exit under the error`, row.includes('▲ Error: [cell-js-g1-3] failed') && row.includes(`command: ${SHELL_COMMAND} · exit 1`), row.slice(0, 600))
    const afterCommand = row.slice(row.indexOf('command:'))
    check(`at ${columns} columns the last output lines follow the command, then the way to the card`, afterCommand.includes('err-line') && afterCommand.includes('Exited with code 1') && afterCommand.indexOf('Exited with code 1') < afterCommand.indexOf(cellCardHint('cell-js-g1-3')), afterCommand.slice(0, 400))
  }
  const refusedCell = cell({ cellId: 'cell-js-g1-4', error: "bridge call 1 (Bash) failed: Ward 'self-daemonize' blocked this Bash call\nthe cell stopped at that call", outputTail: [], shellCalls: [{ ordinal: 1, command: 'nohup sleep 1 &', refused: true }] })
  const refusedResult = { cells: [refusedCell], result: `[cell-js-g1-4] failed · 3ms · gen 1 · 1 bridge call(s)\nerror: ${refusedCell.error}` }
  const refusedRow = await renderToString(React.createElement(React.Fragment, null, renderToolUseErrorMessage(`<tool_use_error>${refusedResult.result}</tool_use_error>`, { verbose: false, toolUseResult: refusedResult, input: { cells: [{ language: 'js' as const, code: "await mercury.tool('Bash', { command: 'nohup sleep 1 &' })" }] } })), 178)
  check("a refused call's row names the command it refused under the refusal", refusedRow.includes('refused: nohup sleep 1 &') && !refusedRow.includes('exit '), refusedRow.slice(0, 600))
  forgetCellCards()
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
