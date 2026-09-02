#!/usr/bin/env bun
// ============================================================================
//  scripts/skills/prove-frontmatter-failclosed.ts — ONE law: a frontmatter
//  parse failure fails CLOSED at every loader.
//
//  E008-53 (S1) + 37/40/42: a YAML error in skill frontmatter returned
//  {frontmatter:{}} and the skills-dir loader built the skill on PERMISSIVE
//  defaults — the author's opt-OUTs (disable-model-invocation,
//  user-invocable: false, paths:) silently vanished and the skill went
//  from withheld to offered, while byte-identical input in an extension
//  was skipped. Agents: the same parse failure was indistinguishable from
//  a co-located reference document (silent), a non-string `name` vanished
//  silently, a non-string `description` was reported as MISSING, and
//  eight error-severity field diagnostics were logged and discarded while
//  the agent went live on defaults — the very file the writer refuses to
//  save.
//
//  §1 skills-dir: a valid opt-out loads as written (guard).
//  §2 skills-dir: the same file + one YAML error is REFUSED typed — never
//     a permissive skill; the refusal channel names the file and error.
//  §3 extensions: byte-identical input stays skipped with the defect line
//     (the loaders AGREE).
//  §4 agents: a parse failure lands in failedFiles typed (never silent).
//  §5 agents: a non-string `name` is a typed row, not a reference doc.
//  §6 agents: a non-string `description` is distinguished from absent.
//  §7 agents: an error-severity field diagnostic REFUSES the agent — the
//     loader holds the writer's own law.
//  §8 agents: a file with no `name` stays a silent reference doc (guard).
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-fm-failclosed-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const skillsMod = await import('../../src/skills/loadSkillsDir.ts')
const agentsMod = await import('../../src/tools/AgentTool/loadAgentsDir.ts')
const contributionsMod = await import('../../src/extensions/load/contributions.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const VALID = '---\nname: probe\ndescription: Author forbids model invocation.\ndisable-model-invocation: true\n---\n\nBody.\n'
const BROKEN = '---\nname: probe\ndescription: Author forbids model invocation.\ndisable-model-invocation: true\n  stray: indent\n---\n\nBody.\n'

let projectSeq = 0
function freshProject(): string {
  const cwd = join(scratch, `proj-${projectSeq++}`)
  mkdirSync(cwd, { recursive: true })
  return cwd
}
function writeProjectSkill(cwd: string, bytes: string): string {
  const dir = join(cwd, '.mercury', 'skills', 'probe')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, bytes)
  return file
}
async function loadProjectSkills(cwd: string): Promise<Awaited<ReturnType<typeof skillsMod.getSkillDirCommands>>> {
  skillsMod.clearSkillCaches()
  const prev = process.cwd()
  process.chdir(cwd)
  try {
    return await skillsMod.getSkillDirCommands(cwd)
  } finally {
    process.chdir(prev)
  }
}
function writeAgent(cwd: string, name: string, bytes: string): string {
  const dir = join(cwd, '.mercury', 'agents')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.md`)
  writeFileSync(file, bytes)
  return file
}
async function loadAgents(cwd: string): Promise<Awaited<ReturnType<typeof agentsMod.getAgentDefinitionsWithOverrides>>> {
  agentsMod.clearAgentDefinitionsCache()
  return agentsMod.getAgentDefinitionsWithOverrides(cwd)
}

console.log('============================================================')
console.log(' frontmatter fail-closed — one law at every loader')
console.log('============================================================')

console.log('[1] skills-dir: a valid opt-out loads as written')
{
  const cwd = freshProject()
  writeProjectSkill(cwd, VALID)
  const commands = await loadProjectSkills(cwd)
  const probe = commands.find(c => c.name === 'probe')
  check('the skill loads', probe !== undefined)
  check('disable-model-invocation survives', (probe as { disableModelInvocation?: boolean } | undefined)?.disableModelInvocation === true)
}

console.log('[2] skills-dir: one YAML error REFUSES the skill typed')
{
  const cwd = freshProject()
  const file = writeProjectSkill(cwd, BROKEN)
  const commands = await loadProjectSkills(cwd)
  const probe = commands.find(c => c.name === 'probe')
  check('the skill is NOT offered (fails closed, never permissive)', probe === undefined, probe ? `loaded with disableModelInvocation=${String((probe as { disableModelInvocation?: boolean }).disableModelInvocation)}` : '')
  const refusals = skillsMod.getSkillLoadRefusals?.() ?? []
  const row = refusals.find(r => r.path === file)
  check('the refusal channel names the file', row !== undefined, refusals.map(r => r.path).join(' | ') || 'channel empty or absent')
  check('the refusal names the parse failure', row !== undefined && /parse/i.test(row.error), row?.error ?? '')
}

console.log('[3] extensions: byte-identical input stays skipped — the loaders agree')
{
  const root = join(scratch, 'ext-root')
  mkdirSync(join(root, 'skills', 'probe'), { recursive: true })
  writeFileSync(join(root, 'skills', 'probe', 'SKILL.md'), BROKEN)
  const resolution = contributionsMod.resolveContributions(
    { name: 'pairkit', version: '1.0.0', description: 'fixture', contributes: { skills: ['./skills'] } } as Parameters<typeof contributionsMod.resolveContributions>[0],
    root,
    'pairkit@probe',
    contributionsMod.realProbes({ optionSet: () => false }),
  )
  check('the extension loader skips the file', resolution.skills.length === 0, resolution.skills.map(s => s.name).join(' '))
  check('the defect line stands', resolution.defects.some(d => d.includes('frontmatter did not parse')), resolution.defects.join(' | '))
}

console.log('[4] agents: a parse failure lands in failedFiles typed')
{
  const cwd = freshProject()
  const file = writeAgent(cwd, 'india-typo', '---\nname: india-typo\ndescription: An agent.\nkey with no colon\n---\n\nPrompt.\n')
  const result = await loadAgents(cwd)
  check('the agent is not active', !result.activeAgents.some(a => a.agentType === 'india-typo'))
  const row = (result.failedFiles ?? []).find(r => r.path === file)
  check('failedFiles carries the file', row !== undefined, (result.failedFiles ?? []).map(r => r.path).join(' | ') || 'no failedFiles')
  check('the row names the parse failure', row !== undefined && /parse/i.test(row.error), row?.error ?? '')
}

console.log('[5] agents: a non-string name is a typed row, not a reference doc')
{
  const cwd = freshProject()
  const file = writeAgent(cwd, 'numname', '---\nname: 12345\ndescription: An agent.\n---\n\nPrompt.\n')
  const result = await loadAgents(cwd)
  const row = (result.failedFiles ?? []).find(r => r.path === file)
  check('failedFiles carries the file', row !== undefined, (result.failedFiles ?? []).map(r => `${r.path}: ${r.error}`).join(' | ') || 'no failedFiles')
  check('the row names the type', row !== undefined && /name must be a string/.test(row.error), row?.error ?? '')
}

console.log('[6] agents: wrong-typed description is distinguished from absent')
{
  const cwd = freshProject()
  const file = writeAgent(cwd, 'descbool', '---\nname: mike-descbool\ndescription: true\n---\n\nPrompt.\n')
  const result = await loadAgents(cwd)
  const row = (result.failedFiles ?? []).find(r => r.path === file)
  check('failedFiles carries the file', row !== undefined)
  check('the row names the type, never "missing"', row !== undefined && /description must be a string \(got boolean\)/.test(row.error), row?.error ?? '')
  const absent = writeAgent(cwd, 'descnone', '---\nname: mike-descnone\n---\n\nPrompt.\n')
  const second = await loadAgents(cwd)
  const absentRow = (second.failedFiles ?? []).find(r => r.path === absent)
  check('an absent description still reads missing', absentRow !== undefined && /missing description/.test(absentRow.error), absentRow?.error ?? '')
}

console.log('[7] agents: an error-severity field diagnostic refuses the agent')
{
  const cwd = freshProject()
  const file = writeAgent(cwd, 'badfields', '---\nname: quebec-badfields\ndescription: An agent.\npermissionMode: acceptEdit\n---\n\nPrompt.\n')
  const result = await loadAgents(cwd)
  check('the agent is NOT live on defaults', !result.activeAgents.some(a => a.agentType === 'quebec-badfields'), 'active on the session default')
  const row = (result.failedFiles ?? []).find(r => r.path === file)
  check('failedFiles names the diagnostic', row !== undefined && /permission/i.test(row.error), row?.error ?? (result.failedFiles ?? []).map(r => r.error).join(' | '))
}

console.log('[8] agents: a file with no name stays a silent reference doc')
{
  const cwd = freshProject()
  writeAgent(cwd, 'NOTES', '# Design notes\n\nNo frontmatter name here.\n')
  writeAgent(cwd, 'valid-agent', '---\nname: valid-agent\ndescription: A valid agent.\n---\n\nPrompt.\n')
  const result = await loadAgents(cwd)
  check('the reference doc produces NO row', !(result.failedFiles ?? []).some(r => r.path.endsWith('NOTES.md')), (result.failedFiles ?? []).map(r => r.path).join(' | '))
  check('the valid agent loads', result.activeAgents.some(a => a.agentType === 'valid-agent'))
}

console.log('[9] skills-dir: an EMPTY SKILL.md is refused, named, and never offered as a blank skill')
{
  const cwd = freshProject()
  const file = writeProjectSkill(cwd, '')
  const commands = await loadProjectSkills(cwd)
  check('no skill is built from an empty file', !commands.some(c => c.name === 'probe'))
  const row = skillsMod.getSkillLoadRefusals().find(r => r.path === file)
  check('the refusal names the file and says it is empty', row !== undefined && row.error === skillsMod.EMPTY_SKILL_FILE_REASON, row?.error ?? 'no refusal')
}

console.log('[10] skills-dir: an opt-out key with a spelling no parser reads as a boolean fails CLOSED')
{
  const cwd = freshProject()
  const file = writeProjectSkill(cwd, '---\nname: probe\ndescription: Author meant to forbid model invocation.\ndisable-model-invocation: maybe\n---\n\nBody.\n')
  const commands = await loadProjectSkills(cwd)
  check('the skill is NOT offered on the permissive reading of "maybe"', !commands.some(c => c.name === 'probe'))
  const row = skillsMod.getSkillLoadRefusals().find(r => r.path === file)
  check('the refusal names the key and the value', row !== undefined && row.error === 'frontmatter key disable-model-invocation: "maybe" is not true or false', row?.error ?? 'no refusal')
  check('the pure owner answers the same for user-invocable', skillsMod.skillFrontmatterProblem({ 'user-invocable': 'yes' }) === 'frontmatter key user-invocable: "yes" is not true or false')
  check('true/false spellings and absent keys pass', skillsMod.skillFrontmatterProblem({ 'disable-model-invocation': 'true', 'user-invocable': false }) === null && skillsMod.skillFrontmatterProblem({}) === null)
  check('an unknown key is not a refusal (a skill from another harness keeps loading)', skillsMod.skillFrontmatterProblem({ 'bogus-key': 1, effort: 'enormous' }) === null)
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ FRONTMATTER FAIL-CLOSED — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
