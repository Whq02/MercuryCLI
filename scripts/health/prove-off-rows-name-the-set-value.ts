#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SELF = import.meta.path

if (process.argv.includes('--world')) {
  process.env.NODE_ENV = 'test'
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const rows = Object.fromEntries(cert.sections.flatMap(section => section.checks).map(row => [row.id, row.id === 'anvil-workbench-fast' ? String((row as { detail?: string }).detail) : String(row.evidence)]))
  let deep: Record<string, string> = {}
  if (process.argv.includes('--deep-probes')) {
    const probes = await import('../../src/utils/healthDeepProbes.js')
    deep = { changeReceipts: String((await probes.probeChangeTransaction()).evidence), services: String((await probes.probeServiceLifecycle()).evidence) }
  }
  console.log(JSON.stringify({ rows, deep }))
  process.exit(0)
}

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'off-rows-')))
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}

const FLAGS = ['MERCURY_LSP', 'MERCURY_LSP_CPP', 'MERCURY_WORKFLOWS', 'MERCURY_WARDS', 'MERCURY_EVAL', 'MERCURY_CHANGE_RECEIPTS', 'MERCURY_REFS', 'MERCURY_REPO_HOST', 'MERCURY_STRUCTURE', 'MERCURY_STRUCTURE_POLYGLOT', 'MERCURY_SERVICES']
type World = { rows: Record<string, string>; deep: Record<string, string> }
let worlds = 0
const world = (flags: Record<string, string>, deepProbes: boolean): World => {
  const home = join(scratch, `home-${++worlds}`)
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
  for (const name of FLAGS) delete env[name]
  const child = spawnSync(process.execPath, [SELF, '--world', ...(deepProbes ? ['--deep-probes'] : [])], { cwd, env: { ...env, ...flags }, encoding: 'utf8', timeout: 240_000 })
  const line = child.stdout.trim().split('\n').at(-1) ?? ''
  if (child.status !== 0 || !line.startsWith('{')) throw new Error(`the health report did not answer: rc ${child.status}\n${child.stdout.slice(-600)}\n${child.stderr.slice(-600)}`)
  return JSON.parse(line) as World
}

try {
  console.log('§1 each row names the word that turned its flag off')
  const words = world({ MERCURY_LSP: 'off', MERCURY_WORKFLOWS: 'false', MERCURY_WARDS: 'no', MERCURY_EVAL: 'OFF', MERCURY_CHANGE_RECEIPTS: 'off', MERCURY_REFS: 'False', MERCURY_REPO_HOST: 'no', MERCURY_STRUCTURE_POLYGLOT: 'off', MERCURY_SERVICES: 'No' }, true)
  const said: Array<[string, string, string]> = [
    ['the IDE-hands row', words.rows.lsp ?? '', 'MERCURY_LSP=off — IDE-hands bridge disabled by flag'],
    ['the workflows row', words.rows.workflows ?? '', 'MERCURY_WORKFLOWS=false — the workflow engine is disabled'],
    ['the wards row', words.rows.wards ?? '', 'MERCURY_WARDS=no set — content wards off for this session'],
    ['the Eval row', words.rows['eval-kernels'] ?? '', 'MERCURY_EVAL=OFF — the Eval tool is out of the catalogue'],
    ['the change-receipts row', words.rows['change-receipts-fast'] ?? '', 'MERCURY_CHANGE_RECEIPTS=off'],
    ['the references row', words.rows['resource-plane-fast'] ?? '', 'MERCURY_REFS=False'],
    ['the services row', words.rows['services-fast'] ?? '', 'MERCURY_SERVICES=No'],
    ["the deep report's change-receipts probe", words.deep.changeReceipts ?? '', 'change transactions disabled (MERCURY_CHANGE_RECEIPTS=off)'],
    ["the deep report's services probe", words.deep.services ?? '', 'project services disabled (MERCURY_SERVICES=No)'],
  ]
  for (const [label, evidence, wanted] of said) check(`${label}: ${wanted}`, evidence === wanted, evidence)
  const workbench = words.rows['anvil-workbench-fast'] ?? ''
  check("the workbench row's detail: repo host: OFF (MERCURY_REPO_HOST=no)", workbench.includes('repo host: OFF (MERCURY_REPO_HOST=no)'), workbench)
  check('…and AstSearch and AstEdit: OFF (MERCURY_STRUCTURE_POLYGLOT=off)', workbench.includes('AstSearch and AstEdit: OFF (MERCURY_STRUCTURE_POLYGLOT=off)'), workbench)
  check('no row of the nine says =0 for a flag that was not set to 0', ![...said.map(([, evidence]) => evidence), workbench].some(evidence => /MERCURY_[A-Z_]+=0\b/.test(evidence)), [...said.map(([, evidence]) => evidence), workbench].filter(evidence => /MERCURY_[A-Z_]+=0\b/.test(evidence)).join(' · '))

  console.log('\n§2 a flag set to 0 reads as before, to the byte')
  const zero = world(Object.fromEntries(['MERCURY_LSP', 'MERCURY_WORKFLOWS', 'MERCURY_WARDS', 'MERCURY_EVAL', 'MERCURY_CHANGE_RECEIPTS', 'MERCURY_REFS', 'MERCURY_REPO_HOST', 'MERCURY_STRUCTURE_POLYGLOT', 'MERCURY_SERVICES'].map(name => [name, '0'])), true)
  const before: Array<[string, string]> = [
    [zero.rows.lsp ?? '', 'MERCURY_LSP=0 — IDE-hands bridge disabled by flag'],
    [zero.rows.workflows ?? '', 'MERCURY_WORKFLOWS=0 — the workflow engine is disabled'],
    [zero.rows.wards ?? '', 'MERCURY_WARDS=0 set — content wards off for this session'],
    [zero.rows['eval-kernels'] ?? '', 'MERCURY_EVAL=0 — the Eval tool is out of the catalogue'],
    [zero.rows['change-receipts-fast'] ?? '', 'MERCURY_CHANGE_RECEIPTS=0'],
    [zero.rows['resource-plane-fast'] ?? '', 'MERCURY_REFS=0'],
    [zero.rows['services-fast'] ?? '', 'MERCURY_SERVICES=0'],
    [zero.deep.changeReceipts ?? '', 'change transactions disabled (MERCURY_CHANGE_RECEIPTS=0)'],
    [zero.deep.services ?? '', 'project services disabled (MERCURY_SERVICES=0)'],
  ]
  check('the nine sentences are the ones a 0 has always read', before.every(([evidence, wanted]) => evidence === wanted), before.filter(([evidence, wanted]) => evidence !== wanted).map(([evidence]) => evidence).join(' · '))
  const zeroBench = zero.rows['anvil-workbench-fast'] ?? ''
  check('the workbench row keeps both of its clauses', zeroBench.includes('repo host: OFF (MERCURY_REPO_HOST=0)') && zeroBench.includes('AstSearch and AstEdit: OFF (MERCURY_STRUCTURE_POLYGLOT=0)'), zeroBench)

  console.log('\n§3 a lane turned off by its own flag, and a feature turned off by the flag above it, name that flag')
  const lanes = world({ MERCURY_LSP_CPP: 'off', MERCURY_STRUCTURE: 'off' }, false)
  check('the IDE-hands row with the C++ lane off: cpp lane off (MERCURY_LSP_CPP=off)', (lanes.rows.lsp ?? '').includes('cpp lane off (MERCURY_LSP_CPP=off)'), lanes.rows.lsp ?? '')
  const lanesBench = lanes.rows['anvil-workbench-fast'] ?? ''
  check('the workbench row with the structure tools off names MERCURY_STRUCTURE=off, not a flag nobody set', lanesBench.includes('AstSearch and AstEdit: OFF (MERCURY_STRUCTURE=off)') && !lanesBench.includes('MERCURY_STRUCTURE_POLYGLOT'), lanesBench)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} off-rows-name-the-set-value: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
