#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-unc-workspace.ts — a share-hosted workspace is
//  the operator's own tree (FN-015 rank 31).
//
//  The defence-in-depth UNC block sat at step 2 of the read ladder and
//  inside the write ladder's safety rung, ahead of every rung that could
//  answer "inside an allowed working directory" or consult a rule — so a
//  session launched in \\fileserver\dev\proj (PowerShell and Windows
//  Terminal both allow a UNC cwd; an enterprise redirected home makes the
//  config home itself UNC) raised a card for EVERY read and write, and the
//  card's remember-this option wrote a rule the ladder never reached. The
//  block now keeps its meaning for an INCIDENTAL network path and stands
//  down for a UNC path that resolves inside an allowed working directory.
//    §1 read: inside the UNC working directory ⇒ the working-directory
//       allow; an incidental UNC path elsewhere ⇒ the UNC card, unchanged.
//    §2 write: implement mode inside the UNC working directory ⇒ allow;
//       default mode ⇒ the ORDINARY not-yet-granted card (rule-clearable),
//       never the sensitive-file card; an incidental UNC path ⇒ the
//       sensitive-file card, unchanged.
//    §3 the safety predicate alone (no context) keeps the block — the
//       PowerShell path validation calls it that way.
//  UNC spellings ride unresolved through the permission path resolver on
//  every host (isUncLikePath short-circuits the symlink walk), so the
//  ladder is drivable here; the live Windows leg is field work.
//
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-unc-workspace.ts
// ============================================================================
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
