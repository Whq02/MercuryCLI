#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.NODE_ENV = 'test'
const HOME = mkdtempSync(join(tmpdir(), 'resumed-agent-context-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_TOOL_SEARCH = '0'
delete process.env.ANTHROPIC_BASE_URL

const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
const prefixRecord = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { boundPrefixRecordToEmit, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted } = prefixRecord
const recordedRequestContexts: (messages: readonly unknown[], boundKey: string) => { userContext?: Record<string, string>; systemContext?: Record<string, string> } | null =
  (prefixRecord as { recordedRequestContexts?: typeof recordedRequestContexts }).recordedRequestContexts ?? (() => null)
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { clearSystemPromptSectionState } = await import('../../src/bootstrap/state.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getSystemContext } = await import('../../src/context.ts')
const { z } = await import('zod/v4')

const model = 'claude-fable-5-1'
const tool = (name: string, description: string) => ({
  name,
  inputSchema: z.object({ q: z.string() }),
  inputJSONSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  prompt: async () => description,
  description: async () => description,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: false,
})
const mainOwner = 'main-conversation'
const agentOwner = 'agent-combat'
const mainMessages = [{ type: 'user', uuid: 'u-main', message: { role: 'user', content: 'main first' } }]
const agentMessages = [{ type: 'user', uuid: 'u-agent', message: { role: 'user', content: 'agent first' } }]
const plan = (owner: string, messages: unknown[], tools: unknown[]) =>
  planToolPayload({ model, tools: tools as never, messages: messages as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
const freshProcess = () => { clearToolRosterLatches(); clearToolRosterRestore(); clearToolSchemaCache(); clearSystemPromptSectionState(); resetBoundPrefixEmitted() }
const persist = (row: unknown): unknown => JSON.parse(j(row))
const memo = getSystemContext.cache as { set: (key: unknown, value: unknown) => unknown; clear: () => void; has: (key: unknown) => boolean }

const launchUserContext = { environment: 'Is a git repository: Yes', currentDate: "Today's date is 2026-10-26.", instructions: 'the project instructions as first sent' }
const launchSystemContext = { gitStatus: 'Current branch: main\n\nRecent commits:\n  aaaaaaa the commit the crewmate was launched on', gitRules: 'the git rules' }
const laterSystemContext = { gitStatus: 'Current branch: main\n\nRecent commits:\n  bbbbbbb a push that landed while the crewmate ran\n  aaaaaaa the commit the crewmate was launched on', gitRules: 'the git rules' }

section("§1 process 1 — a crewmate's first-exchange record carries the contexts its request sent; the main's record keeps its own road")
freshProcess()
memo.set(undefined, Promise.resolve({ ...launchSystemContext }))
const pool = [tool('Read', 'Read a file'), tool('Bash', 'Run a command')]
await plan(mainOwner, mainMessages, pool)
await plan(agentOwner, agentMessages, pool)
const agentRecord = await boundPrefixRecordToEmit(agentOwner, agentMessages as never, model, { rosterOnly: true, context: { userContext: launchUserContext, systemContext: launchSystemContext } })
const mainRecord = await boundPrefixRecordToEmit(mainOwner, mainMessages as never, model)
type Record_ = { type: string; boundKey: string; sections: unknown[]; systemContext: Record<string, string>; userContext?: Record<string, string> }
const agentData = agentRecord?.attachment as Record_ | undefined
const mainData = mainRecord?.attachment as Record_ | undefined
check('the crewmate wrote its record under its own key with no sections (its prompt is the definition\'s own)', agentData?.type === 'bound_prefix' && agentData.boundKey.startsWith(`${agentOwner}|u-agent|`) && agentData.sections.length === 0, j(agentData))
check('the crewmate\'s record carries the system context its request appended as the last system block', j(agentData?.systemContext) === j(launchSystemContext), j(agentData?.systemContext))
check('the crewmate\'s record carries the user context its request prepended', j(agentData?.userContext) === j(launchUserContext), j(agentData?.userContext))
check('the main conversation\'s record still reads the memo and carries no user context field', mainData?.type === 'bound_prefix' && j(mainData.systemContext) === j(launchSystemContext) && mainData.userContext === undefined, j(mainData))
const persistedAgent = persist(agentRecord)
const persistedMain = persist(mainRecord)

section('§2 the main thread compacted and the world moved; the crewmate resumes with what it recorded, not the live memo')
freshProcess()
memo.clear()
memo.set(undefined, Promise.resolve({ ...laterSystemContext }))
const restoredKey = restoreBoundPrefixFromMessages([persistedAgent as never], { rosterOnly: true })
check('the restore returns the crewmate\'s key', restoredKey === agentData?.boundKey, String(restoredKey))
const recorded = restoredKey === null ? null : recordedRequestContexts([persistedAgent as never], restoredKey)
check('the recorded system context is the launch-time git status, not the post-fold one', j(recorded?.systemContext) === j(launchSystemContext), j(recorded))
check('the recorded user context is the launch-time one', j(recorded?.userContext) === j(launchUserContext), j(recorded))
check('the crewmate\'s restore never seeds the main conversation\'s memo', j(await getSystemContext()) === j(laterSystemContext), j(await getSystemContext()))
const mainRestored = restoreBoundPrefixFromMessages([persistedMain as never])
check('the main\'s own restore still seeds its memo from its record', mainRestored === mainData?.boundKey && j(await getSystemContext()) === j(launchSystemContext), j(await getSystemContext()))

section('§3 an older crewmate transcript (a record without contexts) resumes the way it did: nothing recorded, the live road')
freshProcess()
const bare = { ...(persistedAgent as { attachment: Record_ }), attachment: { ...(persistedAgent as { attachment: Record_ }).attachment, systemContext: {}, userContext: undefined } }
const bareKey = restoreBoundPrefixFromMessages([bare as never], { rosterOnly: true })
check('a record with empty contexts yields no override', bareKey !== null && recordedRequestContexts([bare as never], bareKey) === null)
check('a transcript with no record yields no override', recordedRequestContexts([agentMessages[0] as never], 'none') === null)

section('§4 the resume and the launch wire the record end to end')
{
  const resume = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
  check('a resume reads the recorded contexts for the restored key', resume.includes('recordedRequestContexts(transcript.messages, restoredKey)'))
  check('a resume hands the recorded user and system contexts to the run as its override', resume.includes('userContext: recordedContexts.userContext') && resume.includes('systemContext: recordedContexts.systemContext'))
  const run = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('the run takes the override before composing live', run.includes('override?.userContext ?? (await getUserContext())') && run.includes('override?.systemContext ?? (await getSystemContext())'))
  check('an instruction-profile slice never reshapes a recorded user context', run.includes("if (override?.userContext === undefined) {\n            userContext = { ...userContext }"))
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check('the turn machine hands a crewmate\'s own request contexts to its record', machine.includes('{ rosterOnly: true, context: { userContext: run.userContext, systemContext: run.params.systemContext } }'))
}

freshProcess()
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} resumed agent context: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
