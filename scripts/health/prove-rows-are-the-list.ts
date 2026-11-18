#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const LIST = 'src/utils/health/sections.ts'
const FOLDER = 'src/utils/health/sections'

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const { runHealthReport, healthContext } = await import('../../src/utils/healthReport.ts')
const { HEALTH_SECTIONS } = await import('../../src/utils/health/sections.ts')

section('1. the list: each section once, its rows from its own file')
{
  const ids = HEALTH_SECTIONS.map(entry => entry.id)
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i)
  check(`${LIST} names ${ids.length} sections, each once`, ids.length > 0 && twice.length === 0, twice.map(id => `the section '${id}' stands twice in HEALTH_SECTIONS of ${LIST}: keep one entry`))

  const context = await healthContext('deep')
  const strays: string[] = []
  for (const entry of HEALTH_SECTIONS) {
    const file = `${FOLDER}/${entry.id}.ts`
    let own = 0
    try {
      own = Object.values(await import(`../../${file}`)).filter(value => value === entry.checks).length
    } catch (e) {
      strays.push(`${file} does not load (${e instanceof Error ? e.message.slice(0, 120) : 'error'}): the section '${entry.id}' keeps its rows in that file`)
      continue
    }
    if (own !== 1) strays.push(`the section '${entry.id}' of ${LIST} takes its rows from another place than ${file}: export the section's function from that file and name it in the list`)
    else if (entry.checks(context).length === 0) strays.push(`the section '${entry.id}' returns no row at the deep depth: a section with no row leaves ${LIST}`)
  }
  check(`every section's function is the one its own file exports, and returns rows (${FOLDER}/<section id>.ts)`, strays.length === 0, strays)
}

for (const depth of ['fast', 'deep'] as const) {
  section(`2. a ${depth} certificate holds only rows of the list, in the list's order`)
  const cert = await runHealthReport({ depth })
  const context = await healthContext(depth)
  const listed = HEALTH_SECTIONS.map(entry => ({ id: entry.id, title: entry.title, rows: entry.checks(context).map(row => row.id) }))
  const allRows = listed.flatMap(entry => entry.rows)
  const twice = [...new Set(allRows.filter((id, i) => allRows.indexOf(id) !== i))]
  check(`no row id stands twice in the list at the ${depth} depth (${allRows.length} rows)`, twice.length === 0, twice.map(id => `the row id '${id}' is returned twice: the runner settles a row by its id, so give one of them another id`))

  const inline: string[] = []
  const order: string[] = []
  let at = -1
  for (const got of cert.sections) {
    const index = listed.findIndex(entry => entry.id === got.id)
    const entry = listed[index]
    if (!entry) {
      inline.push(`the certificate holds the section '${got.id}' and ${LIST} lists none of that id: runHealthReport built it itself — give it a file under ${FOLDER}/ and an entry in the list`)
      continue
    }
    if (index <= at) order.push(`the section '${got.id}' stands out of the list's order in the certificate`)
    at = index
    if (got.title !== entry.title) order.push(`the section '${got.id}' is titled '${got.title}' in the certificate and '${entry.title}' in ${LIST}`)
    let rowAt = -1
    for (const row of got.checks) {
      const rowIndex = entry.rows.indexOf(row.id)
      if (rowIndex < 0) inline.push(`the certificate holds the check '${row.id}' in the section '${got.id}' and ${FOLDER}/${got.id}.ts returns no row of that id: runHealthReport built it itself — write the row in that file`)
      else if (rowIndex <= rowAt) order.push(`the check '${row.id}' stands out of its section's order in the certificate`)
      rowAt = Math.max(rowAt, rowIndex)
    }
  }
  const held = cert.sections.reduce((n, got) => n + got.checks.length, 0)
  check(`every section and every check of the ${depth} certificate is a section and a row of the list: runHealthReport builds no check of its own (${cert.sections.length} sections, ${held} checks)`, inline.length === 0 && held > 0, inline)
  check('the certificate keeps the order and the titles of the list', order.length === 0, order)

  const expected = listed.flatMap(entry => entry.rows.map(id => `${entry.id}/${id}`))
  const got = new Set(cert.sections.flatMap(entry => entry.checks.map(row => `${entry.id}/${row.id}`)))
  const missing = depth === 'deep' ? expected.filter(key => !got.has(key)) : []
  check(depth === 'deep' ? `every row of the list is in the deep certificate (${expected.length})` : 'the fast certificate holds no deep row', depth === 'deep' ? missing.length === 0 : cert.sections.every(entry => entry.checks.every(row => row.depth === 'fast')), missing.map(key => `the row ${key} is in the list and not in the deep certificate: the runner dropped it`))
}

console.log('')
console.log(failures === 0 ? 'prove-rows-are-the-list: the certificate is the list' : `prove-rows-are-the-list: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
