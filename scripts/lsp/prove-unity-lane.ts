#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fixHint ? ` — fix: ${fixHint}` : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' mercury-csharp Unity lane (MERCURY_UNITY) — proof')
console.log('============================================================')

const {
  probeUnityCsharpServer,
  builtinUnityCsharpServer,
  unityLaneReadinessRecords,
  unityCsharpImplementationInfo,
  _resetUnityCsharpProbeForTesting,
  MERCURY_CSHARP_SERVER_NAME,
} = await import('../../src/integrations/lsp/unityLane.js')
const { getMercuryLspServerSources, builtinImplementationInfo } = await import(
  '../../src/integrations/lsp/builtinServers.js'
)
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  _resetUnityCsharpProbeForTesting()
}

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-lane-'))
const proj = path.join(scratch, 'Game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })

function shimDir(name: string, binaries: string[]): string {
  const dir = path.join(scratch, name)
  mkdirSync(dir, { recursive: true })
  for (const bin of binaries) {
    const p = path.join(dir, process.platform === 'win32' ? `${bin}.cmd` : bin)
    writeFileSync(p, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
    if (process.platform !== 'win32') chmodSync(p, 0o755)
  }
  return dir
}

const binBoth = shimDir('bin-both', ['csharp-ls', 'OmniSharp'])
const binOmni = shimDir('bin-omni', ['OmniSharp'])
const binDotnet = shimDir('bin-dotnet', ['dotnet'])
const binEmpty = shimDir('bin-empty', [])

section('§1 · opt-in polarity (default OFF, byte-identical)')
{
  restore()
  delete process.env.MERCURY_UNITY
  process.env.PATH = binBoth
  check(
    'unset: no mercury-csharp source even inside a Unity project with a server on PATH',
    runWithCwdOverride(
      proj,
      () => !(MERCURY_CSHARP_SERVER_NAME in getMercuryLspServerSources().builtin),
    ),
    '',
    'builtinUnityCsharpServer in src/integrations/lsp/unityLane.ts must return {} unless mercuryUnityEnabled() (MERCURY_UNITY) is on; check getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts',
  )
  check('unset: no readiness row at all', runWithCwdOverride(proj, () => unityLaneReadinessRecords().length === 0), '', 'unityLaneReadinessRecords in src/integrations/lsp/unityLane.ts must return [] unless MERCURY_UNITY is on')
  process.env.MERCURY_UNITY = '1'
  check(
    'armed but outside a Unity project: still no source',
    runWithCwdOverride(
      scratch,
      () => !(MERCURY_CSHARP_SERVER_NAME in getMercuryLspServerSources().builtin),
    ),
    '',
    'builtinUnityCsharpServer in src/integrations/lsp/unityLane.ts must return {} when findUnityProjectRoot (src/integrations/unity-protocol/unityProject.ts) finds no Assets/ + ProjectSettings/ from the working directory',
  )
}

section('§2 · probe resolution order (PATH shims; remedies honest)')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  process.env.PATH = binBoth
  let probe = probeUnityCsharpServer()
  check(
    'both present ⇒ csharp-ls wins, no args',
    probe.available && probe.server === 'csharp-ls' && (probe.args ?? []).length === 0,
    '',
    'probeUnityCsharpServer in src/integrations/lsp/unityLane.ts must prefer csharp-ls on PATH and give it no args',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binOmni
  probe = probeUnityCsharpServer()
  check(
    "OmniSharp alone ⇒ omnisharp with the load-bearing -lsp flag",
    probe.available && probe.server === 'omnisharp' && (probe.args ?? []).join(' ') === '-lsp',
    '',
    'probeUnityCsharpServer in src/integrations/lsp/unityLane.ts must fall back to OmniSharp with args [-lsp] when csharp-ls is absent',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binDotnet
  probe = probeUnityCsharpServer()
  check(
    'absent with dotnet ⇒ the tool-install remedy',
    !probe.available && (probe.reason ?? '').includes('dotnet tool install --global csharp-ls'),
    '',
    'probeUnityCsharpServer in src/integrations/lsp/unityLane.ts must set an unavailable reason naming dotnet tool install --global csharp-ls when dotnet is on PATH',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binEmpty
  probe = probeUnityCsharpServer()
  check(
    'absent without dotnet ⇒ the SDK-first remedy',
    !probe.available && (probe.reason ?? '').includes('.NET SDK first'),
    '',
    'probeUnityCsharpServer in src/integrations/lsp/unityLane.ts must set an unavailable reason saying to install the .NET SDK first when dotnet is also absent',
  )
}

section('§3 · config shape + claim order')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  process.env.PATH = binBoth
  const sources = runWithCwdOverride(proj, () => getMercuryLspServerSources().builtin)
  const config = sources[MERCURY_CSHARP_SERVER_NAME]
  check('armed + project + server ⇒ the source exists', config !== undefined, '', 'builtinUnityCsharpServer in src/integrations/lsp/unityLane.ts returned no mercury-csharp entry; check its MERCURY_UNITY, project-root and probe gates, and the spread in getMercuryLspServerSources (src/integrations/lsp/builtinServers.ts)')
  check(
    'claim: .cs → csharp only',
    config !== undefined &&
      Object.keys(config.extensionToLanguage).join(',') === '.cs' &&
      config.extensionToLanguage['.cs'] === 'csharp',
    '',
    'CS_EXTENSION_TO_LANGUAGE in src/integrations/lsp/unityLane.ts must map only .cs to csharp',
  )
  check(
    'workspaceFolder = the Unity project root; source mercury-builtin; stdio',
    config?.workspaceFolder === proj && config?.source === 'mercury-builtin' && config?.transport === 'stdio',
    '',
    'the config built by builtinUnityCsharpServer in src/integrations/lsp/unityLane.ts must carry workspaceFolder = the Unity root, source mercury-builtin and transport stdio',
  )
  const names = Object.keys(sources)
  check(
    'claim order: csharp sits between the engine lanes and pyright',
    names.includes(MERCURY_CSHARP_SERVER_NAME) &&
      (names.indexOf(MERCURY_CSHARP_SERVER_NAME) < names.indexOf('mercury-pyright') ||
        !names.includes('mercury-pyright')),
    names.join(' → '),
    'mercury-csharp must be listed before mercury-pyright in getMercuryLspServerSources (src/integrations/lsp/builtinServers.ts)',
  )
}

section('§4 · readiness honesty (armed states)')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  process.env.PATH = binBoth
  let rows = runWithCwdOverride(scratch, () => unityLaneReadinessRecords())
  check(
    'armed, no project ⇒ ONE configured row teaching where it activates',
    rows.length === 1 && rows[0]?.state === 'configured' && rows[0].detail.includes('activates in a Unity project'),
    '',
    'unityLaneReadinessRecords in src/integrations/lsp/unityLane.ts must return one configured row whose detail says it activates in a Unity project when no project root is found',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binEmpty
  rows = runWithCwdOverride(proj, () => unityLaneReadinessRecords())
  check(
    'armed, project, no server ⇒ unavailable with the remedy',
    rows.length === 1 && rows[0]?.state === 'unavailable' && (rows[0].remedy ?? '').includes('.NET SDK'),
    '',
    'unityLaneReadinessRecords in src/integrations/lsp/unityLane.ts must return one unavailable row with the probe reason (naming the .NET SDK) as its remedy when no server is on PATH',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binBoth
  rows = runWithCwdOverride(proj, () => unityLaneReadinessRecords())
  check(
    'armed, project, server ⇒ configured naming the binary (never ready — nothing ran)',
    rows.length === 1 &&
      rows[0]?.state === 'configured' &&
      rows[0].detail.includes('csharp-ls') &&
      rows[0].detail.includes(proj),
    '',
    'unityLaneReadinessRecords in src/integrations/lsp/unityLane.ts must return one configured row whose detail names the server binary and the project root',
  )
}

section('§5 · implementation provenance')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  process.env.PATH = binBoth
  check('probe available ⇒ PATH provenance', unityCsharpImplementationInfo()?.source === 'path', '', 'unityCsharpImplementationInfo in src/integrations/lsp/unityLane.ts must return source path when the probe finds a server')
  check(
    "builtinImplementationInfo('mercury-csharp') rides the same hook",
    builtinImplementationInfo(MERCURY_CSHARP_SERVER_NAME)?.source === 'path',
    '',
    'builtinImplementationInfo in src/integrations/lsp/builtinServers.ts must route mercury-csharp to unityCsharpImplementationInfo',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binEmpty
  check('probe absent ⇒ null provenance', unityCsharpImplementationInfo() === null, '', 'unityCsharpImplementationInfo in src/integrations/lsp/unityLane.ts must return null when the probe finds no server')
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
