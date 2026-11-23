import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'skill-seat-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_SESSION_KIT
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const project = join(scratch, 'project')
const diskDir = join(project, '.mercury', 'skills', 'seat-disk-fork')
mkdirSync(diskDir, { recursive: true })
writeFileSync(join(diskDir, 'SKILL.md'), '---\ndescription: a fork-context fixture\ncontext: fork\n---\nA fixture that never runs.\n')
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const { setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.ts')
setSessionTrustAccepted(true)
const { registerBundledSkill } = await import('../../src/integrations/skills/bundledSkills.ts')
const { getSkillToolCommands } = await import('../../src/commands/catalogue/commands.ts')
const { getSkillListingAttachments, resetSentSkillNames } = await import('../../src/engine/attachment-shapes/skillListing.ts')
const { SkillTool } = await import('../../src/tools/skill/SkillTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
type ToolUseContext = import('../../src/tools/kit/tool.ts').ToolUseContext

let expansions = 0
registerBundledSkill({
  name: 'seat-bundled-fork',
  description: 'A fork-context fixture.',
  context: 'fork',
  aliases: ['seat-fork-alias'],
  getPromptForCommand: async () => {
    expansions++
    throw new Error('fixture stopped before launching a crewmate')
  },
})
registerBundledSkill({
  name: 'seat-inline',
  description: 'An inline fixture.',
  getPromptForCommand: async () => [{ type: 'text', text: 'Inline fixture.' }],
})
const commands = await getSkillToolCommands(project)
const disk = commands.find(command => command.name === 'seat-disk-fork')
if (disk?.type === 'prompt') {
  disk.getPromptForCommand = async () => {
    expansions++
    throw new Error('fixture stopped before launching a crewmate')
  }
}

let failures = 0
const check = (label: string, ok: boolean, detail = '', fix = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && fix ? ` — fix: ${fix}` : ''}`)
  if (!ok) failures++
}
const context = (agentId?: string): ToolUseContext => ({
  agentId,
  messages: [],
  options: { tools: [SkillTool], engineModel: 'fixture-model' },
  getAppState: () => ({ mcp: { commands: [] }, toolPermissionContext: getEmptyToolPermissionContext() }),
}) as unknown as ToolUseContext
const list = async (seat: ToolUseContext): Promise<string> => {
  resetSentSkillNames()
  return JSON.stringify(await getSkillListingAttachments(seat))
}
const forkNames = ['seat-bundled-fork', 'seat-disk-fork']
check('the real catalogue carries the disk and bundled fork fixtures', forkNames.every(name => commands.some(command => command.name === name && command.type === 'prompt' && command.context === 'fork')), '', 'the fixtures did not load as fork-context prompt commands; check getSkillToolCommands in src/commands/catalogue/commands.ts and registerBundledSkill in src/integrations/skills/bundledSkills.ts')
const main = context()
const mainList = await list(main)
check('the main seat lists both fork fixtures and the inline fixture', [...forkNames, 'seat-inline'].every(name => mainList.includes(name)), mainList, 'getSkillListingAttachments in src/engine/attachment-shapes/skillListing.ts must list fork skills when the context has no agentId')
for (const name of [...forkNames, 'seat-fork-alias', 'seat-inline']) {
  check(`the main seat accepts ${name}`, (await SkillTool.validateInput({ skill: name }, main)).result, '', 'validateInput in src/tools/skill/SkillTool.ts must accept every skill, fork included, when the context has no agentId')
}

const reason = 'Fork-context skills run only in the main session. Report what you checked to the session that launched you; it runs any independent verification.'
const parent = { uuid: 'seat-proof-parent', type: 'assistant', message: { content: [] } } as never
for (const agentId of ['seat-proof-crew', '']) {
  const crew = context(agentId)
  const listing = await list(crew)
  check(`defined agentId ${JSON.stringify(agentId)} never lists a fork skill`, forkNames.every(name => !listing.includes(name)), listing, 'the fork filter in getSkillListingAttachments (src/engine/attachment-shapes/skillListing.ts) must drop fork-context skills whenever agentId is defined, the empty string included')
  check(`defined agentId ${JSON.stringify(agentId)} keeps inline skills`, listing.includes('seat-inline'), listing, 'getSkillListingAttachments in src/engine/attachment-shapes/skillListing.ts must keep inline skills for a crewmate seat')
  check(`defined agentId ${JSON.stringify(agentId)} accepts inline skills`, (await SkillTool.validateInput({ skill: 'seat-inline' }, crew)).result, '', 'validateInput in src/tools/skill/SkillTool.ts must accept inline skills for a crewmate seat')
  for (const name of [...forkNames, 'seat-fork-alias']) {
    const validation = await SkillTool.validateInput({ skill: name }, crew)
    check(`defined agentId ${JSON.stringify(agentId)} refuses ${name} with the plain reason`, !validation.result && validation.message === reason, JSON.stringify(validation), 'validateInput in src/tools/skill/SkillTool.ts must refuse a fork-context skill when agentId is defined, with FORK_CONTEXT_REFUSAL as the message')
    let refusal = ''
    try {
      await SkillTool.call({ skill: name }, crew, async () => { throw new Error('fixture must not reach a permission request') }, parent)
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    check(`direct call also refuses ${name} from defined agentId ${JSON.stringify(agentId)}`, refusal === reason, refusal, 'SkillTool.call in src/tools/skill/SkillTool.ts must throw FORK_CONTEXT_REFUSAL for a fork-context skill when agentId is defined, before any permission request')
  }
}
check('no refused skill expands or reaches its launch path', expansions === 0, String(expansions), 'a refused fork skill must not reach getPromptForCommand; the fork refusal in src/tools/skill/SkillTool.ts must run before the skill is expanded')
check('the main listing remains unchanged after crew listings', await list(main) === mainList, '', 'the listing for the main seat must not change after crew listings; check the sent-skill state in src/engine/attachment-shapes/skillListing.ts')
console.log(failures === 0 ? 'CREWMATE SKILL CONTEXT GREEN' : `CREWMATE SKILL CONTEXT RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
