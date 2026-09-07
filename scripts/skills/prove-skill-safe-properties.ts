#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { skillHasOnlySafeProperties } = await import(join(SRC, 'tools/SkillTool/SkillTool.ts'))
const { createSkillCommand, parseSkillFrontmatterFields } = await import(join(SRC, 'skills/loadSkillsDir.ts'))
const { registerLoopSkill } = await import(join(SRC, 'skills/bundled/loop.ts'))
const { getBundledSkills } = await import(join(SRC, 'skills/bundledSkills.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

function buildSkill(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const markdownContent = 'Follow the conditional instructions.'
  const merged = { name: 'cond-skill', description: 'a conditional skill', ...frontmatter }
  const fields = parseSkillFrontmatterFields(merged, markdownContent, 'cond-skill')
  return createSkillCommand({
    name: 'cond-skill',
    markdownContent,
    source: 'projectSettings',
    baseDir: '/scratch/.mercury/skills',
    loadedFrom: 'project' as never,
    fields,
  }) as Record<string, unknown>
}

console.log('L1 a paths-filtered skill auto-allows')
{
  const frontmatter = { name: 'cond-skill', description: 'a conditional skill' }
  const markdownContent = 'Follow the conditional instructions.'
  const fields = parseSkillFrontmatterFields(frontmatter, markdownContent, 'cond-skill')
  const command = createSkillCommand({
    name: 'cond-skill',
    markdownContent,
    source: 'projectSettings',
    baseDir: '/scratch/.mercury/skills',
    loadedFrom: 'project' as never,
    fields,
    pathFilters: ['src'],
  }) as Record<string, unknown>
  const filters = (command as { pathFilters?: string[] }).pathFilters
  t('the built command carries pathFilters (the real property name)', Array.isArray(filters) && filters.length > 0, JSON.stringify({ keys: Object.keys(command ?? {}) }))
  t('a skill that grants nothing has only safe properties', skillHasOnlySafeProperties(command as never) === true, `own keys: ${Object.keys(command ?? {}).join(',')}`)
}

console.log('L2 the bundled loop skill auto-allows')
{
  registerLoopSkill()
  const loop = (getBundledSkills() as Array<{ name: string }>).find(c => c.name === 'loop')
  t('the loop skill is registered', loop !== undefined)
  t('its registered command has only safe properties (menuDescription included)', loop !== undefined && skillHasOnlySafeProperties(loop as never) === true, loop ? `own keys: ${Object.keys(loop).join(',')}` : '')
}

console.log('L3 poison — a real grant still asks; the ask-free read grant stays safe')
{
  const granting = buildSkill({ paths: ['src/**'], 'allowed-tools': ['Bash'] })
  const grants = (granting as { allowedTools?: string[] }).allowedTools
  t('the granting fixture is real (allowedTools present)', Array.isArray(grants) && grants.includes('Bash'), JSON.stringify(grants ?? null))
  t('a skill granting Bash still fails the predicate', skillHasOnlySafeProperties(granting as never) === false)
  const readOnly = buildSkill({ 'allowed-tools': ['Read', 'Grep', 'Glob'] })
  const readGrants = (readOnly as { allowedTools?: string[] }).allowedTools
  t('the read-grant fixture is real', Array.isArray(readGrants) && readGrants.length === 3, JSON.stringify(readGrants ?? null))
  t('the ask-free read grant stays safe (the documented exception)', skillHasOnlySafeProperties(readOnly as never) === true)
}

console.log(failures === 0 ? 'SKILL SAFE PROPERTIES: ALL PASS' : 'SKILL SAFE PROPERTIES: RED')
process.exit(failures)
