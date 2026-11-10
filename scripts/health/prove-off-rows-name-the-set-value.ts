#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SELF = import.meta.path

if (process.argv.includes('--world')) {
  process.env.NODE_ENV = 'test'
  if (process.argv.includes('--readiness')) {
    ;(await import('../../src/utils/config.ts')).enableConfigs()
    const { collectReadiness } = await import('../../src/utils/readiness.ts')
    console.log(JSON.stringify({ rows: Object.fromEntries(collectReadiness().records.map(record => [record.id, String(record.detail)])), deep: {} }))
    process.exit(0)
  }
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

const FLAGS = ['MERCURY_LSP', 'MERCURY_LSP_CPP', 'MERCURY_LSP_PYTHON', 'MERCURY_WORKFLOWS', 'MERCURY_WARDS', 'MERCURY_EVAL', 'MERCURY_CHANGE_RECEIPTS', 'MERCURY_REFS', 'MERCURY_REPO_HOST', 'MERCURY_STRUCTURE', 'MERCURY_STRUCTURE_POLYGLOT', 'MERCURY_SERVICES', 'MERCURY_COMPUTER_USE', 'MERCURY_DAP', 'MERCURY_BROWSER', 'MERCURY_IDE_LOOP']
type World = { rows: Record<string, string>; deep: Record<string, string> }
let worlds = 0
const world = (flags: Record<string, string>, deepProbes: boolean, mode: 'health' | 'readiness' = 'health'): World => {
  const home = join(scratch, `home-${++worlds}`)
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
  for (const name of FLAGS) delete env[name]
  const child = spawnSync(process.execPath, [SELF, '--world', ...(deepProbes ? ['--deep-probes'] : []), ...(mode === 'readiness' ? ['--readiness'] : [])], { cwd, env: { ...env, ...flags }, encoding: 'utf8', timeout: 240_000 })
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

  console.log('\n§4 the readiness rows of the same flags say the same')
  const ready = world({ MERCURY_COMPUTER_USE: 'off', MERCURY_LSP: 'No', MERCURY_DAP: 'false', MERCURY_BROWSER: 'OFF', MERCURY_IDE_LOOP: 'no', MERCURY_WORKFLOWS: 'off' }, false, 'readiness')
  const readySaid: Array<[string, string]> = [
    [ready.rows['tool:computer'] ?? '', 'MERCURY_COMPUTER_USE=off — Computer tool absent from the catalog; no desktop driver is touched'],
    [ready.rows['lane:lsp'] ?? '', 'MERCURY_LSP=No — the IDE-hands bridge is off'],
    [ready.rows['lane:cpp'] ?? '', 'MERCURY_LSP=No — the IDE-hands bridge is off'],
    [ready.rows['lane:dap'] ?? '', 'MERCURY_DAP=false — Debug tool absent from the catalog'],
    [ready.rows['lane:browser'] ?? '', 'MERCURY_BROWSER=OFF — Browser tool absent from the catalog'],
    [ready.rows['engine:ide-plane'] ?? '', 'MERCURY_IDE_LOOP=no — Transaction tool absent, no records written'],
    [ready.rows['engine:workflows'] ?? '', 'MERCURY_WORKFLOWS=off — operator opt-out'],
  ]
  for (const [detail, wanted] of readySaid) check(wanted, detail === wanted, detail)
  const pythonUnderLsp = ready.rows['lane:python'] ?? ''
  check('the Python lane with the bridge off names the bridge: python LSP lanes off (MERCURY_LSP=No)', pythonUnderLsp.includes('python LSP lanes off (MERCURY_LSP=No)') || pythonUnderLsp.startsWith('python unavailable'), pythonUnderLsp)
  const readyLanes = world({ MERCURY_LSP_CPP: 'off', MERCURY_LSP_PYTHON: 'No' }, false, 'readiness')
  check('MERCURY_LSP_CPP=off — clangd lane off', readyLanes.rows['lane:cpp'] === 'MERCURY_LSP_CPP=off — clangd lane off', readyLanes.rows['lane:cpp'] ?? '')
  const python = readyLanes.rows['lane:python'] ?? ''
  check('the Python lane, where a Python stands: python LSP lanes off (MERCURY_LSP_PYTHON=No)', python.includes('python LSP lanes off (MERCURY_LSP_PYTHON=No)') || python.startsWith('python unavailable'), python)
  const readyZero = world({ MERCURY_COMPUTER_USE: '0', MERCURY_LSP: '0', MERCURY_DAP: '0', MERCURY_BROWSER: '0', MERCURY_IDE_LOOP: '0', MERCURY_WORKFLOWS: '0' }, false, 'readiness')
  check('set to 0 the seven read as before, to the byte', readySaid.every(([, wanted]) => Object.values(readyZero.rows).includes(wanted.replace(/=(off|No|false|OFF|no) /, '=0 '))), readySaid.map(([, wanted]) => wanted.replace(/=(off|No|false|OFF|no) /, '=0 ')).filter(wanted => !Object.values(readyZero.rows).includes(wanted)).join(' · '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} off-rows-name-the-set-value: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
