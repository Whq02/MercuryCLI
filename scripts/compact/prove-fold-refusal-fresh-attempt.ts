import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'fold-fresh-attempt-'))
process.env.MERCURY_CONFIG_DIR = home
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
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}`}`)
}
const summary = 'The tags parser and its focused tests are complete. The operator asked for quoted commas and case-insensitive deduplication. Continue with CLI verification.'
const cache = { systemPrompt: ['Synthetic compaction proof.'] } as never
try {
  for (const automatic of [false, true]) {
    const events: Array<{ type: string }> = []
    const rows = [createUserMessage({ content: 'The operator asked for a tags parser. We edited tags.ts and ran 14 passing tests.' })]
    const original = JSON.stringify(rows)
    const readState = new Map([['tags.ts', { content: 'parser source', timestamp: 1 }]])
    const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: rows, readFileState: readState, onCompactProgress: (event: { type: string }) => events.push(event), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
    const label = automatic ? 'automatic' : 'manual'
    fixture.script([{ refusal: true }, { text: summary }])
    const before = fixture.captured.length
    let refused: string | undefined
    let result: Awaited<ReturnType<typeof compact.compactConversation>> | undefined
    try {
      result = await compact.compactConversation(rows, context as never, cache, automatic)
    } catch (error) { refused = error instanceof Error ? error.message : String(error) }
    check(`${label}: a refused first fold ends after one request`, fixture.captured.length - before === 1, fixture.captured.length - before)
    check(`${label}: the provider refusal is the one-line answer`, refused !== undefined && refused.includes('The model ended the response early (stop_reason: refusal)') && !refused.includes('\n'), refused)
    check(`${label}: no summary or outcome note is installed`, result === undefined, result?.notes)
    check(`${label}: no retry event is emitted`, !events.some(event => event.type === 'retry'), events)
    check(`${label}: the refused fold keeps history and read state`, JSON.stringify(rows) === original && readState.get('tags.ts')?.content === 'parser source')
    rows.push(createUserMessage({ content: 'Continue with the CLI verification on this next message.' }))
    fixture.script([{ text: summary }])
    const nextBefore = fixture.captured.length
    const next = await compact.compactConversation(rows, context as never, cache, automatic)
    check(`${label}: the next message makes a fresh request that lands`, fixture.captured.length - nextBefore === 1 && next.summaryMessages.length > 0)
    check(`${label}: the fresh request carries the next message and original history`, JSON.stringify(fixture.captured.at(-1)?.body.messages).includes('Continue with the CLI verification on this next message.') && JSON.stringify(fixture.captured.at(-1)?.body.messages).includes('We edited tags.ts'))
    check(`${label}: the accepted summary has no outcome note`, next.notes === undefined, next.notes)
    check(`${label}: the request retains max effort`, (fixture.captured.at(-1)?.body.output_config as { effort?: string })?.effort === 'max')
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold-fresh-attempt: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
