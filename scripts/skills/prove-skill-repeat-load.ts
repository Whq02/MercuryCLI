import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'skill-repeat-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SESSION_KIT
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const { registerBundledSkill } = await import('../../src/skills/bundledSkills.ts')
const { SkillTool, expansionBodyOf } = await import('../../src/tools/SkillTool/SkillTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext
type Message = import('../../src/types/message.ts').Message

let expansions = 0
registerBundledSkill({
  name: 'repeat-fixture',
  description: 'An inline fixture whose body names its arguments.',
  getPromptForCommand: async (args: string) => {
    expansions++
    return [{ type: 'text', text: `Repeat fixture body for "${args}". Step one. Step two.` }]
  },
})

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const context = (messages: Message[]): ToolUseContext => ({
  messages,
  options: { tools: [SkillTool], engineModel: 'fixture-model', isNonInteractiveSession: true },
  abortController: new AbortController(),
  readFileState: new Map(),
  getAppState: () => ({ mcp: { commands: [] }, toolPermissionContext: getEmptyToolPermissionContext() }),
  setAppState: () => undefined,
}) as unknown as ToolUseContext
const parent = { uuid: 'repeat-proof-parent', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_repeat', name: 'Skill', input: {} }] } } as never
const canUse = async () => { throw new Error('fixture must not reach a permission request') }
type Call = { data: { alreadyLoaded?: true; commandName: string }; newMessages?: Message[] }
const bodiesOf = (messages: Message[] | undefined): string[] => (messages ?? []).map(expansionBodyOf).filter((text): text is string => text !== null)
const resultText = (data: Call['data']): string => String((SkillTool.mapToolResultToToolResultBlockParam(data as never, 'toolu_repeat') as { content: unknown }).content)

console.log('1 the first load sends the body')
const first = (await SkillTool.call({ skill: 'repeat-fixture', args: 'alpha' }, context([]), canUse, parent)) as Call
const firstBodies = bodiesOf(first.newMessages)
check('the body rides into the conversation once', firstBodies.length === 1 && firstBodies[0]!.includes('Repeat fixture body for "alpha"'), JSON.stringify(firstBodies))
check('the first load is not marked as a repeat', first.data.alreadyLoaded === undefined && resultText(first.data) === 'Launching skill: repeat-fixture', resultText(first.data))

console.log('2 the same call with the body still in context does not send it again')
const second = (await SkillTool.call({ skill: 'repeat-fixture', args: 'alpha' }, context(first.newMessages ?? []), canUse, parent)) as Call
check('no body message is added the second time', bodiesOf(second.newMessages).length === 0, JSON.stringify(bodiesOf(second.newMessages)))
check('the result says the skill is already loaded', second.data.alreadyLoaded === true && resultText(second.data) === 'Skill "repeat-fixture" is already loaded in this conversation; follow the instructions it gave above.', resultText(second.data))
check('the other messages of the expansion still ride (permissions attachment)', (second.newMessages ?? []).some(message => message.type === 'attachment'), JSON.stringify((second.newMessages ?? []).map(message => message.type)))

console.log('3 controls: different arguments, and a context without the body, send the body again')
const other = (await SkillTool.call({ skill: 'repeat-fixture', args: 'beta' }, context(first.newMessages ?? []), canUse, parent)) as Call
check('different arguments give a different body, which is sent', bodiesOf(other.newMessages).length === 1 && bodiesOf(other.newMessages)[0]!.includes('"beta"') && other.data.alreadyLoaded === undefined, JSON.stringify(bodiesOf(other.newMessages)))
const afterFold = (await SkillTool.call({ skill: 'repeat-fixture', args: 'alpha' }, context([]), canUse, parent)) as Call
check('with the body gone from context (a fold), it is sent again', bodiesOf(afterFold.newMessages).length === 1 && afterFold.data.alreadyLoaded === undefined)
check('every call expanded the skill (the dedupe compares rendered bytes, it never skips the render)', expansions === 4, String(expansions))

console.log(failures === 0 ? 'SKILL REPEAT LOAD GREEN' : `SKILL REPEAT LOAD RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
