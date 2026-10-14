import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { default: TurndownService } = await import('turndown')
const { addTableRule } = await import('../../src/tools/WebFetchTool/tableRule.js')
const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
addTableRule(service)
let failures = 0
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `\n${detail}`}`) }

const simple = service.turndown(`<p>Before</p>
<table><caption>Precedence</caption>
<thead><tr><th>Source</th><th>Wins | over</th><th>Example</th></tr></thead>
<tbody><tr><td>Command line</td><td>Environment, file</td><td><code>--interval=10m</code></td></tr>
<tr><th>File</th><td>Defaults</td><td><a href="/x">interval</a> = <b>10m</b></td></tr></tbody></table>
<p>After</p>`)
check('a simple table is a GitHub-style markdown table: header row, separator row, one line per row',
  simple.includes('| Source | Wins \\| over | Example |\n| --- | --- | --- |\n| Command line | Environment, file | `--interval=10m` |\n| File | Defaults | [interval](/x) = **10m** |'), simple)
check('the caption leads the table and the paragraphs around it survive as their own blocks', /^Before\n\nPrecedence\n\n\| Source/.test(simple) && simple.endsWith('|\n\nAfter'), simple)

const spanned = service.turndown('<table><tr><th colspan="2">Merged head</th></tr><tr><td>a</td><td>b</td></tr><tr><td rowspan="2">c</td><td>d</td></tr><tr><td>e</td></tr></table>')
check('a table with spans is rows as lines, cells separated by " · ", never a stack of cells', spanned === 'Merged head\na · b\nc · d\ne', JSON.stringify(spanned))

const nested = service.turndown('<table><tr><th>Outer</th><th>Inner</th></tr><tr><td>row 1</td><td><table><tr><td>i1</td><td>i2</td></tr></table></td></tr></table>')
check('a table holding a nested table is rows as lines', nested === 'Outer · Inner\nrow 1 · i1 · i2', JSON.stringify(nested))

const headless = service.turndown('<table><tr><td>k1</td><td>v1</td></tr><tr><td>k2</td><td>v2</td></tr></table>')
check('a table without a header row is rows as lines', headless === 'k1 · v1\nk2 · v2', JSON.stringify(headless))

const ragged = service.turndown('<table><tr><th>H1</th><th>H2</th></tr><tr><td>only one</td></tr></table>')
check('a ragged table (a row with a different cell count) is rows as lines', ragged === 'H1 · H2\nonly one', JSON.stringify(ragged))

const multiline = service.turndown('<table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td><p>one</p><p>two</p></td></tr></table>')
check('a cell with block content stays on its row line', multiline === '| K | V |\n| --- | --- |\n| x | one two |', JSON.stringify(multiline))

const empty = service.turndown('<p>x</p><table></table><p>y</p>')
check('an empty table leaves nothing behind', empty === 'x\n\ny', JSON.stringify(empty))

if (failures) { console.log(`FAIL ${failures} check(s)`); process.exit(1) }
console.log('PASS webfetch table shapes: a simple table is a markdown table; spans, nesting, headless and ragged tables are rows as lines with cells joined by " · "')
