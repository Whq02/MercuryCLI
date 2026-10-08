import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-refusal-fence-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const compact = await import('../../src/services/compact/compact.ts')
const prompts = await import('../../src/services/compact/prompt.ts')
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}`}`)
}
const context = (): any => ({ abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: new Map(), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } })
const forbidden = ['wrap your thinking', '<analysis>', 'Produce the analysis']
const requiresReasoning = (text: string): boolean => forbidden.some(phrase => text.includes(phrase))
const summary = 'The tags parser and its focused tests are complete. The operator asked for quoted commas and case-insensitive deduplication. Continue with CLI verification.'

try {
  fixture.script(request => requiresReasoning(JSON.stringify(request.body.messages)) ? { refusal: true } : { text: summary })
  let result: Awaited<ReturnType<typeof compact.compactConversation>> | undefined
  let error: string | undefined
  try {
    result = await compact.compactConversation([createUserMessage({ content: 'The operator asked for a tags parser. We edited tags.ts and ran 14 passing tests.' })], context(), { systemPrompt: ['Synthetic compaction proof.'] } as never, false)
  } catch (caught) { error = String(caught) }
  check('a provider that refuses reasoning extraction accepts the first fold', result !== undefined && fixture.captured.length === 1, { error, requests: fixture.captured.length })
  check('the accepted factual summary is installed', result?.summaryMessages.some(row => String(row.message.content).includes(summary)) === true)
  check('no refusal-retry note is needed when the instruction is lawful', result !== undefined && result.notes === undefined, result?.notes)
  check('the request retains max effort', fixture.captured[0]?.body.output_config !== undefined && (fixture.captured[0].body.output_config as { effort?: string }).effort === 'max')

  for (const [label, prompt] of [['full', prompts.getCompactPrompt()], ['capsule', prompts.getCompactPrompt(undefined, { runCapsulePresent: true })], ['from', prompts.getPartialCompactPrompt(undefined, 'from')], ['up_to', prompts.getPartialCompactPrompt(undefined, 'up_to')]]) {
    check(`${label} summary never asks to show thinking in an analysis block`, !requiresReasoning(prompt!))
    check(`${label} summary retains all ten handoff sections`, Array.from({ length: 10 }, (_, i) => `${i + 1}. `).every(section => prompt!.includes(section)))
    check(`${label} summary still forbids tools and asks for the summary now`, prompt!.startsWith('Reply with prose only — no tool calls of any kind.') && prompt!.endsWith('Produce the summary now.'))
  }
  const custom = 'Preserve the exact pending test command and its last observed result.'
  check('custom compaction instructions still ride intact', prompts.getCompactPrompt(custom).includes(custom) && prompts.getPartialCompactPrompt(custom, 'up_to').includes(custom))
  const restored = prompts.getCompactUserSummaryMessage('<analysis>old drafting scratchpad</analysis>\n<summary>Recorded facts only.</summary>')
  check('an older summary still restores without its drafting scratchpad', restored.includes('Summary:\nRecorded facts only.') && !restored.includes('old drafting scratchpad'))
} finally {
  await fixture.close()
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold-refusal-fence: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
