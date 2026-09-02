#!/usr/bin/env bun
// ============================================================================
//  scripts/lsp/prove-unity-lane.ts
//  PROOF: the Unity C# IDE-hands lane (`mercury-csharp`, riding the
//  MERCURY_UNITY master gate — opt-in, default OFF).
//
//   §1  opt-in polarity: unset ⇒ NO source even inside a Unity project and
//       NO readiness row (byte-identical); armed alone ⇒ still nothing
//       outside a Unity project.
//   §2  probe resolution order via PATH shims: csharp-ls > OmniSharp
//       (OmniSharp spawns with -lsp — the LSP-mode flag is load-bearing);
//       absent ⇒ the dotnet-aware remedy (SDK-first when dotnet is absent).
//   §3  config shape: .cs → csharp claim, workspaceFolder = the Unity
//       project root, source mercury-builtin; insertion beside the godot
//       lane in the claim order.
//   §4  readiness honesty: [] while off · configured (activates-in-project)
//       when armed without a project · unavailable+remedy when a project has
//       no server · configured naming the binary when it does.
//   §5  implementation info: PATH provenance when probed.
//
//  cpu-pure: PATH shims + scratch trees; no dotnet/Unity anywhere.
//  Run:  ~/.bun/bin/bun run scripts/lsp/prove-unity-lane.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

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
console.log(' mercury-csharp Unity lane (MERCURY_UNITY) — proof')
console.log('============================================================')

const {
  probeUnityCsharpServer,
  builtinUnityCsharpServer,
  unityLaneReadinessRecords,
  unityCsharpImplementationInfo,
  _resetUnityCsharpProbeForTesting,
  MERCURY_CSHARP_SERVER_NAME,
} = await import('../../src/services/lsp/unityLane.js')
const { getMercuryLspServerSources, builtinImplementationInfo } = await import(
  '../../src/services/lsp/builtinServers.js'
)
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

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
    const p = path.join(dir, bin)
    writeFileSync(p, '#!/bin/sh\nexit 0\n')
    chmodSync(p, 0o755)
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
  )
  check('unset: no readiness row at all', runWithCwdOverride(proj, () => unityLaneReadinessRecords().length === 0))
  process.env.MERCURY_UNITY = '1'
  check(
    'armed but outside a Unity project: still no source',
    runWithCwdOverride(
      scratch,
      () => !(MERCURY_CSHARP_SERVER_NAME in getMercuryLspServerSources().builtin),
    ),
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
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binOmni
  probe = probeUnityCsharpServer()
  check(
    "OmniSharp alone ⇒ omnisharp with the load-bearing -lsp flag",
    probe.available && probe.server === 'omnisharp' && (probe.args ?? []).join(' ') === '-lsp',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binDotnet
  probe = probeUnityCsharpServer()
  check(
    'absent with dotnet ⇒ the tool-install remedy',
    !probe.available && (probe.reason ?? '').includes('dotnet tool install --global csharp-ls'),
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binEmpty
  probe = probeUnityCsharpServer()
  check(
    'absent without dotnet ⇒ the SDK-first remedy',
    !probe.available && (probe.reason ?? '').includes('.NET SDK first'),
  )
}

section('§3 · config shape + claim order')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  process.env.PATH = binBoth
  const sources = runWithCwdOverride(proj, () => getMercuryLspServerSources().builtin)
  const config = sources[MERCURY_CSHARP_SERVER_NAME]
  check('armed + project + server ⇒ the source exists', config !== undefined)
  check(
    'claim: .cs → csharp only',
    config !== undefined &&
      Object.keys(config.extensionToLanguage).join(',') === '.cs' &&
      config.extensionToLanguage['.cs'] === 'csharp',
  )
  check(
    'workspaceFolder = the Unity project root; source mercury-builtin; stdio',
    config?.workspaceFolder === proj && config?.source === 'mercury-builtin' && config?.transport === 'stdio',
  )
  const names = Object.keys(sources)
  check(
    'claim order: csharp sits between the engine lanes and pyright',
    names.includes(MERCURY_CSHARP_SERVER_NAME) &&
      (names.indexOf(MERCURY_CSHARP_SERVER_NAME) < names.indexOf('mercury-pyright') ||
        !names.includes('mercury-pyright')),
    names.join(' → '),
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
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binEmpty
  rows = runWithCwdOverride(proj, () => unityLaneReadinessRecords())
  check(
    'armed, project, no server ⇒ unavailable with the remedy',
    rows.length === 1 && rows[0]?.state === 'unavailable' && (rows[0].remedy ?? '').includes('.NET SDK'),
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
  )
}

section('§5 · implementation provenance')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  process.env.PATH = binBoth
  check('probe available ⇒ PATH provenance', unityCsharpImplementationInfo()?.source === 'path')
  check(
    "builtinImplementationInfo('mercury-csharp') rides the same hook",
    builtinImplementationInfo(MERCURY_CSHARP_SERVER_NAME)?.source === 'path',
  )
  _resetUnityCsharpProbeForTesting()
  process.env.PATH = binEmpty
  check('probe absent ⇒ null provenance', unityCsharpImplementationInfo() === null)
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
