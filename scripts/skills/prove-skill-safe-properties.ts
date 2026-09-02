#!/usr/bin/env bun
// ============================================================================
//  prove-skill-safe-properties — a path-filtered skill and the bundled loop
//  skill auto-allow; a real grant still asks (release-hardening audit
//  rank 30).
//
//  The gap: SAFE_COMMAND_PROPERTIES named 'paths' — a property no built
//  command carries — while createSkillCommand writes the filter as
//  pathFilters, and the Command type declares only pathFilters. So
//  skillHasOnlySafeProperties failed on the first own key of every
//  conditional skill and checkPermissions fell through to ask: the user
//  answered "Run skill <name>?" on every invocation of a skill that
//  grants nothing, and inside a subagent or a headless run — where no
//  prompt can be shown — the same decision resolved to an automatic
//  denial, so a conditional skill that had just activated by touching a
//  matching file could not be used by the thread that activated it.
//  'menuDescription' was missing from the same list, which caught the
//  bundled loop skill.
//
//   L1 a `paths:`-filtered skill, built through the REAL transformer,
//      carries pathFilters and has only safe properties
//   L2 the bundled loop skill, registered through the REAL registry, has
//      only safe properties
//   L3 poison: a skill granting a non-read tool still fails the predicate
//      (the allowlist widening stopped at contract data); an ask-free
//      read-tool grant stays safe (the documented exception)
//
//  PROVE_SRC names another checkout's src (the A/B control: L1 and L2
//  read red there; L3 green on both).
// ============================================================================
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { skillHasOnlySafeProperties } = await import(join(SRC, 'tools/SkillTool/SkillTool.ts'))
const { createSkillCommand, parseSkillFrontmatterFields, transformSkillFiles } = await import(
  join(SRC, 'skills/loadSkillsDir.ts')
)
const { registerLoopSkill } = await import(join(SRC, 'skills/bundled/loop.ts'))
const { getBundledSkills } = await import(join(SRC, 'skills/bundledSkills.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

function buildSkill(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const loaded = transformSkillFiles([
    {
      filePath: '/scratch/.mercury/skills/cond-skill/SKILL.md',
      baseDir: '/scratch/.mercury/skills',
      frontmatter: { name: 'cond-skill', description: 'a conditional skill', ...frontmatter },
      content: 'Follow the conditional instructions.',
      source: 'projectSettings',
    },
  ]) as Array<{ command: Record<string, unknown> } | Record<string, unknown>>
  const first = loaded[0] as Record<string, unknown>
  // transformSkillFiles returns LoadedSkill records; the command rides on
  // them (or IS them, depending on shape) — resolve either.
  return (first?.command as Record<string, unknown> | undefined) ?? first
}

// ── L1: the path-filtered skill ────────────────────────────────────────────
console.log('L1 a paths-filtered skill auto-allows')
{
  // Built through the REAL builder, exactly as the conditional-skill road
  // does (parseSkillPathFilters → createSkillCommand with pathFilters).
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

// ── L2: the bundled loop skill ─────────────────────────────────────────────
console.log('L2 the bundled loop skill auto-allows')
{
  registerLoopSkill()
  const loop = (getBundledSkills() as Array<{ name: string }>).find(c => c.name === 'loop')
  t('the loop skill is registered', loop !== undefined)
  t('its registered command has only safe properties (menuDescription included)', loop !== undefined && skillHasOnlySafeProperties(loop as never) === true, loop ? `own keys: ${Object.keys(loop).join(',')}` : '')
}

// ── L3: poison ─────────────────────────────────────────────────────────────
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
