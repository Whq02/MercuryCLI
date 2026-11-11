#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
for (const key of ['MERCURY_EFFORT_LEVEL', 'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const effort = await import('../../src/utils/effort.ts')
const { executeEffort } = await import('../../src/commands/effort/effort.tsx')

const PAIRS: Array<[string, string]> = [['claude-mythos-5-1', 'claude-fable-5-1'], ['claude-mythos-5', 'claude-fable-5'], ['claude-mythos-5-2', 'claude-fable-5-2']]
const MIRRORS = ['claude-mythos-5-1', 'claude-mythos-5']
const line = (id: string): string => `${id} pinned=${effort.isLaunchEffortPinned(id)} default=${String(effort.getDefaultEffortForModel(id))} wire=${String(effort.resolveEffortTruth(id, undefined).wire)}`

section("§1 with no effort set a Mythos mirror runs at its Fable row's launch default (the vendor: each mirror shares its row's specifications; the vendor client's own table gives Mythos 5.1 default_effort high)")
{
  console.log(`  [record] ${PAIRS.flat().map(line).join(' · ')}`)
  for (const [mirror, row] of PAIRS) {
    const m = effort.resolveEffortTruth(mirror, undefined)
    const r = effort.resolveEffortTruth(row, undefined)
    check(`${mirror} resolves ${String(r.wire)} with nothing set, as ${row} does, under that row's launch flag`, m.wire === 'high' && r.wire === 'high' && effort.isLaunchEffortPinned(mirror) && effort.getDefaultEffortForModel(mirror) === effort.getDefaultEffortForModel(row), `${line(mirror)} · ${line(row)}`)
  }
  check('a dated snapshot and the [1m] spelling of each mirror resolve the same', ['claude-mythos-5-1-20260601', 'claude-mythos-5-1[1m]', 'claude-mythos-5-20260115', 'claude-mythos-5[1m]'].every(id => effort.resolveEffortTruth(id, undefined).wire === 'high'), ['claude-mythos-5-1-20260601', 'claude-mythos-5-1[1m]', 'claude-mythos-5-20260115', 'claude-mythos-5[1m]'].map(line).join(' · '))
  check('the rows without a launch default keep theirs: Opus 4.6, Sonnet 4.6 and Haiku 5.5 resolve medium', ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-5-5'].every(id => effort.resolveEffortTruth(id, undefined).wire === 'medium'), ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-5-5'].map(line).join(' · '))
}

type Row = { asked: string; effort: unknown; error: string }
function wire(models: string[], args: string[] = [], env: Record<string, string> = {}): { rows: Row[]; failed: string } {
  const child = spawnSync(process.execPath, [join(import.meta.dir, 'context1mHeaderCapture.ts'), 'key', models.join(','), ...args], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  const found = child.stdout.split('\n').find(row => row.startsWith('CAPTURE '))
  if (found === undefined) return { rows: [], failed: `no capture (exit ${child.status}): ${child.stderr.slice(-600)}` }
  return JSON.parse(found.slice(8)) as { rows: Row[]; failed: string }
}
const shown = (rows: Row[]): string => rows.map(row => `${row.asked}=${String(row.effort)}${row.error ? ` ERROR ${row.error.slice(0, 60)}` : ''}`).join(' · ')

section('§2 on the wire (the loopback Messages fixture): output_config.effort of one request per model')
{
  const bare = wire([...MIRRORS, 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-2'])
  console.log(`  [record] nothing set: ${shown(bare.rows)}`)
  check('nothing set: both mirrors send high, as their Fable rows and Mythos 5.2 do', bare.failed === '' && bare.rows.length === 5 && bare.rows.every(row => row.error === '' && row.effort === 'high'), bare.failed || shown(bare.rows))
  const session = wire(MIRRORS, ['medium'])
  check("an effort the session carries — the saved or the typed one — rides as given: medium", session.failed === '' && session.rows.length === 2 && session.rows.every(row => row.error === '' && row.effort === 'medium'), session.failed || shown(session.rows))
  const env = wire(MIRRORS, [], { MERCURY_EFFORT_LEVEL: 'low' })
  check('MERCURY_EFFORT_LEVEL=low rides as given: low', env.failed === '' && env.rows.length === 2 && env.rows.every(row => row.error === '' && row.effort === 'low'), env.failed || shown(env.rows))
}

section('§3 an effort the operator types releases the launch default for the mirror as for its row')
{
  const said = executeEffort('medium', 'claude-mythos-5-1')
  console.log(`  [record] /effort medium on claude-mythos-5-1: ${JSON.stringify(said.message)}`)
  check('/effort medium is taken with no clause about another tier, and hands the session medium', said.effortUpdate?.value === 'medium' && !said.message.includes('nearest tier'), JSON.stringify(said))
  check('…after it neither mirror is held at its launch default: with the session value gone they resolve the plain default, as their rows do', MIRRORS.every(id => !effort.isLaunchEffortPinned(id)) && !effort.isLaunchEffortPinned('claude-fable-5-1') && MIRRORS.every(id => effort.resolveEffortTruth(id, 'medium').wire === 'medium'), [...MIRRORS, 'claude-fable-5-1'].map(line).join(' · '))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
