#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

for (const k of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const) delete process.env[k]
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'stored-type-crew-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(HOME, { recursive: true, force: true }))

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const OLD_TYPES = ['mercury-' + 'general', 'general-' + 'purpose', 'mercury-' + 'verifier', 'verification', 'mercury-' + 'guide', 'mercury-' + 'architect', 'mercury-' + 'background', 'mercury-' + 'reviewer']

const storage = await import('../../src/utils/sessionStorage.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')
const { definitionForStoredType } = await import('../../src/tools/AgentTool/resumeAgent.ts')
const receipts = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const { getAgentDefinitionsWithOverrides } = await import('../../src/tools/AgentTool/loadAgentsDir.ts')
type Message = import('../../src/types/message.ts').Message
type AgentId = Parameters<typeof storage.writeAgentMetadata>[0]

section('§1 a saved sidecar reads as written — no translation table at the disk boundary')
for (const [index, stored] of OLD_TYPES.entries()) {
  const id = `stored-type-proof-${index}` as AgentId
  const sidecarPath = paths.getAgentMetadataPath(id)
  mkdirSync(dirname(sidecarPath), { recursive: true })
  writeFileSync(sidecarPath, JSON.stringify({ agentType: stored, description: `old helper ${index}`, model: 'claude-fable-5-1' }))
  const back = await storage.readAgentMetadata(id)
  check(`a sidecar carrying '${stored}' still opens and keeps its word`, back?.agentType === stored && back.description === `old helper ${index}` && back.model === 'claude-fable-5-1', JSON.stringify(back))
}
const constants = readFileSync(join(ROOT, 'src/tools/AgentTool/constants.ts'), 'utf8')
const pathsSource = readFileSync(join(ROOT, 'src/utils/sessionStorage/paths.ts'), 'utf8')
check('the Agent tool constants carry no stored-type translation table', !/Record<string, string>/.test(constants))
check('the sidecar reader rewrites no agent type', !/agentType: current/.test(pathsSource) && !/RETIRED_AGENT_TYPES/.test(pathsSource))

section('§2 the resume road: a known type is itself; any type Mercury does not know opens as mercury-crew')
const custom = { agentType: 'code-reviewer', whenToUse: 'the owner\'s own kind', source: 'userSettings', getSystemPrompt: () => 'custom' } as never
const roster = [...getBuiltInAgents(), custom] as never[]
check('a custom type the roster knows opens as itself', definitionForStoredType('code-reviewer', roster) === custom)
check('mercury-scout opens as the scout', (definitionForStoredType('mercury-scout', roster) as { agentType: string }).agentType === 'mercury-scout')
check('mercury-crew opens as the crew', (definitionForStoredType('mercury-crew', roster) as { agentType: string }).agentType === 'mercury-crew')
for (const stored of [...OLD_TYPES, 'mercury-frobnicate', undefined]) {
  check(`a record carrying ${stored === undefined ? 'no type' : `'${stored}'`} opens as mercury-crew`, (definitionForStoredType(stored, roster) as { agentType: string }).agentType === 'mercury-crew')
}
const resumeSource = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
check('the resume road picks its definition through that one selector', resumeSource.includes('definition = definitionForStoredType(meta?.agentType, definitions.activeAgents)'))
const live = await getAgentDefinitionsWithOverrides(HOME)
check('on the live roster of this tree the fallback is the real crew definition', (definitionForStoredType(OLD_TYPES[0], live.activeAgents) as { agentType: string }).agentType === 'mercury-crew' && live.activeAgents.some(a => a.agentType === 'mercury-crew'))

section('§3 a fixture transcript whose rows carry old helper types still opens')
const stamp = new Date('2026-09-20T10:00:00.000Z').toISOString()
const launch = (id: string, type: string, description: string): Message => ({
  type: 'assistant',
  uuid: `uuid-${id}`,
  timestamp: stamp,
  message: {
    id: `msg-${id}`,
    model: 'claude-fable-5-1',
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: `work as ${description}`, subagent_type: type, run_in_background: true } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
} as never)
const result = (id: string, text: string): Message => ({
  type: 'user',
  uuid: `uuid-result-${id}`,
  timestamp: stamp,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
} as never)
const messages: Message[] = [
  launch('toolu_old_general', OLD_TYPES[0]!, 'count the harbour'),
  launch('toolu_old_purpose', OLD_TYPES[1]!, 'index the lanterns'),
  launch('toolu_old_verifier', OLD_TYPES[2]!, 'check the piers'),
  result('toolu_old_general', `${receipts.BACKGROUND_LAUNCH_LINE} agentId: agent-old-1`),
  result('toolu_old_purpose', `${receipts.BACKGROUND_LAUNCH_LINE} agentId: agent-old-2`),
  result('toolu_old_verifier', `${receipts.BACKGROUND_LAUNCH_LINE} agentId: agent-old-3`),
]
const opened = receipts.backgroundLaunchReceipts(messages)
check('every launch row of the old chat is read into a receipt', opened.length === 3, JSON.stringify(opened.map(r => r.agentType)))
check('each receipt keeps the word the record carried', opened.map(r => r.agentType).join(',') === OLD_TYPES.slice(0, 3).join(','), opened.map(r => r.agentType).join(','))
check('the receipts carry the launch words beside the type', opened.every(r => r.description.length > 0 && r.prompt.startsWith('work as ')))
for (const receipt of opened) check(`the receipt for '${receipt.agentType}' resumes as mercury-crew`, (definitionForStoredType(receipt.agentType, roster) as { agentType: string }).agentType === 'mercury-crew')
const transcriptFile = join(HOME, 'old-chat.jsonl')
writeFileSync(transcriptFile, messages.map(m => JSON.stringify({ ...m, sessionId: 'old-chat' })).join('\n') + '\n')
const rows = readFileSync(transcriptFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Message)
check('the fixture transcript parses back into the same rows', rows.length === 6 && receipts.backgroundLaunchReceipts(rows).length === 3)

console.log(`\n${failures === 0 ? '✅' : '❌'} STORED TYPE OPENS AS CREW ${failures === 0 ? 'GREEN' : 'RED'} (${checks - failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
