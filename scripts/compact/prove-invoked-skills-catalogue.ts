#!/usr/bin/env bun
// ============================================================================
//  prove-invoked-skills-catalogue — a compaction re-injects only the invoked
//  skills still in the catalogue (release-hardening audit rank 61).
//
//  The gap: the invoked_skills attachment was rebuilt from every stored
//  capture with no check that the skill was still in the table. A skill the
//  operator de-applied — dialed off in /skills, or its SKILL.md deleted —
//  came back into the freshly compacted context in full (up to 5,000
//  tokens per skill, 25,000 total) and the model resumed following
//  instructions the user believed removed; nothing short of ending the
//  session cleared it. The main thread's captures live under a null agent
//  id that only the forked path's own prune ever touched.
//
//    L1 a de-applied skill (absent from the catalogue) is not re-injected
//    L2 a skill still in the catalogue is
//    L3 no catalogue given ⇒ the capture is used as is (callers without a
//       table keep their behaviour)
//    L4 the fold hands the assembly the session's command table (source pin)
//
//  PROVE_SRC names another checkout's src (the A/B control: L1 and L4 read
//  red at the pre-fix tree).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'invoked-skills-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.NODE_ENV
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const bootstrap = await import(join(SRC, 'bootstrap/state.ts'))
const compact = await import(join(SRC, 'services/compact/compact.ts'))
type Attachment = { attachment: { type: string; skills?: Array<{ name: string }> } } | null
const build = compact.createSkillAttachmentIfNeeded as (agentId?: string, catalogue?: ReadonlyArray<{ name: string }>) => Attachment
const names = (a: Attachment): string[] => a?.attachment.skills?.map(s => s.name) ?? []

bootstrap.addInvokedSkill('kept-skill', '/rig/kept/SKILL.md', 'follow the kept instructions', null)
bootstrap.addInvokedSkill('removed-skill', '/rig/removed/SKILL.md', 'follow the removed instructions', null)

console.log('L1 a de-applied skill is not re-injected')
{
  const attachment = build(undefined, [{ name: 'kept-skill' }, { name: 'unrelated' }])
  check('the removed skill is absent from the attachment', !names(attachment).includes('removed-skill'), names(attachment).join(','))
  check('the kept skill is present', names(attachment).includes('kept-skill'), names(attachment).join(','))
}

console.log('L2 a skill still in the catalogue is re-injected')
{
  const attachment = build(undefined, [{ name: 'kept-skill' }, { name: 'removed-skill' }])
  check('both are present while both are in the table', names(attachment).includes('kept-skill') && names(attachment).includes('removed-skill'), names(attachment).join(','))
}

console.log('L3 no catalogue ⇒ the capture is used as is')
{
  const attachment = build(undefined)
  check('every capture is present', names(attachment).includes('kept-skill') && names(attachment).includes('removed-skill'), names(attachment).join(','))
  const none = build(undefined, [])
  check('an empty table re-injects nothing', none === null)
}

console.log('L4 the fold hands the assembly the session\'s command table (source pin)')
{
  const src = readFileSync(join(SRC, 'services/compact/compact.ts'), 'utf8')
  check('assembleAttachments passes context.options.commands', src.includes('createSkillAttachmentIfNeeded(context.agentId, context.options.commands)'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-invoked-skills-catalogue: ALL PASS' : `\nprove-invoked-skills-catalogue: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
