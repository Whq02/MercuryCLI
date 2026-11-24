#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fakeCommand } from '../dap/fakeCommand.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' blender headless launch profiles (MERCURY_BLENDER) — proof')
console.log('============================================================')

const { discoverLaunchProfiles } = await import('../../src/integrations/ide/launchProfiles.js')
const { operatorRunRefusal } = await import(
  '../../src/tools/launch/LaunchTool.js'
)

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-profiles-'))
const work = path.join(scratch, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'scene-a.blend'), '')
writeFileSync(path.join(work, 'scene-b.blend'), '')
const shimBin = fakeCommand(scratch, 'shim-blender', 'Blender 5.2.1\n', scratch)
type Discovery = Awaited<ReturnType<typeof discoverLaunchProfiles>>
function answeredByTheShim(d: Discovery): boolean {
  const rows = d.profiles.filter(p => p.source === 'blender')
  return (
    rows.length > 0 &&
    rows.every(
      p => p.blenderHeadless?.blenderPath === shimBin && p.provenance.includes(`Blender 5.2.1 located (pin): ${shimBin}`),
    )
  )
}

section('§1 · opt-in polarity')
{
  restore()
  delete process.env.MERCURY_BLENDER
  const off = await discoverLaunchProfiles(work)
  check(
    'off: zero blender profiles beside .blend files',
    off.profiles.every(p => p.source !== 'blender'),
    '',
    'blender rows must only be built when mercuryBlenderEnabled() is true: see the blender block of discoverLaunchProfiles in src/integrations/ide/launchProfiles.ts',
  )
}

section('§2 · render shapes (THE ORDER LAW by index)')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = shimBin
  const d = await discoverLaunchProfiles(work)
  const blender = d.profiles.filter(p => p.source === 'blender')
  check(
    '2 files ⇒ 2 render-frame + 2 render-anim + 1 hermetic + 1 debug recipe = 6 rows',
    blender.length === 6,
    `${blender.length}`,
    'the blender block of discoverLaunchProfiles in src/integrations/ide/launchProfiles.ts pushes the render-frame, render-animation, hermetic and debug rows per .blend file: fix what it pushes',
  )
  const renders = blender.filter(p => (p.blenderHeadless?.args ?? []).includes('-b'))
  check(
    'four render rows carry -b <file> first',
    renders.length === 4 && renders.every(p => p.blenderHeadless?.args[0] === '-b'),
    '',
    'the mkB render calls in the blender block of discoverLaunchProfiles (src/integrations/ide/launchProfiles.ts) must start their args with -b and the file',
  )
  for (const p of renders) {
    const args = p.blenderHeadless?.args ?? []
    const o = args.indexOf('-o')
    const frame = args.indexOf('-f')
    const anim = args.indexOf('-a')
    check(
      `ORDER LAW: output before ${frame !== -1 ? '-f' : '-a'} (${p.label})`,
      o !== -1 && (frame === -1 || o < frame) && (anim === -1 || o < anim),
      '',
      'put -o before -f and -a in the render args built by mkB in src/integrations/ide/launchProfiles.ts',
    )
    check(
      `note teaches the order law + runs-are-yours (${p.label})`,
      (p.blenderHeadless?.note ?? '').includes('IN ORDER') &&
        (p.blenderHeadless?.note ?? '').includes('these profiles are printed, never run for you') &&
        !(p.blenderHeadless?.note ?? '').includes('never launches Blender'),
      '',
      'the render rows note is ORDER_NOTE in the blender block of discoverLaunchProfiles (src/integrations/ide/launchProfiles.ts): it must say IN ORDER and these profiles are printed, never run for you',
    )
  }
  check(
    'the located binary spells the commandLine',
    blender.every(p => p.blenderHeadless?.commandLine.startsWith(shimBin)),
    '',
    'commandLine is spelled by spell() from the binary buildBlenderContextProfile located (MERCURY_BLENDER_BIN pin): see src/integrations/ide/launchProfiles.ts',
  )
}

section('§3 · the hermetic python row')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = shimBin
  const d = await discoverLaunchProfiles(work)
  check(
    'every row carries the pinned shim and its version: no Blender this machine holds answered (§3)',
    answeredByTheShim(d),
    d.profiles.find(p => p.source === 'blender')?.provenance ?? '',
    'the pin MERCURY_BLENDER_BIN must win over any installed Blender: see buildBlenderContextProfile in src/integrations/blender-protocol/blenderProject.ts and the blender block of src/integrations/ide/launchProfiles.ts',
  )
  const hermetic = d.profiles.find(
    p => p.source === 'blender' && (p.blenderHeadless?.args ?? []).includes('--factory-startup'),
  )
  const args = hermetic?.blenderHeadless?.args ?? []
  check(
    'shape: --background --factory-startup --python <placeholder> --python-exit-code 1',
    args[0] === '--background' &&
      args.includes('--factory-startup') &&
      args[args.indexOf('--python') + 1] === '<your-script.py>' &&
      args[args.indexOf('--python-exit-code') + 1] === '1',
    '',
    'the hermetic mkB call in the blender block of discoverLaunchProfiles (src/integrations/ide/launchProfiles.ts) spells these args',
  )
  check(
    'note teaches the exit-code semantics (zero disables)',
    (hermetic?.blenderHeadless?.note ?? '').includes('zero disables'),
    '',
    'the hermetic note in the blender block of discoverLaunchProfiles (src/integrations/ide/launchProfiles.ts) must say zero disables',
  )
}

section('§4 · the shared operator-run refusal')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = shimBin
  const d = await discoverLaunchProfiles(work)
  check(
    'every row carries the pinned shim and its version: no Blender this machine holds answered (§4)',
    answeredByTheShim(d),
    d.profiles.find(p => p.source === 'blender')?.provenance ?? '',
    'the pin MERCURY_BLENDER_BIN must win over any installed Blender: see buildBlenderContextProfile in src/integrations/blender-protocol/blenderProject.ts and the blender block of src/integrations/ide/launchProfiles.ts',
  )
  const row = d.profiles.find(p => p.source === 'blender')
  const refusal = row ? operatorRunRefusal(row) : null
  check(
    'blender refusal: operator-run + command + note, no-change',
    refusal !== null &&
      refusal.outcome === 'no-change' &&
      refusal.result.includes('blender headless profiles are operator-run') &&
      refusal.result.includes(row?.blenderHeadless?.commandLine ?? '∅'),
    '',
    'operatorRunRefusal in src/tools/launch/LaunchTool.ts must return outcome no-change and a result naming blender headless profiles are operator-run plus the command line',
  )
  check(
    'no license sentence on blender rows (Blender needs none)',
    refusal !== null && !refusal.result.toLowerCase().includes('licens'),
    '',
    'operatorRunRefusal in src/tools/launch/LaunchTool.ts adds a license sentence only for unity rows, not blender rows',
  )
}

section('§5 · the profile cap honesty')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  const many = path.join(scratch, 'many')
  mkdirSync(many, { recursive: true })
  for (let i = 0; i < 13; i++) {
    writeFileSync(path.join(many, `f${String(i).padStart(2, '0')}.blend`), '')
  }
  process.env.MERCURY_BLENDER_BIN = shimBin
  const d = await discoverLaunchProfiles(many)
  const blender = d.profiles.filter(p => p.source === 'blender')
  check(
    'every row carries the pinned shim and its version: no Blender this machine holds answered (§5)',
    answeredByTheShim(d),
    blender[0]?.provenance ?? '',
    'the pin MERCURY_BLENDER_BIN must win over any installed Blender: see buildBlenderContextProfile in src/integrations/blender-protocol/blenderProject.ts and the blender block of src/integrations/ide/launchProfiles.ts',
  )
  check('capped: 10 files × 2 + hermetic + debug recipe = 22 rows', blender.length === 22,
    `${blender.length}`,
    'BLEND_PROFILE_FILE_CAP in the blender block of discoverLaunchProfiles (src/integrations/ide/launchProfiles.ts) caps the .blend files profiled',
  )
  check(
    'the overflow is a counted source note, not silence',
    d.sourceErrors.some(e => e.source === 'blender' && e.error.includes('3 more .blend')),
    '',
    'the blender block of discoverLaunchProfiles (src/integrations/ide/launchProfiles.ts) must push a sourceErrors note counting the files beyond BLEND_PROFILE_FILE_CAP',
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
