import './webfetchFixtureDns.ts'
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.js')
const { clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.js')
const fixture = async (name: string) => Bun.file(new URL(`./fixtures/webfetch/${name}.html`, import.meta.url)).text()
const pages: Record<string, string> = {
  '/3/library/stdtypes.html': await fixture('sphinx-stdtypes'),
  '/3/library/datetime.html': await fixture('sphinx-datetime'),
  '/datatype3.html': await fixture('sqlite-datatype3'),
  '/changes-4.2.html': await fixture('layout-table'),
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.headers.get('x-fixture-url')!)
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /')
  const page = pages[url.pathname]
  return page === undefined ? new Response('missing', { status: 404 }) : new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
} })
const get = axios.get.bind(axios)
axios.get = ((url: string, options: { headers?: object }) => {
  assert.equal(new URL(url).hostname, 'fixture.example', 'no request may escape the fixture')
  return get(`http://127.0.0.1:${server.port}/`, { ...options, proxy: false, headers: { ...options.headers, 'x-fixture-url': url } })
}) as typeof axios.get

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `\n${detail}`}`)
}
const fetched = async (path: string): Promise<{ text: string; lines: string[]; window: number; shown: number; total: number; ended: boolean }> => {
  const result = await WebFetchTool.call({ url: `https://fixture.example${path}` }, { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never)
  assert.ok('data' in result, `the fetch of ${path} answered`)
  const whole = result.data.result
  const trailer = /\[Page text: characters (\d+)–(\d+); (\d+) of (\d+) characters shown;[^\]]*; (end of page|the page continues[^\]]*)\.\]\n\n/.exec(whole)
  assert.ok(trailer !== null, `the result of ${path} carries the character window:\n${whole.slice(0, 400)}`)
  const text = whole.slice(trailer.index + trailer[0].length)
  return { text, lines: text.split('\n'), window: Number(trailer[2]) - Number(trailer[1]), shown: Number(trailer[3]), total: Number(trailer[4]), ended: trailer[5] === 'end of page' }
}
const rowWith = (lines: string[], ...cells: string[]) => lines.find(line => /^(?:> )?\|/.test(line) && cells.every(cell => line.includes(cell)))

try {
  clearWebFetchCache()
  const stdtypes = await fetched('/3/library/stdtypes.html')
  check('a Sphinx page (div.document > div.body) comes through from its first heading', stdtypes.text.includes('Built-in Types') && stdtypes.text.includes('The following sections describe the standard types that are built into the interpreter.'), stdtypes.text.slice(0, 300))
  for (const heading of ['Truth Value Testing', 'Comparisons', 'Numeric Types', 'Text Sequence Type', 'String Methods', 'Format Specification Mini-Language', 'Special Attributes']) {
    check(`the section "${heading}" is in the page`, stdtypes.lines.some(line => /^#{1,3} /.test(line) && line.includes(heading)))
  }
  check('the page ends with its last section, after every table', stdtypes.text.includes('of the class, function, method, descriptor, or generator instance.') && stdtypes.text.includes('Added in version 3.3.'), stdtypes.text.slice(-300))
  check('the presentation-type table keeps its header row with the columns on one line', rowWith(stdtypes.lines, 'Type', 'Meaning', 'Notes') !== undefined)
  check("the 'g' row is one line with its three cells, not the whole page", rowWith(stdtypes.lines, "'g'", 'Floating-point format', 'regardless of the precision', '(4)') !== undefined, stdtypes.lines.filter(line => line.includes("'g'")).join('\n'))
  check('the operations table rows keep their cells on one line', rowWith(stdtypes.lines, 'abs(x)', 'absolute value or magnitude') !== undefined && rowWith(stdtypes.lines, '`x` `//` `y`', 'floored quotient', '(1)(2)') !== undefined, stdtypes.lines.filter(line => line.includes('floored') || line.includes('abs(x)')).join('\n'))
  check('the method definitions around the tables survive', stdtypes.text.includes('Return a casefolded copy of the string.') && stdtypes.text.includes('Perform a string formatting operation.'))
  check('the chrome stays out: navigation, sidebar and footer', !stdtypes.text.includes('Quick search') && !stdtypes.text.includes('Previous topic') && !stdtypes.text.includes('Python Software Foundation'))
  check('the character window names the text returned', stdtypes.window === stdtypes.text.length && stdtypes.shown === stdtypes.text.length && stdtypes.total === stdtypes.text.length && stdtypes.ended, `window ${stdtypes.window} shown ${stdtypes.shown} total ${stdtypes.total} text ${stdtypes.text.length}`)

  const datetime = await fetched('/3/library/datetime.html')
  check('the datetime page comes through from its heading', datetime.text.includes('Basic date and time types') && datetime.text.includes('module supplies classes for manipulating dates and times.'), datetime.text.slice(0, 300))
  check('the sections before the format-code table are in the page', datetime.text.includes('Aware and Naive Objects') && datetime.text.includes('object represents a duration, the difference between two'))
  check('the %U row is one line with its four cells', rowWith(datetime.lines, '%U', 'Week number of the year (Sunday as the first day of the week)', '00, 01, …, 53', '(7), (9)') !== undefined, datetime.lines.filter(line => line.includes('%U')).join('\n'))
  check('the format-code table keeps every directive row', ['%a', '%Y', '%z', '%%'].every(directive => rowWith(datetime.lines, directive) !== undefined))
  check('the notes after the table are in the page', datetime.text.includes('Because the format depends on the current locale'))
  check('the datetime character window names the text returned', datetime.window === datetime.text.length && datetime.total === datetime.text.length && datetime.ended)

  const sqlite = await fetched('/datatype3.html')
  check('a page without a landmark (sqlite.org) comes through whole, its menus out', sqlite.text.includes('Datatypes In SQLite') && sqlite.text.includes('Most SQL database engines') && sqlite.text.includes('This page last modified') && !sqlite.text.includes('Choose any three') && !sqlite.text.includes('Purchase'), sqlite.text.slice(0, 300))
  check('its headings and its affinity table are in the page', sqlite.text.includes('Storage Classes and Datatypes') && sqlite.text.includes('Determination Of Column Affinity') && rowWith(sqlite.lines, 'VARCHAR(255)', 'TEXT') !== undefined, sqlite.lines.filter(line => line.includes('VARCHAR')).join('\n'))
  check('the sqlite character window names the text returned', sqlite.window === sqlite.text.length && sqlite.total === sqlite.text.length && sqlite.ended)

  const layout = await fetched('/changes-4.2.html')
  check('a page laid out as a table still answers its content cell, the link column out', layout.text.includes('Release notes for the 4.2 line') && layout.text.includes('Nothing in the file formats moved.') && !layout.text.includes('Mirrors'), layout.text.slice(0, 300))
} finally {
  axios.get = get
  server.stop(true)
  clearWebFetchCache()
}
if (failures) {
  console.log(`FAIL webfetch documentation pages: ${failures} check(s)`)
  process.exit(1)
}
console.log('PASS webfetch documentation pages: a Sphinx page with tables comes through whole as markdown, a table cell never stands in for its document, and the character window names the text returned')
