import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'fork-replay-marker-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([{ kind: 'text', text: 'fixture summary' }])
process.env.ANTHROPIC_BASE_URL = api.url
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { runForkedAgent } = await import('../../src/utils/forkedAgent.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { FileStateCache } = await import('../../src/utils/fileStateCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
const history = [createUserMessage({ content: 'fixture request' }), createAssistantMessage({ content: 'fixture historical answer' })]
const before = JSON.stringify(history)
const prompt = createUserMessage({ content: 'Summarise this fixture.' })
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
const context = { abortController: new AbortController(), getAppState: () => state, setAppState() {}, messages: history, readFileState: new FileStateCache(100, 1024 * 1024), options: { tools: [], mcpClients: [], commands: [], engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } } as never
try {
  const result = await runForkedAgent({ promptMessages: [prompt], cacheSafeParams: { systemPrompt: asSystemPrompt(['fixture']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: history }, canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this fixture' })) as never, querySource: 'compact' as never, forkLabel: 'compact', maxTurns: 1 })
  await flushSessionStorage()
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
  const path = walk(home).find(path => /agent-acompact-.*\.jsonl$/.test(path))
  assert.ok(path, 'the compaction fork wrote its sidechain')
  const raw = readFileSync(path)
  const records = raw.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const old of history) {
    const row = records.find(record => record.recordId === old.uuid)
    assert.equal(row?.annotations?.replayOf, old.uuid, 'the inherited record names its original identity')
  }
  assert.equal(records.find(record => record.recordId === prompt.uuid)?.annotations?.replayOf, undefined)
  assert.equal(records.find(record => record.payload?.kind === 'output' && record.recordId !== history[1]!.uuid)?.annotations?.replayOf, undefined)
  const decoded = decodeTranscriptBuffer<any>(raw).entries
  assert.equal(decoded.find(row => row.uuid === history[1]!.uuid)?.message.content[0].text, 'fixture historical answer')
  assert.equal(JSON.stringify(history), before, 'the parent chat is unchanged')
  assert.ok(JSON.stringify(result.messages).includes('fixture summary'))
  console.log('PASS compact replay markers distinguish inherited records without changing the parent chat or the summary')
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
