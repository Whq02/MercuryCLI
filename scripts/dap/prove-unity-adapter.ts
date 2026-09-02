#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-unity-adapter.ts
//  PROOF: the `unity` attach-to-editor debug row (MERCURY_UNITY opt-in).
//
//   §1  opt-in polarity: disarmed ⇒ no row, no known key, no dormant hint,
//       no readiness rows (lane:unity + lane:dap:unity both absent).
//   §2  resolver rungs over fixture trees: pin honesty (broken pin refuses
//       BY NAME) · vstuc extension dirs newest-first · the ~/.unity-dap
//       unpack spot · both-roads remedy when absent · the dotnet-SDK
//       refusal when the dll exists but dotnet does not.
//   §3  the documented port law: 56000 + (pid % 1000).
//   §4  Library/EditorInstance.json → endpoint (absent/malformed/foreign ⇒
//       the teaching line, never a throw).
//   §5  buildUnityAttachArgs: explicit port > explicit pid > the project's
//       EditorInstance.json; no target ⇒ throws teaching (honest at-use).
//   §6  armed table shape: startRequest attach, .cs AFTER dotnet in the
//       ladder, dormant hint speaks BOTH arm roads, readiness row honest.
//   §7  the attach seam END-TO-END on the mock adapter (loopback, zero
//       Unity): buildAttachArgs' body is what the adapter RECEIVES.
//   §8  the inferAdapter Unity-root OVERRIDE: with netcoredbg on PATH (so the
//       dotnet row claims .cs), a .cs INSIDE a Unity project still infers the
//       `unity` editor-attach adapter — a netcoredbg install cannot shadow it;
//       a bare .cs elsewhere keeps dotnet; disarmed, the override is silent.
//
//  cpu-pure + one mock-adapter child (the estate's deterministic mock).
//  Run:  ~/.bun/bin/bun run scripts/dap/prove-unity-adapter.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' unity attach-to-editor DAP row (MERCURY_UNITY) — proof')
console.log('============================================================')

const {
  resolveUnityDebugAdapter,
  unityDebugPortForPid,
  unityEditorEndpoint,
  unityEditorHint,
  buildUnityAttachArgs,
  UNITY_ADAPTER_ARM_HINT,
  UNITY_DAP_ADAPTER_KEY,
} = await import('../../src/services/dap/unityAdapter.js')
const {
  resolveAdapter,
  knownAdapterKeys,
  dormantBuiltinAdapterHints,
  adapterKeyForExtension,
  createDapSession,
  removeDapSession,
} = await import('../../src/services/dap/dapClient.js')
const { collectReadiness } = await import('../../src/utils/readiness.js')
const { whichSync } = await import('../../src/utils/which.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-adapter-'))
const proj = path.join(scratch, 'Game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })
mkdirSync(path.join(proj, 'Library'), { recursive: true })

// Fixture adapter dll + a dotnet shim.
const dllDir = path.join(scratch, 'adapter')
mkdirSync(dllDir, { recursive: true })
const fixtureDll = path.join(dllDir, 'UnityDebugAdapter.dll')
writeFileSync(fixtureDll, 'not-a-real-dll\n')
const dotnetDir = path.join(scratch, 'bin-dotnet')
mkdirSync(dotnetDir, { recursive: true })
const dotnetShim = path.join(dotnetDir, 'dotnet')
writeFileSync(dotnetShim, '#!/bin/sh\nexit 0\n')
chmodSync(dotnetShim, 0o755)

section('§1 · opt-in polarity (disarmed ⇒ nothing anywhere)')
{
  restore()
  delete process.env.MERCURY_UNITY
  check('disarmed: resolveAdapter(unity) is null', resolveAdapter(UNITY_DAP_ADAPTER_KEY) === null)
  check('disarmed: unity not a known key', !knownAdapterKeys().includes(UNITY_DAP_ADAPTER_KEY))
  check(
    'disarmed: no dormant unity hint',
    !dormantBuiltinAdapterHints().some(h => h.key === UNITY_DAP_ADAPTER_KEY),
  )
  const rows = collectReadiness({ includeEnv: false }).records
  check(
    'disarmed: no lane:unity and no lane:dap:unity readiness rows',
    !rows.some(r => r.id === 'lane:unity' || r.id === 'lane:dap:unity'),
  )
}

section('§2 · resolver rungs (fixtures; pin honesty; both-roads remedy)')
{
  restore()
  process.env.MERCURY_UNITY_DEBUG_ADAPTER = path.join(scratch, 'missing.dll')
  let r = resolveUnityDebugAdapter({ dotnetOverride: dotnetShim })
  check(
    'broken pin refuses BY NAME',
    'reason' in r && r.reason.includes('MERCURY_UNITY_DEBUG_ADAPTER') && r.reason.includes('missing.dll'),
  )
  process.env.MERCURY_UNITY_DEBUG_ADAPTER = fixtureDll
  r = resolveUnityDebugAdapter({ dotnetOverride: dotnetShim })
  check('good pin resolves (source pin)', !('reason' in r) && r.source === 'pin' && r.dll === fixtureDll)
  r = resolveUnityDebugAdapter({ dotnetOverride: null })
  check(
    'pinned dll without dotnet ⇒ the SDK refusal',
    'reason' in r && r.reason.includes('.NET SDK'),
  )
  delete process.env.MERCURY_UNITY_DEBUG_ADAPTER
  const extRoot = path.join(scratch, 'vscode-ext')
  for (const [dir, withDll] of [
    ['visualstudiotoolsforunity.vstuc-1.0.4', true],
    ['visualstudiotoolsforunity.vstuc-1.1.2', true],
    ['visualstudiotoolsforunity.vstuc-2.0.0', false], // newest but dll-less
    ['some-other.extension-9.9.9', true],
  ] as const) {
    mkdirSync(path.join(extRoot, dir, 'bin'), { recursive: true })
    if (withDll) {
      writeFileSync(path.join(extRoot, dir, 'bin', 'UnityDebugAdapter.dll'), 'x\n')
    } else {
      rmSync(path.join(extRoot, dir, 'bin'), { recursive: true, force: true })
      mkdirSync(path.join(extRoot, dir), { recursive: true })
    }
  }
  r = resolveUnityDebugAdapter({ extensionRoots: [extRoot], dotnetOverride: dotnetShim })
  check(
    'extension scan: newest DLL-BEARING vstuc dir wins (2.0.0 skipped honestly)',
    !('reason' in r) &&
      r.source === 'vscode-extension' &&
      r.dll.includes('vstuc-1.1.2'),
    'reason' in r ? r.reason : r.dll,
  )
  const unpack = path.join(scratch, 'unpack', 'UnityDebugAdapter.dll')
  mkdirSync(path.dirname(unpack), { recursive: true })
  writeFileSync(unpack, 'x\n')
  r = resolveUnityDebugAdapter({ extensionRoots: [path.join(scratch, 'no-ext')], unpackDll: unpack, dotnetOverride: dotnetShim })
  check('unpack spot is the fallback rung', !('reason' in r) && r.source === 'unpack' && r.dll === unpack)
  r = resolveUnityDebugAdapter({ extensionRoots: [path.join(scratch, 'no-ext')], unpackDll: path.join(scratch, 'no.dll'), dotnetOverride: dotnetShim })
  check(
    'absent ⇒ the both-roads remedy (extension AND env pin AND unpack)',
    'reason' in r &&
      r.reason.includes('visualstudiotoolsforunity.vstuc') &&
      r.reason.includes('MERCURY_UNITY_DEBUG_ADAPTER') &&
      r.reason.includes('.unity-dap'),
  )
}

section('§3 · the port law (56000 + pid % 1000)')
{
  check('pid 12345 ⇒ 56345', unityDebugPortForPid(12345) === 56345)
  check('pid 56000-aligned ⇒ 56000', unityDebugPortForPid(1000) === 56000)
  check('pid 999999 ⇒ 56999', unityDebugPortForPid(999999) === 56999)
  check('float/negative guarded', unityDebugPortForPid(-123.9) === 56123)
}

section('§4 · EditorInstance.json → endpoint')
{
  const editorInstance = path.join(proj, 'Library', 'EditorInstance.json')
  rmSync(editorInstance, { force: true })
  let e = unityEditorEndpoint(proj)
  check(
    'absent file ⇒ the teaching line (editor not running)',
    'reason' in e && e.reason.includes('is the Unity editor running'),
  )
  writeFileSync(editorInstance, '{ not json')
  e = unityEditorEndpoint(proj)
  check('malformed JSON ⇒ honest reason', 'reason' in e && e.reason.includes('not parseable'))
  writeFileSync(editorInstance, JSON.stringify({ version: '6000.3.4f1' }))
  e = unityEditorEndpoint(proj)
  check('no process_id ⇒ honest reason', 'reason' in e && e.reason.includes('process_id'))
  writeFileSync(
    editorInstance,
    JSON.stringify({ process_id: 12345, version: '6000.3.4f1', app_path: '/x' }),
  )
  e = unityEditorEndpoint(proj)
  check(
    'good file ⇒ 127.0.0.1:56345 with evidence',
    !('reason' in e) && e.host === '127.0.0.1' && e.port === 56345 && e.processId === 12345 && e.evidence === editorInstance,
  )
}

section('§5 · buildUnityAttachArgs (port > pid > EditorInstance; honest throw)')
{
  const byPort = buildUnityAttachArgs({ program: proj, cwd: proj, port: 56777 })
  check(
    'explicit port ⇒ endPoint + projectPath + the vstuc type discriminator',
    byPort.endPoint === '127.0.0.1:56777' && byPort.projectPath === proj && byPort.type === 'vstuc',
  )
  const byPid = buildUnityAttachArgs({ program: proj, cwd: proj, pid: 777 })
  check('explicit pid ⇒ derived endpoint', byPid.endPoint === '127.0.0.1:56777')
  const byFile = buildUnityAttachArgs({ program: path.join(proj, 'Assets'), cwd: scratch })
  check('EditorInstance road (from a project subdir program)', byFile.endPoint === '127.0.0.1:56345')
  rmSync(path.join(proj, 'Library', 'EditorInstance.json'), { force: true })
  let threw = ''
  try {
    buildUnityAttachArgs({ program: proj, cwd: proj })
  } catch (err) {
    threw = (err as Error).message
  }
  check('editor closed ⇒ throws the teaching line', threw.includes('is the Unity editor running'))
  threw = ''
  try {
    buildUnityAttachArgs({ program: path.join(scratch, 'nowhere'), cwd: scratch })
  } catch (err) {
    threw = (err as Error).message
  }
  check('no project + no target ⇒ throws naming the markers', threw.includes('Assets/ + ProjectSettings/'))
  check('hint spells the port law', unityEditorHint().includes('56000 + pid % 1000'))
}

section('§6 · armed table shape + ladder + readiness')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  delete process.env.MERCURY_UNITY_DEBUG_ADAPTER
  // On a box with no real vstuc install the row is dormant WITH the
  // both-roads hint; with one, the row resolves. Both are honest.
  const spec = resolveAdapter(UNITY_DAP_ADAPTER_KEY)
  if (spec === null) {
    check(
      'armed + unresolved ⇒ dormant hint speaks BOTH roads',
      dormantBuiltinAdapterHints().some(
        h => h.key === UNITY_DAP_ADAPTER_KEY && h.hint === UNITY_ADAPTER_ARM_HINT,
      ),
    )
    const rows = collectReadiness({ includeEnv: false }).records
    const row = rows.find(r => r.id === 'lane:dap:unity')
    check(
      'armed + unresolved ⇒ lane:dap:unity unavailable with the both-roads remedy',
      row !== undefined && row.state === 'unavailable' && row.remedy === UNITY_ADAPTER_ARM_HINT,
    )
  } else {
    check('armed + resolved ⇒ attach-hosting row', spec.startRequest === 'attach')
  }
  // Arm via the pin (deterministic on every box): PATH carries the dotnet
  // shim so the resolver's dotnet rung is real.
  process.env.MERCURY_UNITY_DEBUG_ADAPTER = fixtureDll
  process.env.PATH = `${dotnetDir}${path.delimiter}${process.env.PATH ?? ''}`
  const armed = resolveAdapter(UNITY_DAP_ADAPTER_KEY)
  check(
    'pinned row: dotnet runs the dll, startRequest attach, .cs declared, builder present',
    armed !== null &&
      armed.command === dotnetShim &&
      armed.args[0] === fixtureDll &&
      armed.startRequest === 'attach' &&
      (armed.fileTypes ?? []).includes('.cs') &&
      typeof armed.buildAttachArgs === 'function',
  )
  check('known keys include unity', knownAdapterKeys().includes(UNITY_DAP_ADAPTER_KEY))
  const csKey = adapterKeyForExtension('.cs')
  check(
    '.cs ladder: dotnet (netcoredbg) outranks by insertion; unity serves otherwise',
    whichSync('netcoredbg') ? csKey === 'dotnet' : csKey === UNITY_DAP_ADAPTER_KEY,
    `resolved ${csKey}`,
  )
  const rows = collectReadiness({ includeEnv: false }).records
  const row = rows.find(r => r.id === 'lane:dap:unity')
  check(
    'lane:dap:unity configured, naming dll + dotnet + the port law',
    row !== undefined &&
      row.state === 'configured' &&
      row.detail.includes(fixtureDll) &&
      row.detail.includes('56000 + editor pid % 1000'),
  )
}

section('§7 · the attach seam end-to-end (mock adapter, loopback)')
{
  restore()
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  let builderSaw: Record<string, unknown> | null = null
  const owner = { kind: 'session', id: 'prove-unity-adapter' } as never
  const session = await createDapSession({
    owner,
    id: 'unity-proof',
    adapterKey: 'unity-mock',
    program: proj,
    cwd: proj,
    mode: 'attach',
    port: 56345,
    specOverride: {
      command: process.execPath,
      args: [MOCK],
      startRequest: 'attach',
      buildAttachArgs: options => {
        builderSaw = { program: options.program, cwd: options.cwd, port: options.port }
        return buildUnityAttachArgs(options)
      },
    },
  })
  check(
    'buildAttachArgs received the session facts (program/cwd/port)',
    builderSaw !== null &&
      (builderSaw as Record<string, unknown>).program === proj &&
      (builderSaw as Record<string, unknown>).cwd === proj &&
      (builderSaw as Record<string, unknown>).port === 56345,
  )
  check('the attach choreography completed against the mock', session.terminated === false)
  await removeDapSession(owner, 'unity-proof')
}

section('§8 · inferAdapter Unity-root override (netcoredbg cannot shadow the editor attach)')
{
  restore()
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
  // netcoredbg on PATH ⇒ the dotnet row exists and CLAIMS .cs. The override
  // (root-marker gated, BEFORE the declared-extension ladder) must still route
  // a Unity-project .cs to the editor-attach adapter. Observed cpu-pure through
  // the launch permission message — the same inference the launch itself uses
  // (the prove-native-debug technique); no session, no spawn.
  const ncbgDir = path.join(scratch, 'bin-ncbg')
  mkdirSync(ncbgDir, { recursive: true })
  const ncbg = path.join(ncbgDir, 'netcoredbg')
  writeFileSync(ncbg, '#!/bin/sh\nexit 0\n')
  chmodSync(ncbg, 0o755)
  writeFileSync(path.join(proj, 'Assets', 'Player.cs'), '// unity cs\n')
  const plain = path.join(scratch, 'PlainRepo')
  mkdirSync(plain, { recursive: true })
  writeFileSync(path.join(plain, 'bare.cs'), '// bare cs\n')
  process.env.PATH = `${ncbgDir}${path.delimiter}${process.env.PATH ?? ''}`
  const adapterFor = async (program: string): Promise<string> => {
    const perm = await DebugTool.checkPermissions({ op: 'launch', program } as never, {} as never)
    const msg = 'message' in perm ? String((perm as { message: string }).message) : ''
    return msg.match(/adapter (\w+)/)?.[1] ?? `?(${msg})`
  }
  check('netcoredbg present ⇒ .cs declared-ladder resolves to dotnet', adapterKeyForExtension('.cs') === 'dotnet')
  process.env.MERCURY_UNITY = '1'
  check(
    'armed + Unity-root .cs + netcoredbg present ⇒ adapter unity (override wins)',
    (await adapterFor(path.join(proj, 'Assets', 'Player.cs'))) === UNITY_DAP_ADAPTER_KEY,
  )
  check(
    'armed + bare .cs (no Unity root) ⇒ adapter dotnet (override does not overreach)',
    (await adapterFor(path.join(plain, 'bare.cs'))) === 'dotnet',
  )
  delete process.env.MERCURY_UNITY
  check(
    'disarmed + Unity-root .cs ⇒ adapter dotnet (no override while off)',
    (await adapterFor(path.join(proj, 'Assets', 'Player.cs'))) === 'dotnet',
  )
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
process.exit(0)
