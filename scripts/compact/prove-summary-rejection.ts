import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'summary-rejection-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { compactConversation, partialCompactConversation, PROSE_SKIPPED_KEY, ERROR_MESSAGE_NO_SUMMARY } = await import('../../src/engine/compaction/foldConversation.ts')
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
const check = (name: string, ok: boolean, details: unknown = '', hint = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(details)}${hint ? ` — ${hint}` : ''}`}`)
}
const refusal = 'I cannot summarize this conversation. I refuse to provide the requested summary. No summary will be provided.'
const cases = [
  ['prose refusal', refusal],
  ['apologetic refusal', "I'm sorry, but I can't provide a summary of this conversation."],
  ['wrapped refusal', `<summary>${refusal}</summary>`],
  ['whitespace', '   \n\t '],
  ['empty summary wrapper', '<summary> \n </summary>'],
  ['empty markdown fence', '```markdown\n\n```'],
] as const
const messages = [createUserMessage({ content: 'Keep the parser fact: quoted commas are supported, and 14 checks passed.' })]
const original = JSON.stringify(messages)
const good = 'The parser supports quoted commas. All 14 checks passed. Next, check the CLI and preserve the pending test command.'
try {
  for (const direction of ['full', 'from', 'up_to'] as const) {
    for (const [label, text] of cases) {
      const notices: string[] = []
      const ledger = new Map([[join(home, 'parser.ts'), { content: 'parser fact', timestamp: 17 }]])
      const reads = JSON.stringify([...ledger])
      const loaded = new Set(['nested-memory'])
      const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages, readFileState: ledger, loadedNestedMemoryPaths: loaded, addNotification: (notice: { text: string }) => notices.push(notice.text), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
      const cache = { systemPrompt: ['Synthetic summary validation proof.'] } as never
      fixture.script(() => ({ text }))
      let result: { summaryMessages?: Array<{ message: { content: unknown } }>; notes?: string[] } | undefined
      let error: unknown
      const before = fixture.captured.length
      try {
        result = direction === 'full'
          ? await compactConversation(messages, context, cache, false)
          : await partialCompactConversation(messages, direction === 'from' ? 0 : messages.length, context, cache, undefined, direction)
      } catch (caught) { error = String(caught) }
      if (direction === 'full') {
        const summary = result?.summaryMessages?.[0]?.message.content
        const card = typeof summary === 'string' ? summary : ''
        check(`${direction} ${label}: never installed as the summary — the ladder retries once on the text form, then lands the fold on the records with the cause named (the owner's ruling for 1.0.0-beta.38)`, result !== undefined && error === undefined && card.includes(`${PROSE_SKIPPED_KEY}: the answer `) && (result.notes ?? []).some(note => note.startsWith(PROSE_SKIPPED_KEY)) && card.split('\n').every(line => line.trim() !== refusal), { error, card: card.slice(0, 300) }, 'change the summary validation in src/engine/compaction/fold/summaryCheck.ts so a refusal or empty summary throws, and the retry ladder in src/engine/compaction/fold/ladder.ts so it lands on the records with the PROSE_SKIPPED_KEY note')
        check(`${direction} ${label}: no error notice; the answer and its one retry`, !notices.some(value => value.includes('Compaction error:')) && fixture.captured.length - before === 2, { notices, requests: fixture.captured.length - before }, 'the full road must make the answer plus one retry and raise no Compaction error notice; see the retry limit in src/engine/compaction/fold/ladder.ts')
      } else {
        check(`${direction} ${label}: the partial fold rejects instead of installing a boundary, and names the cause`, result === undefined && String(error).includes(ERROR_MESSAGE_NO_SUMMARY) && !String(error).includes('Failed to generate'), { error, installed: result !== undefined }, 'partialCompactConversation in src/engine/compaction/fold/partialFold.ts must throw the ERROR_MESSAGE_NO_SUMMARY cause for a refused or empty summary instead of installing a boundary')
        check(`${direction} ${label}: conversation and read state survive`, JSON.stringify(messages) === original && JSON.stringify([...ledger]) === reads && loaded.has('nested-memory'), '', 'the rejected partial fold in src/engine/compaction/fold/partialFold.ts must leave messages, readFileState and loadedNestedMemoryPaths unchanged')
        check(`${direction} ${label}: existing error notice is delivered`, notices.some(value => value.includes('Compaction error:')), '', 'a rejected partial fold must raise the Compaction error notice built in src/engine/compaction/fold/foldStatusAndRestore.ts')
        check(`${direction} ${label}: the partial road makes its one retry and no more`, fixture.captured.length - before <= 2, fixture.captured.length - before, 'the partial road in src/engine/compaction/fold/partialFold.ts must stop after one retry')
      }
    }
  }
  for (const text of [good, `<summary>${good}</summary>`, `\`\`\`markdown\n${good}\n\`\`\``, 'The provider said "I cannot summarize this conversation" on the previous attempt. The parser still passes 14 checks.']) {
    fixture.script(() => ({ text }))
    const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages, readFileState: new Map(), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
    let result: Awaited<ReturnType<typeof compactConversation>> | undefined
    try { result = await compactConversation(messages, context, { systemPrompt: ['Synthetic summary validation proof.'] } as never, false) } catch {}
    check('a fresh attempt accepts a substantive summary without imposing a format', result?.summaryMessages.length === 1, text, 'the summary validation in src/engine/compaction/fold/summaryCheck.ts rejected a substantive summary; it must accept any non-refusal, non-empty text')
  }
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} summary-rejection: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
