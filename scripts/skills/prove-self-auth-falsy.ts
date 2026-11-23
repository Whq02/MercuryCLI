#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'selfauth-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}

const skills = (await import('../../src/integrations/skills/loadSkillsDir.ts')) as unknown as {
  isSkillSelfAuthEnabled?: () => boolean
}
check('the reader is exported (isSkillSelfAuthEnabled)', typeof skills.isSkillSelfAuthEnabled === 'function', '', 'export isSkillSelfAuthEnabled from src/integrations/skills/loadSkillsDir.ts')
const enabled = skills.isSkillSelfAuthEnabled ?? ((): boolean => true)
const withVar = (v: string | undefined): boolean => {
  if (v === undefined) delete process.env.MERCURY_SKILL_SELF_AUTH
  else process.env.MERCURY_SKILL_SELF_AUTH = v
  return enabled()
}

console.log("§1 the card's spelling matrix")
{
  for (const v of [undefined, '1', 'true', 'yes', 'on', 'TRUE', '2', 'enabled', '']) {
    check(`${v === undefined ? 'unset' : `'${v}'`} keeps self-auth ON (default-on; junk stays default)`, withVar(v) === true, '', 'isSkillSelfAuthEnabled in src/integrations/skills/loadSkillsDir.ts must read MERCURY_SKILL_SELF_AUTH as on unless it is in the falsy vocabulary')
  }
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'disabled' === 'x' ? 'x' : ' 0', '0 ']) {
    check(`'${v}' turns self-auth OFF`, withVar(v) === false, '', 'isSkillSelfAuthEnabled in src/integrations/skills/loadSkillsDir.ts must treat 0, false, no and off as off, trimmed and case-insensitive')
  }
  check("'disabled' stays at the default (outside the one falsy vocabulary)", withVar('disabled') === true, '', 'isSkillSelfAuthEnabled in src/integrations/skills/loadSkillsDir.ts must not treat words outside the falsy vocabulary as off')
}

console.log('\n§2 the substrate row mirrors the read')
{
  const { substrateSnapshot } = await import('../../src/screen/cockpit-gauges/substrateSnapshot.ts')
  const rowFor = (v: string | undefined): { on: boolean; hint: string } | undefined => {
    if (v === undefined) delete process.env.MERCURY_SKILL_SELF_AUTH
    else process.env.MERCURY_SKILL_SELF_AUTH = v
    const snap = substrateSnapshot() as unknown as {
      data: { sections: Array<{ rows: Array<{ name: string; on: boolean; hint: string }> }> }
    }
    return snap.data.sections.flatMap(sec => sec.rows).find(g => g.name === 'Skill self-auth')
  }
  check("'false' reads OFF on the row", rowFor('false')?.on === false, JSON.stringify(rowFor('false')), 'the Skill self-auth row in src/screen/cockpit-gauges/substrateSnapshot.ts must follow isSkillSelfAuthEnabled')
  check(
    "the off hint no longer restates the exact-byte contract",
    rowFor('off')?.hint.includes('off — skills prompt like any tool') === true,
    rowFor('off')?.hint,
    'fix the Skill self-auth off hint in src/screen/cockpit-gauges/substrateSnapshot.ts to include: off — skills prompt like any tool',
  )
  check('unset reads ON', rowFor(undefined)?.on === true, '', 'the Skill self-auth row in src/screen/cockpit-gauges/substrateSnapshot.ts must read on when the variable is unset')
  delete process.env.MERCURY_SKILL_SELF_AUTH
}

console.log(failures === 0 ? '\nprove-self-auth-falsy: all green' : `\nprove-self-auth-falsy: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
