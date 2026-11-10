import { proofHome } from '../lib/hermetic.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const [arm, list] = process.argv.slice(-2) as [string, string]
const models = list.split(',')
const KEPT = new Set(['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE', 'MERCURY_TMPDIR', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_SUITE_OF_ONE'])
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|MERCURY_)/.test(name) && !KEPT.has(name)) delete process.env[name]
}
process.env.MERCURY_CONFIG_DIR = proofHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
if (arm === 'subscriber') {
  writeFileSync(join(proofHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fixture-subscriber', refreshToken: null, expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile', 'user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
  } }))
} else {
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
}

const turns: ScriptedTurn[] = models.map(() => ({ kind: 'text', text: 'ready' }))
const fixture = await startFixtureApi(turns, { captureAllHeaders: true })
process.env.ANTHROPIC_BASE_URL = fixture.url
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = fixture.url
const nativeFetch = globalThis.fetch
const loopbackFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== fixture.url) throw new Error(`non-fixture request refused: ${url.origin}`)
  return nativeFetch(input, init)
}
globalThis.fetch = loopbackFetch

let failed = ''
const rows: Array<{ asked: string; sent: unknown; beta: string; bearer: boolean; window: number; error: string }> = []
let subscriber = false
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { isClaudeAISubscriber } = await import('../../src/utils/auth.ts')
  const { getContextWindowForModel, filterAllowedSdkBetas } = await import('../../src/utils/model/capabilities.ts')
  const { setSdkBetas } = await import('../../src/bootstrap/state.ts')
  subscriber = isClaudeAISubscriber()
  if (arm === 'key-preview') setSdkBetas(filterAllowedSdkBetas(['context-1m-2025-08-07']))
  for (const model of models) {
    const probe = `window probe for ${model}`
    let error = ''
    for await (const event of routedCallModel({
      messages: [createUserMessage({ content: probe })],
      systemPrompt: asSystemPrompt(['You answer in one word.']),
      thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal,
      options: {
        model, querySource: 'sdk', isNonInteractiveSession: true,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        agents: [], mcpTools: [], hasAppendSystemPrompt: false, enablePromptCaching: true, fetchOverride: loopbackFetch,
      },
    } as never)) {
      const row = event as { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ type: string; text?: string }> } }
      if (row.type === 'assistant' && row.isApiErrorMessage) error = (row.message?.content ?? []).map(block => block.text ?? '').join('')
    }
    const request = fixture.messageRequests().filter(r => JSON.stringify(r.body).includes(probe)).at(-1)
    rows.push({
      asked: model,
      sent: (request?.body as { model?: unknown } | undefined)?.model ?? null,
      beta: request?.headers['anthropic-beta'] ?? '',
      bearer: typeof request?.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer '),
      window: getContextWindowForModel(model),
      error,
    })
  }
} catch (error) {
  failed = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
}
await fixture.close()
removeScratch(proofHome)
console.log(`CAPTURE ${JSON.stringify({ arm, subscriber, rows, failed })}`)
process.exit(failed === '' ? 0 : 1)
