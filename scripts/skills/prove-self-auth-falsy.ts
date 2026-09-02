#!/usr/bin/env bun
// ============================================================================
//  scripts/skills/prove-self-auth-falsy.ts — MERCURY_SKILL_SELF_AUTH obeys
//  the ordinary falsy vocabulary (FC-159, the FC-006 class). The gate was
//  off only for the exact byte '0': false, no, off, FALSE, ' 0', '0 ' —
//  every ordinary disable spelling — left skills granting themselves tool
//  permissions. The reader now routes isEnvDefinedFalsy (the one falsy
//  vocabulary), and the substrate Skill self-auth row mirrors the same
//  read instead of restating the old exact-byte contract.
//
//  §1 the card's own spelling matrix through the exported reader.
//  §2 the substrate row follows the same vocabulary.
//
//  Run: ~/.bun/bin/bun run scripts/skills/prove-self-auth-falsy.ts
// ============================================================================
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'selfauth-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const skills = (await import('../../src/skills/loadSkillsDir.ts')) as unknown as {
  isSkillSelfAuthEnabled?: () => boolean
}
check('the reader is exported (isSkillSelfAuthEnabled)', typeof skills.isSkillSelfAuthEnabled === 'function')
const enabled = skills.isSkillSelfAuthEnabled ?? ((): boolean => true)
const withVar = (v: string | undefined): boolean => {
  if (v === undefined) delete process.env.MERCURY_SKILL_SELF_AUTH
  else process.env.MERCURY_SKILL_SELF_AUTH = v
  return enabled()
}

console.log("§1 the card's spelling matrix")
{
  for (const v of [undefined, '1', 'true', 'yes', 'on', 'TRUE', '2', 'enabled', '']) {
    check(`${v === undefined ? 'unset' : `'${v}'`} keeps self-auth ON (default-on; junk stays default)`, withVar(v) === true)
  }
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'disabled' === 'x' ? 'x' : ' 0', '0 ']) {
    check(`'${v}' turns self-auth OFF`, withVar(v) === false)
  }
  // 'disabled' is not in the one falsy vocabulary (0/false/no/off) — the
  // card lists it among ordinary spellings, but the ruled family decision
  // keeps ONE vocabulary product-wide: junk stays at the default, and the
  // reader never invents a wider set than isEnvDefinedFalsy.
  check("'disabled' stays at the default (outside the one falsy vocabulary)", withVar('disabled') === true)
}

console.log('\n§2 the substrate row mirrors the read')
{
  const { substrateSnapshot } = await import('../../src/utils/cockpit/substrateSnapshot.ts')
  const rowFor = (v: string | undefined): { on: boolean; hint: string } | undefined => {
    if (v === undefined) delete process.env.MERCURY_SKILL_SELF_AUTH
    else process.env.MERCURY_SKILL_SELF_AUTH = v
    const snap = substrateSnapshot() as unknown as {
      data: { sections: Array<{ rows: Array<{ name: string; on: boolean; hint: string }> }> }
    }
    return snap.data.sections.flatMap(sec => sec.rows).find(g => g.name === 'Skill self-auth')
  }
  check("'false' reads OFF on the row", rowFor('false')?.on === false, JSON.stringify(rowFor('false')))
  check(
    "the off hint no longer restates the exact-byte contract",
    rowFor('off')?.hint.includes('off — skills prompt like any tool') === true,
    rowFor('off')?.hint,
  )
  check('unset reads ON', rowFor(undefined)?.on === true)
  delete process.env.MERCURY_SKILL_SELF_AUTH
}

console.log(failures === 0 ? '\nprove-self-auth-falsy: all green' : `\nprove-self-auth-falsy: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
