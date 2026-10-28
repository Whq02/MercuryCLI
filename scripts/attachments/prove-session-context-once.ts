import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'session-context-once-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
mkdirSync(join(scratch, 'work'), { recursive: true })
writeFileSync(join(scratch, 'work', 'notes.txt'), 'alpha\nbeta\n')
process.chdir(join(scratch, 'work'))
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getAttachments, createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const { getUserContextAttachment } = await import('../../src/utils/attachments/userContext.ts')
  const { getMcpInstructionsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
  const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
  const { capsuleShouldEmit } = await import('../../src/utils/attachments/contextCapsule.ts')
  const state = { toolPermissionContext: getEmptyToolPermissionContext(), mcp: { clients: [], commands: [], tools: [] }, tasks: {} }
  const client = (name: string) => ({ name, type: 'connected', instructions: `Use ${name} only after reading its input.` })
  const context: any = {
    options: { tools: [], engineModel: 'claude-fable-5-1', mcpClients: [client('fixture')], agentDefinitions: { activeAgents: [] } },
    getAppState: () => state, setAppState: () => {}, abortController: new AbortController(),
    messages: [], readFileState: createFileStateCacheWithSizeLimit(100),
  }
  const ask = createUserMessage({ content: 'Read notes.txt.' })
  const first = await getAttachments('Read notes.txt.', context, [])
  assert.equal(first.filter(a => a.type === 'mcp_instructions_delta').length, 1)
  assert.equal(first.filter(a => a.type === 'user_context').length, 1)
  context.messages = [ask, ...first.map(createAttachmentMessage), createAssistantMessage({ content: 'Ready.' })]
  const before = JSON.stringify(normalizeMessagesForAPI(context.messages).map(row => row.message))
  const next = await getAttachments(null, context, [])
  const repeats = next.filter(a => a.type === 'mcp_instructions_delta' || a.type === 'user_context' || a.type === 'context_capsule')
  console.log(JSON.stringify({ firstContextBytes: Buffer.byteLength(JSON.stringify(first)), repeatedContextBytes: Buffer.byteLength(JSON.stringify(repeats)), repeatedKinds: repeats.map(a => a.type) }))
  assert.equal(repeats.length, 0, 'omitting the optional history must use the tool context history, not announce session context again')
  assert.equal(JSON.stringify(normalizeMessagesForAPI(context.messages).map(row => row.message)), before, 'earlier rows remain byte-identical')
  const joined = getMcpInstructionsDeltaAttachment([client('fixture'), client('later')] as never, [], 'claude-fable-5-1', context.messages)
  assert.equal(joined.length, 1)
  assert.deepEqual((joined[0] as any).addedNames, ['later'])
  assert.equal(getMcpInstructionsDeltaAttachment([client('fixture'), client('later')] as never, [], 'claude-fable-5-1', [...context.messages, ...joined.map(createAttachmentMessage)]).length, 0)
  assert.equal((await getUserContextAttachment(context.messages)).length, 0)
  assert.equal(capsuleShouldEmit({ digest: 'same', refs: ['notes.txt'] }, { digest: 'same', refs: ['notes.txt'], semDigest: 'task' }), false)
  const reset = await getAttachments('Read notes.txt.', { ...context, messages: [] }, [])
  assert.equal(reset.filter(a => a.type === 'mcp_instructions_delta').length, 1, 'a fresh conversation restores the instructions')
  assert.equal(reset.filter(a => a.type === 'user_context').length, 1, 'a fresh conversation restores environment')
  console.log('PASS session context is append-only and unchanged context is not re-announced')
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
