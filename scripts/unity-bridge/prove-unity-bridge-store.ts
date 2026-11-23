#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond ? ' — sections 1 and 2 exercise unityRunToRecord in src/integrations/ide/unityTests.ts and persistTestRun in src/integrations/ide/pythonTests.ts; section 3 runs the unity tool in src/tools/unity/UnityTool.ts, so fix the one the section names' : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

delete process.env.MERCURY_UNITY
delete process.env.MERCURY_UNITY_BRIDGE_PORT
process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'tok'
const scratchHome = mkdtempSync(path.join(tmpdir(), 'unity-bridge-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome

const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
const { parseUnityTestResults, unityRunToRecord } = await import('../../src/integrations/ide/unityTests.js')
const { persistTestRun, testRunsDir } = await import('../../src/integrations/ide/pythonTests.js')
const { unityTestResultsPath } = await import('../../src/integrations/unity-protocol/unityProject.js')
const { UnityTool } = await import('../../src/tools/unity/UnityTool.js')
const { resetUnityBridgeClientForTest } = await import('../../src/integrations/unity/bridgeClient.js')
const { startFakeUnityBridge } = await import('./fake-bridge.js')

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-store-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })

const callTool = async (op: string, args?: Record<string, unknown>): Promise<string> => {
  const r = (await UnityTool.call({ op, ...(args ? { args } : {}) } as never, {} as never)) as {
    data: { result: string }
  }
  return r.data.result
}

section('1. unityRunToRecord — the record shape over a real fixture parse')
{
  const xml = readFileSync(path.join(repo, 'scripts', 'ide', 'fixtures', 'unity', 'editmode-failures.xml'), 'utf8')
  const parsed = parseUnityTestResults(xml)
  check('the failures fixture parses ok', parsed.state === 'ok')
  if (parsed.state === 'ok') {
    const record = unityRunToRecord(parsed, {
      root: proj,
      mode: 'EditMode',
      resultsPath: unityTestResultsPath(proj, 'EditMode'),
      selection: 'all',
      finishedAt: 1_700_000_000_000,
    })
    check('schema 1 + framework unity', record.schema === 1 && record.framework === 'unity')
    check('the id rides the store’s own run- grammar', record.id === 'run-1700000000000-unity' && record.id.startsWith('run-'))
    check('counts carried from the parse', JSON.stringify(record.counts) === JSON.stringify(parsed.counts))
    check('cases + failures carried', record.cases.length === parsed.cases.length && JSON.stringify(record.failures) === JSON.stringify(parsed.failures))
    check('the argv-shaped fields are honestly bridge-shaped', record.command[0] === 'unity-bridge:tests_run' && record.interpreter === 'unity-editor (bridge)' && record.exitCode === null)
    check('cwd is the project root', record.cwd === proj)
    check('startedAt = finishedAt − duration', record.startedAt === 1_700_000_000_000 - record.durationMs)
    check('the verdict note rides through when the parse carries one', (parsed.verdictNote === undefined) === (record.verdictNote === undefined))
  }
}

section('2. the store accepts the record through its own writer')
{
  const xml = readFileSync(path.join(repo, 'scripts', 'ide', 'fixtures', 'unity', 'editmode-pass.xml'), 'utf8')
  const parsed = parseUnityTestResults(xml)
  if (parsed.state === 'ok') {
    const record = unityRunToRecord(parsed, {
      root: proj,
      mode: 'EditMode',
      resultsPath: unityTestResultsPath(proj, 'EditMode'),
      selection: 'all',
    })
    await persistTestRun(proj, record)
    const latest = JSON.parse(readFileSync(path.join(testRunsDir(proj), 'latest.json'), 'utf8')) as { framework: string; counts: { passed: number } }
    check('latest.json carries framework unity + the counts', latest.framework === 'unity' && latest.counts.passed === 3)
    check('the per-run file landed beside it', existsSync(path.join(testRunsDir(proj), `${record.id}.json`)))
    check('the store lives under the config home, never in the project folder', testRunsDir(proj).startsWith(scratchHome) && !existsSync(path.join(proj, '.mercury', 'test-runs')))
  }
}

section('3. end-to-end through the REAL tool — event drain ⇒ store record')
{
  resetUnityBridgeClientForTest()
  process.env.MERCURY_UNITY = '1'
  const fake = await startFakeUnityBridge({ testRunDurationMs: 40 })
  process.env.MERCURY_UNITY_BRIDGE_PORT = String(fake.port)
  await runWithCwdOverride(proj, () => callTool('tests_run', { mode: 'EditMode', testNames: ['Suite.A', 'Suite.B'] }))
  await sleep(120)
  const drain = await runWithCwdOverride(proj, () => callTool('play_state'))
  check('the drain call reports the persist receipt', /test-run record run-\d+-unity persisted/.test(drain), drain.split('\n').slice(-2).join(' '))
  const latest = JSON.parse(readFileSync(path.join(testRunsDir(proj), 'latest.json'), 'utf8')) as {
    framework: string
    selection: string
    counts: { passed: number; failed: number }
    command: string[]
  }
  check('the store record is the bridge run (framework unity, fixture counts)', latest.framework === 'unity' && latest.counts.passed === 3 && latest.counts.failed === 0)
  check('the memo carried the real selection', latest.selection === 'nodes:Suite.A;Suite.B', latest.selection)
  check('the command names the bridge op + the landed results path', latest.command[0] === 'unity-bridge:tests_run' && latest.command[2] === unityTestResultsPath(proj, 'EditMode'))
  await fake.close()
  delete process.env.MERCURY_UNITY_BRIDGE_PORT
  delete process.env.MERCURY_UNITY
  resetUnityBridgeClientForTest()
}


console.log('\n' + (failures === 0 ? '✅ unity-bridge store proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
