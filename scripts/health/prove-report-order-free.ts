#!/usr/bin/env bun
import { mock } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Depth = 'fast' | 'deep'
type Mode = 'list' | 'reversed' | 'rotated'
const FIELDS = ['section', 'label', 'status', 'evidence', 'detail', 'fix', 'link', 'probe', 'depth'] as const
type RowWords = Record<(typeof FIELDS)[number], string | null>
interface Run {
  mode: Mode
  depth: Depth
  handed: string[]
  called: string[]
  certOrder: string[]
  rows: Record<string, RowWords>
}

const ROTATE = 11
const FOLDER = 'src/platform/health/sections'
const PLANTED = 'op-planted.json'

if (process.argv[2] === '--child') {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const mode = process.argv[3] as Mode
  const depth = process.argv[4] as Depth
  const planted = process.argv[6] === PLANTED
  if (planted) {
    const { changeSetJournalDir } = await import('../../src/tools/engines/change-transaction/changeSetContracts.ts')
    mkdirSync(changeSetJournalDir(), { recursive: true })
    writeFileSync(join(changeSetJournalDir(), PLANTED), 'not an operation')
  }
  const sweep = await import('../../src/daemon/process-sweep/processSweepRun.ts')
  const { readMercuryProcesses } = sweep
  mock.module('../../src/daemon/process-sweep/processSweepRun.ts', () => ({
    ...sweep,
    readMercuryProcesses: () => readMercuryProcesses({ collect: async () => ({ complete: true, observations: [] }) }),
  }))
  const { HEALTH_SECTIONS } = await import('../../src/platform/health/sections.ts')
  const { runHealthReport } = await import('../../src/platform/health/healthReport.ts')
  const inOrder = [...HEALTH_SECTIONS]
  const ordered = mode === 'reversed' ? [...inOrder].reverse() : mode === 'rotated' ? [...inOrder.slice(ROTATE), ...inOrder.slice(0, ROTATE)] : inOrder
  const called: string[] = []
  const handed = ordered
    .filter(entry => !planted || entry.id === 'durability')
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      checks: async (context: Parameters<typeof entry.checks>[0]) => {
        called.push(entry.id)
        const rows = await entry.checks(context)
        return planted ? rows.filter(row => row.id === 'durable-journals' || row.id === 'store-quarantines').reverse() : rows
      },
    }))
  const cert = await runHealthReport({ depth }, handed)
  const rows: Record<string, RowWords> = {}
  for (const section of cert.sections) {
    for (const row of section.checks) {
      rows[row.id] = { section: section.id, label: row.label, status: row.status, evidence: row.evidence, detail: row.detail ?? null, fix: row.fix ?? null, link: row.link ?? null, probe: row.probe ?? null, depth: row.depth ?? null }
    }
  }
  const run: Run = { mode, depth, handed: handed.map(entry => entry.id), called, certOrder: cert.sections.map(section => section.id), rows }
  writeFileSync(process.argv[5]!, JSON.stringify(run))
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const MASKS: Array<[string | null, (typeof FIELDS)[number], RegExp, string]> = [
  ['activity', 'evidence', /last headless (\S+)/, 'when the last headless verb ran'],
  ['resources', 'evidence', /(\d+)MB available/, 'the free memory of this machine at that second'],
  ['resources', 'evidence', /load ([\d.]+)\/core/, 'the load of this machine at that second'],
  ['seats', 'evidence', /(\d+) GB available/, 'the free memory of this machine at that second'],
  ['mercury-processes', 'evidence', /^([\s\S]*)$/, 'the other Mercury processes on this machine'],
  ['mercury-processes', 'detail', /^([\s\S]*)$/, 'the other Mercury processes on this machine'],
  ['js-debugger', 'evidence', /127\.0\.0\.1:(\d+)/, 'the port the operating system handed out'],
  ['iface-computer-use', 'detail', /frontmost: ([^\n]+)/, 'the application in front at that second'],
  ['config-home', 'evidence', /keychain …(\S+)/, 'the keychain suffix of the scratch home'],
  ['memory', 'evidence', /\/projects\/([^/\s]+)\/memory\//, "the project's memory folder, which the store names after the project's path with every separator turned to a dash: each run has a folder of its own"],
  [null, 'evidence', /last write (\d+)s ago/g, 'seconds since a write'],
  [null, 'evidence', /last rollup (\d+)s ago/g, 'seconds since a rollup'],
  [null, 'evidence', /(\d+)s old/g, 'an age in seconds'],
]

const scratch = mkdtempSync(join(tmpdir(), 'health-order-'))

async function runOrder(mode: Mode, depth: Depth, name: string, plant = ''): Promise<{ run: Run | null; places: string[]; why: string }> {
  const root = join(scratch, `${depth}-${name}`)
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const out = join(root, 'run.json')
  const places = [...new Set([home, cwd, realpathSync(home), realpathSync(cwd)])].sort((a, b) => b.length - a.length)
  const child = spawn(process.execPath, [import.meta.path, '--child', mode, depth, out, plant], { cwd, env: { ...process.env, MERCURY_CONFIG_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  child.stdout.on('data', chunk => (said += String(chunk)))
  child.stderr.on('data', chunk => (said += String(chunk)))
  const deadline = setTimeout(() => child.kill('SIGKILL'), 180_000)
  const code = await new Promise<number | null>(resolve => child.on('close', resolve))
  clearTimeout(deadline)
  try {
    return { run: JSON.parse(readFileSync(out, 'utf8')) as Run, places, why: '' }
  } catch {
    return { run: null, places, why: `the ${mode} ${depth} run wrote no report (exit ${code}): ${said.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` }
  }
}

function words(row: RowWords, id: string, field: (typeof FIELDS)[number], places: string[]): string | null {
  let text = row[field]
  if (text === null) return null
  for (const place of places) text = text.split(place).join('<scratch>')
  for (const [rowId, maskField, pattern] of MASKS) {
    if ((rowId !== null && rowId !== id) || maskField !== field) continue
    text = text.replace(pattern, (whole: string, masked: string) => whole.replace(masked, '<masked>'))
  }
  return text
}

function differences(a: { run: Run; places: string[] }, b: { run: Run; places: string[] }): Array<{ id: string; field: string; a: string; b: string }> {
  const out: Array<{ id: string; field: string; a: string; b: string }> = []
  for (const id of [...new Set([...Object.keys(a.run.rows), ...Object.keys(b.run.rows)])].sort()) {
    const x = a.run.rows[id]
    const y = b.run.rows[id]
    if (x === undefined || y === undefined) {
      out.push({ id, field: 'present', a: String(x !== undefined), b: String(y !== undefined) })
      continue
    }
    for (const field of FIELDS) {
      const u = words(x, id, field, a.places)
      const v = words(y, id, field, b.places)
      if (u !== v) out.push({ id, field, a: String(u), b: String(v) })
    }
  }
  return out
}

const cut = (text: string, other: string): string => {
  let at = 0
  while (at < text.length && text[at] === other[at]) at++
  return `${at > 30 ? '…' : ''}${text.slice(Math.max(0, at - 30), at + 110)}`
}

for (const depth of ['fast', 'deep'] as const) {
  section(`the ${depth} report with the list in its order (twice), reversed, and rotated by ${ROTATE}: each in a fresh process, a fresh home and a fresh folder${depth === 'deep' ? ', one at a time (the deep probes start services and debuggers)' : ''}`)
  const orders: Array<[Mode, string]> = [['list', 'list-a'], ['list', 'list-b'], ['reversed', 'reversed'], ['rotated', 'rotated']]
  const settledRuns: Array<Awaited<ReturnType<typeof runOrder>>> = []
  if (depth === 'fast') settledRuns.push(...(await Promise.all(orders.map(([mode, name]) => runOrder(mode, depth, name)))))
  else for (const [mode, name] of orders) settledRuns.push(await runOrder(mode, depth, name))
  const [first, second, reversed, rotated] = settledRuns as [Awaited<ReturnType<typeof runOrder>>, Awaited<ReturnType<typeof runOrder>>, Awaited<ReturnType<typeof runOrder>>, Awaited<ReturnType<typeof runOrder>>]
  const runs = [first, second, reversed, rotated]
  const silent = runs.filter(entry => entry.run === null).map(entry => entry.why)
  check(`four ${depth} reports ran`, silent.length === 0, [...silent, 'the child process of this file (run with --child) died before it wrote its report: read its last output above, and look at runHealthReport in src/platform/health/healthReport.ts and the section list in src/platform/health/sections.ts that the child loads'])
  if (first.run === null || second.run === null || reversed.run === null || rotated.run === null) continue
  const ran = runs.flatMap(entry => (entry.run !== null && entry.run.called.join(' ') !== entry.run.handed.join(' ') ? [`the ${entry.run.mode} run handed the report ${entry.run.handed.length} sections (${entry.run.handed[0]} first) and the report called ${entry.run.called.length} of them (${entry.run.called[0] ?? 'none'} first): runHealthReport of src/platform/health/healthReport.ts takes the list of sections as its second argument and runs that list in the order handed`] : []))
  check(`the report ran the list it was handed, in the order handed (${first.run.handed[0]} first, ${reversed.run.handed[0]} first, ${rotated.run.handed[0]} first)`, ran.length === 0, ran)

  const control = differences({ run: first.run, places: first.places }, { run: second.run, places: second.places })
  check(
    `${depth}: two runs with the list in its own order print the same, row for row (${Object.keys(first.run.rows).length} rows; ${MASKS.length} masked places and each run's own folders aside)`,
    control.length === 0,
    control.flatMap(d => [
      `the row '${d.id}' prints another ${d.field} in a second run of the same order: the row is not steady on this machine, and nothing is set aside for it — make the row print the same, or add its moving part to MASKS in this file with the reason`,
      `   first run: ${cut(d.a, d.b)}`,
      `   second run: ${cut(d.b, d.a)}`,
    ]),
  )
  for (const other of [reversed, rotated]) {
    const found = differences({ run: first.run, places: first.places }, { run: other.run!, places: other.places })
    check(
      `${depth}: every row prints the same by id with the list ${other.run!.mode}${other.run!.mode === 'rotated' ? ` by ${ROTATE}` : ''} (${Object.keys(first.run.rows).length} rows)`,
      Object.keys(first.run.rows).length > 100 && found.length === 0,
      found.flatMap(d => [
        `the row '${d.id}' prints another ${d.field} when its section runs in another place: it reads what another row settled or left behind — in its file under ${FOLDER}/, settle what the row reads before it reads it (the runner keeps no order between rows beyond starting the deep ones after the fast ones)`,
        `   in the list's order: ${cut(d.a, d.b)}`,
        `   ${other.run!.mode}: ${cut(d.b, d.a)}`,
      ]),
    )
  }
}

section('a row settles what it reads: an undecodable journal file in the home is named by the Store quarantines row of the same report, with that row started first (the two rows handed alone, in that order)')
{
  const planted = await runOrder('list', 'fast', 'refused-journal', PLANTED)
  const quarantines = planted.run?.rows['store-quarantines']
  const journals = planted.run?.rows['durable-journals']
  check(
    'the Store quarantines row, started before the Operation journals row has read the folder, names the file in that same report',
    journals?.status === 'ok' && quarantines?.status === 'warn' && quarantines.evidence?.startsWith('1 damaged-store event(s) in the last 24h (1 on the ledger) — latest: operation-journal (') === true && quarantines.evidence.includes(`${PLANTED} is not a decodable operation`) && quarantines.evidence.endsWith(', bytes left in place'),
    planted.run === null
      ? [planted.why]
      : [
          `the row 'store-quarantines' read the recovery ledger before the journal scan had written the refusal to it: in ${FOLDER}/durability.ts the row awaits the scan it shares with 'durable-journals' (journalScan) before it reads the ledger`,
          `   store-quarantines: ${quarantines?.status}: ${quarantines?.evidence}`,
          `   durable-journals: ${journals?.status}: ${journals?.evidence}`,
        ],
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? 'prove-report-order-free: the order of the list is free' : `prove-report-order-free: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
