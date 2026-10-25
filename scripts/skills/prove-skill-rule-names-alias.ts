#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'skill-alias-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { registerBundledSkill } = await import(join(SRC, 'skills/bundledSkills.ts'))
const { registerLoopSkill } = await import(join(SRC, 'skills/bundled/loop.ts'))
const { getSkillToolCommands } = await import(join(SRC, 'commands.ts'))
const { SkillTool } = await import(join(SRC, 'tools/SkillTool/SkillTool.ts'))
const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext

registerLoopSkill()
registerBundledSkill({
  name: 'alias-fixture',
  description: 'A fixture with one alias and only safe properties.',
  aliases: ['alias-fixture-other'],
  getPromptForCommand: async () => [{ type: 'text', text: 'Fixture.' }],
})
const commands = await getSkillToolCommands(project)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
type Rules = { allow?: string[]; deny?: string[] }
const context = (rules: Rules): ToolUseContext => ({
  messages: [],
  options: { tools: [SkillTool], engineModel: 'fixture-model' },
  getAppState: () => ({
    mcp: { commands: [] },
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { localSettings: rules.allow ?? [] },
      alwaysDenyRules: { localSettings: rules.deny ?? [] },
    },
  }),
}) as unknown as ToolUseContext
type Verdict = { behavior: string; decisionReason?: { type: string } }
const decide = async (skill: string, rules: Rules): Promise<Verdict> => (await SkillTool.checkPermissions({ skill }, context(rules))) as Verdict
const verdict = async (skill: string, rules: Rules): Promise<string> => (await decide(skill, rules)).behavior

const loop = commands.find(command => command.name === 'loop') as { aliases?: string[] } | undefined
check('the real catalogue carries loop with its proactive alias and the fixture with its alias', loop?.aliases?.includes('proactive') === true && commands.some(command => command.name === 'alias-fixture'), JSON.stringify(loop?.aliases))

console.log('A1 deny by the canonical name refuses the alias')
check('deny Skill(loop): loop is denied', (await verdict('loop', { deny: ['Skill(loop)'] })) === 'deny')
check('deny Skill(loop): proactive is denied too', (await verdict('proactive', { deny: ['Skill(loop)'] })) === 'deny')
check('deny Skill(alias-fixture): alias-fixture-other is denied', (await verdict('alias-fixture-other', { deny: ['Skill(alias-fixture)'] })) === 'deny')
check('a leading slash on the call changes nothing', (await verdict('/proactive', { deny: ['Skill(loop)'] })) === 'deny')

console.log('A2 deny by the alias refuses the canonical name')
check('deny Skill(proactive): loop is denied', (await verdict('loop', { deny: ['Skill(proactive)'] })) === 'deny')
check('deny Skill(alias-fixture-other): alias-fixture is denied', (await verdict('alias-fixture', { deny: ['Skill(alias-fixture-other)'] })) === 'deny')

console.log('A3 a name* deny covers the alias')
check('deny Skill(alias-fix*): alias-fixture-other is denied', (await verdict('alias-fixture-other', { deny: ['Skill(alias-fix*)'] })) === 'deny')

console.log('A4 allow by the alias allows the canonical name, and deny still outranks allow')
{
  const byRule = await decide('alias-fixture', { allow: ['Skill(alias-fixture-other)'] })
  check('allow Skill(alias-fixture-other): alias-fixture is allowed BY THE RULE (not the safe-property fallback)', byRule.behavior === 'allow' && byRule.decisionReason?.type === 'rule', JSON.stringify(byRule.decisionReason))
}
check('deny Skill(alias-fixture) + allow Skill(alias-fixture-other): the deny wins for either name', (await verdict('alias-fixture', { deny: ['Skill(alias-fixture)'], allow: ['Skill(alias-fixture-other)'] })) === 'deny' && (await verdict('alias-fixture-other', { deny: ['Skill(alias-fixture)'], allow: ['Skill(alias-fixture-other)'] })) === 'deny')

console.log('A5 control')
check('no rule: the fixture auto-allows under both names (safe properties)', (await verdict('alias-fixture', {})) === 'allow' && (await verdict('alias-fixture-other', {})) === 'allow')
check('an unrelated deny leaves it alone', (await verdict('alias-fixture-other', { deny: ['Skill(loop)'] })) === 'allow')
check('an unknown skill name still asks', (await verdict('no-such-skill', { deny: ['Skill(loop)'] })) === 'ask')

console.log(failures === 0 ? 'SKILL RULE NAMES ALIAS GREEN' : `SKILL RULE NAMES ALIAS RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
