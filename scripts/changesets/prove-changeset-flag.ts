#!/usr/bin/env bun
// ============================================================================
//  scripts/changesets/prove-changeset-flag.ts — MERCURY_CHANGESET registry +
//  off-state byte-equivalence:
//    · both flags registered (default-on additive + the value seam) with a
//      real evidence path;
//    · =0 removes the ChangeSet tool from the catalog and leaves the
//      remaining catalog BYTE-IDENTICAL (names, order);
//    · the gate composes: MERCURY_CHANGE_RECEIPTS=0 or MERCURY_EDIT_HUNKS=0
//      also removes the tool (anchors/hunks ARE the member vocabulary);
//    · the gate re-reads env LIVE (authority-toggle honesty);
//    · the capability constitution rides the tool (census self-description).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-flag-home-'))
delete process.env.MERCURY_CHANGESET
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_HUNKS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
const { changeSetEnabled, changeSetHomeDir } = await import(
  '../../src/services/changeTransaction/changeSetContracts.ts'
)
const { getAllBaseTools } = await import('../../src/tools.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')

console.log('── §1 registry rows ──')
{
  const rows = FLAG_REGISTRY as { env: string; kind?: string; tier?: string; evidence?: string }[]
  const gate = rows.find(r => r.env === 'MERCURY_CHANGESET')
  const seam = rows.find(r => r.env === 'MERCURY_CHANGESET_DIR')
  check('MERCURY_CHANGESET is registered default-on/additive', gate?.kind === 'default-on' && gate?.tier === 'additive')
  check('the evidence path exists', typeof gate?.evidence === 'string' && existsSync(join(import.meta.dir, '..', '..', gate.evidence)))
  check('MERCURY_CHANGESET_DIR is registered as the value seam', seam?.kind === 'value')
}

console.log('── §2 catalog byte-equivalence ──')
{
  const names = (): string[] => getAllBaseTools().map(t => (t as { name: string }).name)
  const withTool = names()
  check('default-ON: ChangeSet is in the catalog', withTool.includes('ChangeSet'))
  process.env.MERCURY_CHANGESET = '0'
  const without = names()
  check('=0: ChangeSet absent', !without.includes('ChangeSet'))
  check('=0: the remaining catalog is BYTE-IDENTICAL (names + order)', JSON.stringify(without) === JSON.stringify(withTool.filter(n => n !== 'ChangeSet')))
  delete process.env.MERCURY_CHANGESET
  check('the gate re-reads env LIVE (restored ⇒ present again)', names().includes('ChangeSet'))

  process.env.MERCURY_EDIT_HUNKS = '0'
  check('MERCURY_EDIT_HUNKS=0 also removes the tool (vocabulary composition)', !names().includes('ChangeSet'))
  delete process.env.MERCURY_EDIT_HUNKS
  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  check('MERCURY_CHANGE_RECEIPTS=0 also removes the tool (anchor composition)', !names().includes('ChangeSet'))
  delete process.env.MERCURY_CHANGE_RECEIPTS
  check('clean env ⇒ enabled (default-ON)', changeSetEnabled() === true)
}

console.log('── §3 self-description + seams ──')
{
  const cap = (ChangeSetTool as { capability?: { gate?: string; class?: string; transaction?: { receipts?: boolean } } }).capability
  check('the tool self-declares its capability (gate + mutation class + receipts)', cap?.gate === 'MERCURY_CHANGESET' && cap?.class === 'mutation' && cap?.transaction?.receipts === true)
  check('the tool is DEFERRED (zero permanent prompt mass)', (ChangeSetTool as { shouldDefer?: boolean }).shouldDefer === true)
  const pinned = mkdtempSync(join(tmpdir(), 'fulcrum-flag-cs-'))
  process.env.MERCURY_CHANGESET_DIR = pinned
  check('MERCURY_CHANGESET_DIR pins the durable home (hermetic seam)', changeSetHomeDir() === pinned)
  delete process.env.MERCURY_CHANGESET_DIR
  check('unset ⇒ the config-home default', changeSetHomeDir().endsWith('changesets'))
}

console.log(failures === 0 ? '\nprove-changeset-flag: GREEN' : `\nprove-changeset-flag: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
