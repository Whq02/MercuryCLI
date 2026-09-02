#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unc-workspace-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const fsPerm = await import('../../src/utils/permissions/filesystem.ts')

const SHARE = '//fileserver/dev/proj'
const inside = `${SHARE}/src/app.ts`
const incidental = '//other-server/backup/notes.txt'
const tool = { name: 'Read', getPath: (i: { file_path: string }) => i.file_path }
const ctx = (mode: 'default' | 'implement') => ({
  mode,
  additionalWorkingDirectories: new Map([[SHARE, { path: SHARE, source: 'session' }]]),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
  shouldAvoidPermissionPrompts: false,
})
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string; mode?: string } }
const read = (path: string, mode: 'default' | 'implement' = 'default'): Decision =>
  fsPerm.checkReadPermissionForTool(tool as never, { file_path: path }, ctx(mode) as never) as unknown as Decision
const write = (path: string, mode: 'default' | 'implement'): Decision =>
  fsPerm.checkWritePermissionForTool({ ...tool, name: 'Edit' } as never, { file_path: path }, ctx(mode) as never) as unknown as Decision

section('§1 reads')
{
  const ok = read(inside)
  check(
    'a read inside the UNC working directory is allowed by the working-directory rung',
    ok.behavior === 'allow' && ok.decisionReason?.type === 'mode',
    JSON.stringify(ok),
  )
  const blocked = read(incidental)
  check(
    'an incidental UNC path elsewhere still meets the UNC card (the block keeps its meaning)',
    blocked.behavior === 'ask' && /network \(UNC\) path/.test(blocked.message ?? ''),
    JSON.stringify(blocked),
  )
}

section('§2 writes')
{
  const fast = write(inside, 'implement')
  check(
    'implement mode: a write inside the UNC working directory is allowed (the implement fast path)',
    fast.behavior === 'allow' && fast.decisionReason?.mode === 'implement',
    JSON.stringify(fast),
  )
  const plain = write(inside, 'default')
  check(
    'default mode: a write inside the UNC working directory meets the ORDINARY not-yet-granted card, never the sensitive-file card',
    plain.behavior === 'ask' && /has not been granted/.test(plain.message ?? '') && !/sensitive file/.test(plain.message ?? ''),
    JSON.stringify(plain),
  )
  check('…and that card is NOT marked outside-the-working-directory (a remembered rule can clear it)', plain.decisionReason === undefined || plain.decisionReason.type !== 'workingDir', JSON.stringify(plain.decisionReason))
  const blocked = write(incidental, 'implement')
  check(
    'an incidental UNC path elsewhere still meets the sensitive-file card, even in implement mode',
    blocked.behavior === 'ask' && /sensitive file/.test(blocked.message ?? ''),
    JSON.stringify(blocked),
  )
}

section('§3 the safety predicate without a context keeps the block')
{
  const bare = fsPerm.checkPathSafetyForAutoEdit(inside)
  check('checkPathSafetyForAutoEdit(path) alone still refuses a raw UNC path (the PowerShell caller)', bare.safe === false && /sensitive file/.test(bare.message ?? ''), JSON.stringify(bare))
  const scoped = fsPerm.checkPathSafetyForAutoEdit(inside, undefined, ctx('default') as never)
  check('…and with the session context it stands down inside the UNC working directory', scoped.safe === true, JSON.stringify(scoped))
}

if (failures > 0) {
  console.error(`\nprove-unc-workspace: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-unc-workspace: all green')
process.exit(0)
