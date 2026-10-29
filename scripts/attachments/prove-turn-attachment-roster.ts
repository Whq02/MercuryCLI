import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setSystemTime } from 'bun:test'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'turn-attachment-roster-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
for (const name of ['entry.ts', 'later.ts']) writeFileSync(join(cwd, name), 'export const value = 1\n')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key'
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV', 'MERCURY_PROJECT_INTEL']) delete process.env[key]
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
process.chdir(cwd)
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
try {
  const bootstrap = await import(`${root}/src/bootstrap/state.ts`)
  bootstrap.setOriginalCwd(cwd)
  bootstrap.setProjectRoot(cwd)
  bootstrap.setCwdState(cwd)
  bootstrap.setSessionTrustAccepted(true)
  const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.ts`)
  enableConfigs()
  const { getDefaultAppState } = await import(`${root}/src/state/AppStateStore.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/utils/fileStateCache.ts`)
  const { getAttachments, createAttachmentMessage } = await import(`${root}/src/utils/attachments/orchestrator.ts`)
  const { normalizeAttachmentForAPI } = await import(`${root}/src/utils/messages/attachmentText.ts`)
  const { createUserMessage, createAssistantMessage } = await import(`${root}/src/utils/messages.ts`)
  const { getUserContext } = await import(`${root}/src/context.ts`)
  const { getUserContextAttachment } = await import(`${root}/src/utils/attachments/userContext.ts`)
  const posture = await import(`${root}/src/utils/cockpit/runtimePosture.ts`)
  const { replyMarkOf } = await import(`${root}/src/run-core/attachment-drain.ts`)
  const { FileReadTool } = await import(`${root}/src/tools/FileReadTool/FileReadTool.ts`)
  const { ToolSearchTool } = await import(`${root}/src/tools/ToolSearchTool/ToolSearchTool.ts`)
  const { WebFetchTool } = await import(`${root}/src/tools/WebFetchTool/WebFetchTool.ts`)
  const roster = (attachments: any[]) => attachments.filter(row => !row.capsuleReceipt).map(row => ({ kind: row.type, bytes: Buffer.byteLength(normalizeAttachmentForAPI(row).flatMap((message: any) => {
    const content = message.message.content
    return typeof content === 'string' ? [content] : content.filter((block: any) => block.type === 'text').map((block: any) => block.text)
  }).join('\n')) }))
  for (const mode of ['interactive', 'unattended']) {
    bootstrap.regenerateSessionId()
    posture.resetRuntimePostureForTest()
    bootstrap.setAskChannel(mode === 'interactive' ? 'operator' : 'none')
    if (mode === 'unattended') posture.markSessionNonInteractive('flow')
    setSystemTime(new Date('2026-10-28T12:00:00Z'))
    getUserContext.cache.clear()
    let state = getDefaultAppState()
    const context: any = {
      options: { commands: [], tools: [FileReadTool, ToolSearchTool], engineModel: 'claude-fable-5-1', mcpClients: [], mcpResources: {}, isNonInteractiveSession: mode === 'unattended', agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => state, setAppState: (fn: any) => { state = fn(state) }, abortController: new AbortController(),
      messages: [], readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(),
    }
    const first = await getAttachments('Read entry.ts.', context, [])
    context.messages = [createUserMessage({ content: 'Read entry.ts.' }), ...first.map(createAttachmentMessage), createAssistantMessage({ content: [{ type: 'tool_use', id: 'read-fixture', name: 'Read', input: { file_path: join(cwd, 'entry.ts') } }] })]
    context.options.tools.push(WebFetchTool)
    const history = JSON.stringify(context.messages)
    setSystemTime(new Date('2026-10-29T12:00:00Z'))
    getUserContext.cache.clear()
    const second = await getAttachments('Read later.ts.', context, [])
    console.log(JSON.stringify({ mode, turn: 1, roster: roster(first) }))
    console.log(JSON.stringify({ mode, turn: 2, roster: roster(second), sections: second.filter((row: any) => row.type === 'context_capsule').flatMap((row: any) => (row.sections ?? []).map((section: any) => ({ kinds: section.kinds, bytes: Buffer.byteLength(section.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')) }))) }))
    const cut = second.filter((row: any) => ['deferred_tools_delta', 'date_change', 'user_context', 'task_reminder', 'contract_reminder', 'harness_map_delta'].includes(row.type) || (row.type === 'context_capsule' && row.markdown))
    check(`${mode}: no post-first-turn reminder producers`, cut.length === 0, JSON.stringify(roster(cut)))
    check(`${mode}: the full first-use manual still arrives`, second.some((row: any) => row.type === 'critical_system_reminder' && row.content.startsWith('# Tool manual: Read\n')))
    check(`${mode}: prior request bytes are untouched`, JSON.stringify(context.messages) === history)
    context.messages.push(...second.map(createAttachmentMessage))
    const third = await getAttachments(null, context, [])
    console.log(JSON.stringify({ mode, turn: 3, roster: roster(third) }))
    check(`${mode}: no repeat of a delivered manual`, !third.some((row: any) => row.type === 'critical_system_reminder' && row.content.startsWith('# Tool manual: Read\n')))
    const mark = replyMarkOf({ timestamp: '2026-10-29T12:00:00Z', attachment: { type: 'queued_command', source_uuid: 'operator-follow-up', origin: { kind: 'human' } } })
    check(`${mode}: reply address belongs only to the screen`, mode === 'interactive' ? mark?.uuid === 'operator-follow-up' : mark === null)
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'fixture-boundary' }
    context.messages = [boundary, createAssistantMessage({ content: [{ type: 'tool_use', id: 'read-after-fold', name: 'Read', input: { file_path: join(cwd, 'entry.ts') } }] })]
    const afterFold = await getAttachments(null, context, [])
    check(`${mode}: a compaction restores the full tool manual`, afterFold.some((row: any) => row.type === 'critical_system_reminder' && row.content.startsWith('# Tool manual: Read\n')))
    check(`${mode}: the compaction boundary is retained`, context.messages[0] === boundary)
    check(`${mode}: every tool remains available`, context.options.tools.map((tool: any) => tool.name).join(',') === 'Read,ToolSearch,WebFetch')
    const changedInstructions = await getUserContextAttachment(context.messages, { instructions: 'The operator changed the project instructions.', environment: 'changed environment', currentDate: 'changed date' }, false)
    check(`${mode}: changed operator instructions still arrive without environment repetition`, changedInstructions.length === 1 && changedInstructions[0].body.includes('The operator changed the project instructions.') && !changedInstructions[0].body.includes('changed environment') && !changedInstructions[0].body.includes('changed date'))
    const repeatedInstructions = await getUserContextAttachment([...context.messages, ...changedInstructions.map(createAttachmentMessage)], { instructions: 'The operator changed the project instructions.', environment: 'another environment', currentDate: 'another date' }, false)
    check(`${mode}: unchanged instructions do not repeat`, repeatedInstructions.length === 0)
  }
} finally {
  setSystemTime()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
