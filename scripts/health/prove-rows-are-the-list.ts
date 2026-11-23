#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const LIST = 'src/platform/health/sections.ts'
const FOLDER = 'src/platform/health/sections'
const REPORT = 'src/platform/health/healthReport.ts'

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const { runHealthReport, healthContext, SHELL_READS } = await import('../../src/platform/health/healthReport.ts')
const { HEALTH_SECTIONS } = await import('../../src/platform/health/sections.ts')
const { ENGINE_UNAVAILABLE_CODES } = await import('../../src/platform/health/sections/auth.ts')

type Row = Awaited<ReturnType<(typeof HEALTH_SECTIONS)[number]['checks']>>[number]
const shownAt = (row: Row, depth: 'fast' | 'deep'): boolean => depth === 'deep' || (row.depth ?? 'fast') === 'fast'

section('1. the list: each section once, its rows from its own file, and nothing writes it')
{
  const ids = HEALTH_SECTIONS.map(entry => entry.id)
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i)
  check(`${LIST} names ${ids.length} sections, each once`, ids.length > 0 && twice.length === 0, twice.map(id => `the section '${id}' stands twice in HEALTH_SECTIONS of ${LIST}: keep one entry`))

  const context = await healthContext()
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
    else if ((await entry.checks(context)).length === 0) strays.push(`the section '${entry.id}' returns no row: a section with no row leaves ${LIST}, and a deep section returns its rows at any depth (the runner decides the depth)`)
  }
  check(`every section's function is the one its own file exports, and returns rows (${FOLDER}/<section id>.ts)`, strays.length === 0, strays)

  const thawed = [
    ...(Object.isFrozen(HEALTH_SECTIONS) && HEALTH_SECTIONS.every(entry => Object.isFrozen(entry)) ? [] : [`HEALTH_SECTIONS of ${LIST} or one of its entries is not frozen: wrap the list and each entry in Object.freeze`]),
    ...(Object.isFrozen(SHELL_READS) ? [] : [`SHELL_READS of ${REPORT} is not frozen: wrap it in Object.freeze`]),
    ...(Object.isFrozen(ENGINE_UNAVAILABLE_CODES) ? [] : [`ENGINE_UNAVAILABLE_CODES of ${FOLDER}/auth.ts is not frozen: wrap it in Object.freeze`]),
  ]
  check('the list and the two constants the rows read are frozen: a proof hands runHealthReport a list of its own, nothing writes these', thawed.length === 0, thawed)
}

for (const depth of ['fast', 'deep'] as const) {
  section(`2. a ${depth} certificate holds the rows of the list at that depth, all of them, in the list's order`)
  const cert = await runHealthReport({ depth })
  const context = await healthContext()
  const listed: Array<{ id: string; title: string; rows: string[] }> = []
  for (const entry of HEALTH_SECTIONS) listed.push({ id: entry.id, title: entry.title, rows: (await entry.checks(context)).filter(row => shownAt(row, depth)).map(row => row.id) })
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
      if (rowIndex < 0) inline.push(`the certificate holds the check '${row.id}' in the section '${got.id}' and ${FOLDER}/${got.id}.ts returns no row of that id at the ${depth} depth: runHealthReport built it itself — write the row in that file`)
      else if (rowIndex <= rowAt) order.push(`the check '${row.id}' stands out of its section's order in the certificate`)
      rowAt = Math.max(rowAt, rowIndex)
    }
  }
  const held = cert.sections.reduce((n, got) => n + got.checks.length, 0)
  check(`every section and every check of the ${depth} certificate is a section and a row of the list: runHealthReport builds no check of its own (${cert.sections.length} sections, ${held} checks)`, inline.length === 0 && held > 0, inline)
  check('the certificate keeps the order and the titles of the list', order.length === 0, order)

  const expected = listed.flatMap(entry => entry.rows.map(id => `${entry.id}/${id}`))
  const got = new Set(cert.sections.flatMap(entry => entry.checks.map(row => `${entry.id}/${row.id}`)))
  const missing = expected.filter(key => !got.has(key))
  check(
    `every row of the list whose depth the ${depth} report runs is in the ${depth} certificate (${expected.length})`,
    expected.length > 0 && missing.length === 0,
    missing.map(key => `the row ${key} is in the list and not in the ${depth} certificate: the runner of ${REPORT} dropped it — a row leaves a certificate by its own depth and by nothing else`),
  )
  const deepShown = cert.sections.flatMap(entry => entry.checks.filter(row => depth === 'fast' && row.depth !== 'fast').map(row => `${entry.id}/${row.id}`))
  check(`the ${depth} certificate holds no row of another depth`, deepShown.length === 0, deepShown.map(key => `the row ${key} is deep and stands in the fast certificate`))
}

for (const depth of ['fast', 'deep'] as const) {
  section(`3. a ${depth} report over the list with each row swapped for one that prints a token of its own: every row of the certificate prints its token`)
  const tokens = new Map<string, string>()
  const swapped = HEALTH_SECTIONS.map(entry => ({
    id: entry.id,
    title: entry.title,
    checks: async (context: Parameters<typeof entry.checks>[0]): Promise<Row[]> =>
      (await entry.checks(context)).map(row => {
        const token = `token ${entry.id}/${row.id} ${Math.random().toString(36).slice(2, 10)}`
        tokens.set(`${entry.id}/${row.id}`, token)
        return { ...row, run: () => ({ status: 'ok' as const, evidence: token }) }
      }),
  }))
  const cert = await runHealthReport({ depth }, swapped)
  const context = await healthContext()
  const due: string[] = []
  for (const entry of HEALTH_SECTIONS) for (const row of await entry.checks(context)) if (shownAt(row, depth)) due.push(`${entry.id}/${row.id}`)
  const printed = new Map(cert.sections.flatMap(entry => entry.checks.map(row => [`${entry.id}/${row.id}`, row.evidence] as const)))
  const built: string[] = []
  for (const [key, evidence] of printed) {
    const token = tokens.get(key)
    if (token === undefined) built.push(`the certificate holds the check ${key} and the list handed in returned no row of that id: runHealthReport of ${REPORT} built it itself — write the row in ${FOLDER}/${key.split('/')[0]}.ts`)
    else if (evidence !== token) built.push(`the check ${key} printed '${evidence.slice(0, 90)}' where the row handed in prints '${token}': runHealthReport of ${REPORT} built or replaced that row itself — it runs the rows the list returns, and the row belongs in ${FOLDER}/${key.split('/')[0]}.ts`)
  }
  check(`every check of the ${depth} certificate printed the token of the row the list handed in (${printed.size} checks): runHealthReport runs the list's rows and no row of its own under a listed id`, printed.size > 0 && built.length === 0, built)
  const dropped = due.filter(key => !printed.has(key))
  check(
    `every row handed in at the ${depth} depth printed its token (${due.length} rows)`,
    due.length > 0 && dropped.length === 0,
    dropped.map(key => `the row ${key} was handed in and the ${depth} certificate does not hold it: the runner of ${REPORT} dropped it — a row leaves a certificate by its own depth and by nothing else`),
  )
}

console.log('')
console.log(failures === 0 ? 'prove-rows-are-the-list: the certificate is the list' : `prove-rows-are-the-list: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
