#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readImports, type Edge } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-layer-imports.ts'
const WRITE = process.argv.includes('--write')

type Mark = 'load' | 'type'
type Row = { from: string; to: string; mark: Mark; reason: string }
type Rule = { title: string; from: string[]; to: string[]; kept: Array<[string, string]>; end: string }

const LAYERS_TABLE = 'scripts/gate/layer-imports.tsv'
const LAYERS: Rule = {
  title: 'files under src/utils that import from a layer above it',
  from: ['src/utils/'],
  to: ['src/cli/', 'src/commands/', 'src/components/', 'src/daemon/', 'src/services/', 'src/tools/'],
  kept: [
    ['src/components/mercury-ui/sessionAccent.ts', 'its path is the hex exemption of src/utils/wards/wards.ts'],
    ['src/components/mercuryPalette.ts', 'src/guards/wardsGuard.ts knows a Mercury checkout by this path'],
    ['src/tools/BashTool/bashPermissions.ts', 'row 8'],
    ['src/tools/BashTool/denyRuleReach.ts', 'row 8'],
    ['src/utils/accounts/signInLedger.ts', 'shared credential and sign-in state used across src/utils; checks live provider accounts'],
    ['src/utils/accounts/signInRefusal.ts', 'shared credential and sign-in state used across src/utils; checks live provider accounts'],
    ['src/utils/api.ts', 'request-shape helpers read provider route and deferral law for messages/apiPlan.ts and apiView.ts'],
    ['src/utils/artifacts/reviewContracts.ts', 'a type only: CrewActorRef of src/services/crew/identity.ts'],
    ['src/utils/attachments/types.ts', "a type only: FileReadTool's output in the attachment union"],
    ['src/utils/auth.ts', 'shared credential and sign-in state used across src/utils; checks live provider accounts'],
    ['src/utils/backgroundHousekeeping.ts', 'its move up rewrites src/services/health/healthReport.ts, which row 11 holds'],
    ['src/utils/bash/', 'row 8'],
    ['src/utils/capability/manifest.ts', 'prompt and gate capability checks ask DAP, LSP, MCP policy and Godot readiness'],
    ['src/utils/cockpit/harnessMap.ts', 'prompt and gate capability checks ask DAP, LSP, MCP policy and Godot readiness'],
    ['src/utils/cockpit/runtimePosture.ts', 'prompt and gate capability checks ask DAP, LSP, MCP policy and Godot readiness'],
    ['src/utils/git.ts', 'the git utility hands status observation to src/services/gitGraph'],
    ['src/utils/hooks/crewmateRunner.ts', 'hook runners call models and tools for src/utils/hooks/fire.ts, which row 8 imports'],
    ['src/utils/hooks/questionRunner.ts', 'hook runners call models and tools for src/utils/hooks/fire.ts, which row 8 imports'],
    ['src/utils/imageResizer.ts', 'low-level utils checking provider route, env spelling or usage type without owning a service'],
    ['src/utils/messages/apiPlan.ts', 'the message normalizer formats API error, instruction and tool-result blocks'],
    ['src/utils/messages/attachmentText.ts', 'the message normalizer formats API error, instruction and tool-result blocks'],
    ['src/utils/messages/lookups.ts', 'the message normalizer formats API error, instruction and tool-result blocks'],
    ['src/utils/model/agent.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/bareFamilyWords.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/capabilities.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/computedDefault.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/model.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/modelAllowlist.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/modelFamilies.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/modelNames.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/modelOptions.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/modelOverrides.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/modelTransition.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/providerFrontier.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/subModelSlots.ts', 'shared model-id and capability lookup used across src/utils; reads live provider catalogues'],
    ['src/utils/model/utilityModel.ts', 'the utility-model picker reads route law and the local helper id for the hook runners'],
    ['src/utils/normalizeToolSchema.ts', 'low-level utils checking provider route, env spelling or usage type without owning a service'],
    ['src/utils/permissions/decision/', 'row 8'],
    ['src/utils/permissions/flowLaw.ts', 'row 8'],
    ['src/utils/permissions/runtimeProtection.ts', "self-protection reads the live daemon pid and script; row 8's floors call it"],
    ['src/utils/permissions/shellProtectedPaths/', 'row 8'],
    ['src/utils/redactSecrets.ts', 'low-level utils checking provider route, env spelling or usage type without owning a service'],
    ['src/utils/secureStorage/otherBuilds.ts', 'the credential store checks live processes of other Mercury builds before sealing'],
    ['src/utils/sessionStorage/chain.ts', 'the transcript chain strips and restores desktop screenshots through screenshotRetention'],
    ['src/utils/settings/allErrors.ts', 'the settings error list collects MCP config load errors'],
    ['src/utils/spendSpelling.ts', 'low-level utils checking provider route, env spelling or usage type without owning a service'],
    ['src/utils/subprocessEnv.ts', 'low-level utils checking provider route, env spelling or usage type without owning a service'],
    ['src/utils/toolResultSummary.ts', "reads resolved display names from FileReadTool's stateful results WeakMap"],
    ['src/utils/toolSearch.ts', 'formats deferred-tool lines and reads ToolSearch deferral predicates'],
    ['src/utils/vulcan/vulcanGates.ts', 'prompt and gate capability checks ask DAP, LSP, MCP policy and Godot readiness'],
    ['src/utils/wards/', 'row 8'],
    ['src/utils/worktree.ts', 'worktree setup refreshes instruction discovery for the new worktree'],
  ],
  end: 'move the file above down into src/utils/<area> or src/constants when it imports nothing above src/utils itself; move the file under src/utils up into the folder of what it serves when it runs that layer; else hand the value in from its caller',
}

const ENGINE_TABLE = 'scripts/gate/screen-engine-imports.tsv'
const ENGINE: Rule = {
  title: 'files under src/components and src/screens that import a part below a door of the engine (src/run-core/turn-machine.ts over turn/, src/services/engine-connector/daemonConnector.ts over daemon/)',
  from: ['src/components/', 'src/screens/'],
  to: ['src/run-core/turn/', 'src/services/engine-connector/daemon/'],
  kept: [],
  end: 'take what the screen needs from the door, src/run-core/turn-machine.ts or the session connector of src/services/engine-connector/daemonConnector.ts, never from a part below it',
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const under = (file: string, entries: string[]): boolean => entries.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
const keyOf = (row: { from: string; to: string }): string => `${row.from}\t${row.to}`
const lineOf = (row: Row): string => `${row.from}\t${row.to}\t${row.mark}\t${row.reason}`
const reasonOf = (rule: Rule, from: string, to: string): string => rule.kept.find(([entry]) => under(from, [entry]) || under(to, [entry]))?.[1] ?? 'open'
const spoken = (edge: Edge): string => `${edge.from}:${edge.line} → ${edge.to} (${edge.kind})`

console.log('============================================================')
console.log(' Layer imports — a table that only shrinks')
console.log('============================================================')

const { files, known, edges } = readImports(ROOT)

function graphOf(rule: Rule): Map<string, { row: Row; edges: Edge[] }> {
  const out = new Map<string, { row: Row; edges: Edge[] }>()
  for (const edge of edges) {
    if (edge.from === edge.to || !under(edge.from, rule.from) || !under(edge.to, rule.to)) continue
    const held = out.get(keyOf(edge)) ?? { row: { from: edge.from, to: edge.to, mark: 'type' as Mark, reason: reasonOf(rule, edge.from, edge.to) }, edges: [] }
    if (edge.kind !== 'type') held.row.mark = 'load'
    held.edges.push(edge)
    out.set(keyOf(edge), held)
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function tableOf(table: string, rule: Rule): { rows: Row[]; bad: string[] } | null {
  if (!existsSync(join(ROOT, table))) return null
  const rows: Row[] = []
  const bad: string[] = []
  readFileSync(join(ROOT, table), 'utf8').split('\n').forEach((line, i) => {
    if (line === '') return
    const [from = '', to = '', mark = '', reason = '', ...rest] = line.split('\t')
    if (!under(from, rule.from) || !under(to, rule.to) || (mark !== 'load' && mark !== 'type') || reason === '' || rest.length > 0) bad.push(`${table}:${i + 1} is not a file under ${rule.from.join(' ')}, a file under ${rule.to.join(' ')}, load or type, and a reason, between tabs`)
    else if (rows.length > 0 && keyOf(rows[rows.length - 1]!) >= keyOf({ from, to })) bad.push(`${table}:${i + 1} is out of path order or stands twice`)
    else rows.push({ from, to, mark, reason })
  })
  return { rows, bad }
}

function stoodInGit(table: string): boolean {
  const read = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%H', '--', table], { encoding: 'utf8' })
  return read.status !== 0 || read.stdout.trim() !== ''
}

function hold(table: string, rule: Rule): void {
  section(`${table}: ${rule.title}`)
  const graph = graphOf(rule)
  const stands = tableOf(table, rule)
  const misplaced = rule.kept.filter(([entry], i) => i > 0 && rule.kept[i - 1]![0] >= entry)
  const dead = rule.kept.filter(([entry]) => (entry.endsWith('/') ? !files.some(file => file.startsWith(entry)) : !known.has(entry)))
  check(`KEPT in ${SELF} names ${rule.kept.length} files and folders that stand, in path order`, misplaced.length === 0 && dead.length === 0, [
    ...misplaced.map(([entry]) => `${entry} is out of place: put KEPT in ${SELF} in path order`),
    ...dead.map(([entry]) => `${entry} names nothing under src/: delete its entry from KEPT in ${SELF}`),
  ])

  if (stands === null) {
    const first = !stoodInGit(table)
    if (WRITE && first) {
      writeFileSync(join(ROOT, table), [...graph.values()].map(({ row }) => lineOf(row) + '\n').join(''))
      check(`${table} written for the first time: ${graph.size} rows`, true)
    } else {
      check(`${table} stands`, false, [first ? `no table: bun ${SELF} --write writes the first one` : `no table: put the table of the last commit back (git checkout -- ${table}); --write writes the first table only where git never held one`])
    }
    return
  }
  check(`${table} reads as rows of a file, a file above it, load or type, and a reason, in path order: ${stands.rows.length} rows`, stands.bad.length === 0, [...stands.bad.slice(0, 12), `bun ${SELF} --write writes the table from the import graph once it reads`])
  if (stands.bad.length > 0) return

  const stood = new Map(stands.rows.map(row => [keyOf(row), row]))
  const gone = stands.rows.filter(row => !graph.has(keyOf(row)))
  const carried = new Map<string, Row>()
  for (const [key, { row }] of graph) {
    if (stood.has(key)) continue
    const old = gone.find(was => ![...carried.values()].includes(was) && ((was.to === row.to && !known.has(was.from) && basename(was.from) === basename(row.from)) || (was.from === row.from && !known.has(was.to) && basename(was.to) === basename(row.to))))
    if (old) carried.set(key, old)
  }
  const added = [...graph.entries()].filter(([key]) => !stood.has(key) && !carried.has(key))
  const raised = [...graph.entries()].filter(([key, { row }]) => (stood.get(key) ?? carried.get(key))?.mark === 'type' && row.mark === 'load')
  const misread = stands.rows.filter(row => graph.has(keyOf(row)) && row.reason !== graph.get(keyOf(row))!.row.reason)
  const dropped = gone.filter(row => ![...carried.values()].includes(row))

  check(`no import from a file under ${rule.from.join(' ')} to a file under ${rule.to.join(' ')} stands without its row: ${graph.size} pairs in the graph`, added.length === 0, [
    ...added.slice(0, 20).flatMap(([, { edges: held }]) => held.map(spoken)),
    ...(added.length > 20 ? [`and ${added.length - 20} more pairs`] : []),
    `${rule.end}; ${table} only shrinks and bun ${SELF} --write adds no row`,
  ])
  check(`no row marked type loads its file at run time`, raised.length === 0, [
    ...raised.slice(0, 20).flatMap(([, { edges: held }]) => held.filter(edge => edge.kind !== 'type').map(spoken)),
    `take the type alone with import type, or ${rule.end}; --write turns no type row into load`,
  ])
  if (!WRITE)
    check(`every row's reason is the one KEPT in ${SELF} gives it`, misread.length === 0, [
      ...misread.slice(0, 12).map(row => `${row.from} → ${row.to} says ${row.reason}, KEPT says ${graph.get(keyOf(row))!.row.reason}`),
      `bun ${SELF} --write writes the reasons KEPT gives`,
    ])

  if (WRITE && failures === 0) {
    writeFileSync(join(ROOT, table), [...graph.values()].map(({ row }) => lineOf(row) + '\n').join(''))
    console.log(`  written: ${graph.size} rows; ${dropped.length} dropped, ${carried.size} carried to a renamed file, ${stands.rows.filter(row => row.mark === 'load' && graph.get(keyOf(row))?.row.mark === 'type').length} lowered to type`)
  } else if (WRITE) console.log(`  nothing written: ${table} stays as it stands`)
  else {
    if (dropped.length > 0) console.log(`  rows of imports that are gone: ${dropped.length} (bun ${SELF} --write drops them)`)
    if (carried.size > 0) console.log(`  rows that follow a renamed file: ${carried.size} (bun ${SELF} --write writes their new paths)`)
  }
  const rows = [...graph.values()]
  const by = (pick: (row: Row) => string): string => [...new Set(rows.map(({ row }) => pick(row)))].sort().map(name => `${name} ${rows.filter(({ row }) => pick(row) === name).length}`).join(', ')
  console.log(`  the graph: ${rows.length} rows (${by(row => row.mark)}) for ${rows.reduce((sum, { edges: held }) => sum + held.length, 0)} import lines; by layer: ${by(row => rule.to.find(entry => under(row.to, [entry]))!.replace(/^src\/|\/$/g, ''))}; by reason: ${by(row => row.reason)}`)
}

hold(LAYERS_TABLE, LAYERS)
hold(ENGINE_TABLE, ENGINE)

console.log('')
console.log(failures === 0 ? `prove-layer-imports: ALL HOLD — ${checks} checks` : `prove-layer-imports: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
