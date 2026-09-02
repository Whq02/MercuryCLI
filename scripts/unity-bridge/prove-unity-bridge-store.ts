#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-store.ts
//  PROOF (UB9, the ruled-in store integration): a bridge test run lands in
//  the ONE .mercury/test-runs store through the store's own writer —
//  unityRunToRecord's shape over a real fixture parse, the persist through
//  persistTestRun, the END-TO-END road through the REAL tool (event drain ⇒
//  record), the ADDITIVE-widening edges (the pytest arm byte-unchanged, the
//  id riding the store's own `run-` grammar), and the boundary-sentence
//  re-cuts (a dead constraint left standing is the lie class — the old
//  sentences must be GONE and the refusal contract must still stand).
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

delete process.env.MERCURY_UNITY
delete process.env.MERCURY_UNITY_BRIDGE_PORT
process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'tok'

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { parseUnityTestResults, unityRunToRecord } = await import('../../src/services/ide/unityTests.js')
const { persistTestRun } = await import('../../src/services/ide/pythonTests.js')
const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.js')
const { UnityTool } = await import('../../src/tools/UnityTool/UnityTool.js')
const { resetUnityBridgeClientForTest } = await import('../../src/services/unity/bridgeClient.js')
const { startFakeUnityBridge } = await import('./fake-bridge.js')

const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
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
    const latest = JSON.parse(readFileSync(path.join(proj, '.mercury', 'test-runs', 'latest.json'), 'utf8')) as { framework: string; counts: { passed: number } }
    check('latest.json carries framework unity + the counts', latest.framework === 'unity' && latest.counts.passed === 3)
    check('the per-run file landed beside it', existsSync(path.join(proj, '.mercury', 'test-runs', `${record.id}.json`)))
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
  const latest = JSON.parse(readFileSync(path.join(proj, '.mercury', 'test-runs', 'latest.json'), 'utf8')) as {
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

section('4. the additive-widening edges — the pytest arm byte-unchanged')
{
  const src = readFileSync(path.join(repo, 'src', 'services', 'ide', 'pythonTests.ts'), 'utf8')
  check(
    "TestFramework stays exactly 'pytest' | 'unittest' (the ruling's edge: the widening is a THIRD arm, never a rewrite)",
    src.includes("export type TestFramework = 'pytest' | 'unittest'"),
  )
  check("EngineFramework is the third arm beside the store owner's others", src.includes("export type EngineFramework = 'unity'"))
  check('the record union carries all three arms', src.includes('framework: TestFramework | RunnerFramework | EngineFramework'))
}

section('5. the boundary re-cuts — dead constraints are GONE, the contract stands')
{
  const unityTests = readFileSync(path.join(repo, 'src', 'services', 'ide', 'unityTests.ts'), 'utf8')
  check('unityTests no longer claims the store stays untouched', !unityTests.includes('stay untouched until an in-product'))
  check('unityTests header records the LIVE integration instead', unityTests.includes('THE STORE INTEGRATION IS LIVE'))
  const launchTool = readFileSync(path.join(repo, 'src', 'tools', 'LaunchTool', 'LaunchTool.ts'), 'utf8')
  check("LaunchTool no longer claims in-product executors are 'not this build's' for Unity", !launchTool.includes("are the UNITY-BRIDGE/BLENDER-BRIDGE lanes' seams, not this build's"))
  // The Blender boundary LIFTED when the Blender bridge
  // landed its executor — this pin moved with it (was: 'keeps the Blender
  // boundary' pinning the owns-any sentence).
  check('LaunchTool names BOTH landed executors (Unity tests_run · Blender python_run/render_still)', launchTool.includes("the `Unity` tool's tests_run") && launchTool.includes("`Blender` tool's python_run/render_still"))
  const profiles = readFileSync(path.join(repo, 'src', 'services', 'ide', 'launchProfiles.ts'), 'utf8')
  check('launchProfiles carries no until-the-lane-lands sentence any more', !profiles.includes('until the UNITY-BRIDGE lane lands') && !profiles.includes('owns any future in-product executor seam'))
  // The refusal CONTRACT is untouched: the exported door + its alias stand.
  check('operatorRunRefusal + the compat alias still stand (the contract)', launchTool.includes('export function operatorRunRefusal') && launchTool.includes('export const unityHeadlessRefusal = operatorRunRefusal'))
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge store proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
