#!/usr/bin/env bun
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

const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
const { changeSetEnabled, changeSetHomeDir } = await import(
  '../../src/tools/engines/change-transaction/changeSetContracts.ts'
)
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { ChangeSetTool } = await import('../../src/tools/change-set/ChangeSetTool.ts')

console.log('── §1 registry rows ──')
{
  const rows = FLAG_REGISTRY as { env: string; kind?: string; tier?: string; evidence?: string }[]
  const gate = rows.find(r => r.env === 'MERCURY_CHANGESET')
  const seam = rows.find(r => r.env === 'MERCURY_CHANGESET_DIR')
  check('MERCURY_CHANGESET is registered default-on/additive', gate?.kind === 'default-on' && gate?.tier === 'additive', `got kind ${gate?.kind} tier ${gate?.tier} | fix the MERCURY_CHANGESET row in FLAG_REGISTRY in the flag registry`)
  check('the evidence path exists', typeof gate?.evidence === 'string' && existsSync(join(import.meta.dir, '..', '..', gate.evidence)), `evidence is ${gate?.evidence} | point the MERCURY_CHANGESET row in the flag registry (FLAG_REGISTRY) at a file that exists`)
  check('MERCURY_CHANGESET_DIR is registered as the value seam', seam?.kind === 'value', `got kind ${seam?.kind} | fix the MERCURY_CHANGESET_DIR row in FLAG_REGISTRY in the flag registry`)
}

console.log('── §2 catalog byte-equivalence ──')
{
  const names = (): string[] => getAllBaseTools().map(t => (t as { name: string }).name)
  const withTool = names()
  check('default-ON: ChangeSet is in the catalog', withTool.includes('ChangeSet'), 'getAllBaseTools in src/tools/kit/toolList.ts must include ChangeSetTool when MERCURY_CHANGESET is unset')
  process.env.MERCURY_CHANGESET = '0'
  const without = names()
  check('=0: ChangeSet absent', !without.includes('ChangeSet'), 'getAllBaseTools in src/tools/kit/toolList.ts must drop ChangeSetTool when MERCURY_CHANGESET=0')
  check('=0: the remaining catalog is BYTE-IDENTICAL (names + order)', JSON.stringify(without) === JSON.stringify(withTool.filter(n => n !== 'ChangeSet')), 'getAllBaseTools in src/tools/kit/toolList.ts must only add or drop ChangeSet on the gate, leaving other tools and their order alone')
  delete process.env.MERCURY_CHANGESET
  check('the gate re-reads env LIVE (restored ⇒ present again)', names().includes('ChangeSet'), 'read the gate on every call in getAllBaseTools in src/tools/kit/toolList.ts and in changeSetEnabled in src/tools/engines/change-transaction/changeSetContracts.ts, not once at load')

  process.env.MERCURY_EDIT_HUNKS = '0'
  check('MERCURY_EDIT_HUNKS=0 also removes the tool (vocabulary composition)', !names().includes('ChangeSet'), 'changeSetEnabled in src/tools/engines/change-transaction/changeSetContracts.ts must be off when MERCURY_EDIT_HUNKS=0')
  delete process.env.MERCURY_EDIT_HUNKS
  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  check('MERCURY_CHANGE_RECEIPTS=0 also removes the tool (anchor composition)', !names().includes('ChangeSet'), 'changeSetEnabled in src/tools/engines/change-transaction/changeSetContracts.ts must be off when MERCURY_CHANGE_RECEIPTS=0')
  delete process.env.MERCURY_CHANGE_RECEIPTS
  check('clean env ⇒ enabled (default-ON)', changeSetEnabled() === true, 'changeSetEnabled in src/tools/engines/change-transaction/changeSetContracts.ts must default to on')
}

console.log('── §3 self-description + seams ──')
{
  const cap = (ChangeSetTool as { capability?: { gate?: string; class?: string; transaction?: { receipts?: boolean } } }).capability
  check('the tool self-declares its capability (gate + mutation class + receipts)', cap?.gate === 'MERCURY_CHANGESET' && cap?.class === 'mutation' && cap?.transaction?.receipts === true, `got ${JSON.stringify(cap)} | fix the capability declaration of ChangeSetTool in src/tools/change-set/ChangeSetTool.ts`)
  check('the tool declares itself deferrable (the local lane keeps it in the drawer) and loaded in full on cloud routes', (ChangeSetTool as { shouldDefer?: boolean; loadInFullOnCloud?: boolean }).shouldDefer === true && (ChangeSetTool as { loadInFullOnCloud?: boolean }).loadInFullOnCloud === true, 'set shouldDefer and loadInFullOnCloud to true on ChangeSetTool in src/tools/change-set/ChangeSetTool.ts')
  const pinned = mkdtempSync(join(tmpdir(), 'fulcrum-flag-cs-'))
  process.env.MERCURY_CHANGESET_DIR = pinned
  check('MERCURY_CHANGESET_DIR pins the durable home (hermetic seam)', changeSetHomeDir() === pinned, 'changeSetHomeDir in src/tools/engines/change-transaction/changeSetContracts.ts must return MERCURY_CHANGESET_DIR when it is set')
  delete process.env.MERCURY_CHANGESET_DIR
  check('unset ⇒ the config-home default', changeSetHomeDir().endsWith('changesets'), `got ${changeSetHomeDir()} | changeSetHomeDir in src/tools/engines/change-transaction/changeSetContracts.ts must default to a changesets folder under the config home`)
}

console.log(failures === 0 ? '\nprove-changeset-flag: GREEN' : `\nprove-changeset-flag: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
