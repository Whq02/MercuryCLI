;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'

const parent = process.env.MERCURY_CONFIG_DIR
assert.ok(parent)
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'openrouter-budgets-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM']) delete process.env[key]
process.env.OPENROUTER_API_KEY = 'fixture-budget-key'
const member = { scope: 'member', guardrail_id: 'member-fixture', budget_id: null, limit_usd: 50, spend_usd: 50, remaining_usd: 0, reset_interval: 'weekly', resets_at: '2026-11-02T00:00:00.000Z', include_byok: true }
const workspace = { scope: 'workspace', guardrail_id: null, budget_id: 'workspace-fixture', limit_usd: 100, spend_usd: 102, remaining_usd: -2, reset_interval: null, resets_at: null, include_byok: false }
let payload: Record<string, any> = { limit: 100, limit_remaining: 80, limit_reset: 'monthly', budgets: [member, workspace], effective_budget: member, free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } }
let mode: 'serve' | 'budget' | 'rate' = 'serve'
let requests = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req: Request) {
  const path = new URL(req.url).pathname
  if (path.endsWith('/key')) return Response.json({ data: payload })
  if (path.endsWith('/models')) return Response.json({ data: [{ id: 'fixture/model', context_length: 131072, supported_parameters: ['tools', 'reasoning'] }] })
  if (path.endsWith('/chat/completions')) {
    requests++
    if (mode === 'budget') return Response.json({ error: { code: 403, message: 'Org member budget limit exceeded (weekly limit).', metadata: { limit_source: 'openrouter_guardrail_budget', scope: 'member', limit_usd: 50, spend_usd: 50, resets_at: member.resets_at } } }, { status: 403 })
    if (mode === 'rate') return Response.json({ error: { code: 429, message: 'Rate limit exceeded' } }, { status: 429, headers: { 'retry-after': '2' } })
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture/model', choices: [{ index: 0, delta: { content: 'served' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('not found', { status: 404 })
} })
process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${server.port}/api/v1`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const state = await import('../../src/services/providers/openrouter/openrouterUsageState.ts')
const usageOwner = await import('../../src/services/providers/providerUsage.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  try { assert.deepEqual(actual, expected); console.log(`PASS ${label}`) }
  catch { failures++; console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`) }
}
const expectedMember = { scope: 'member', guardrailId: 'member-fixture', budgetId: null, limitUsd: 50, spendUsd: 50, remainingUsd: 0, resetInterval: 'weekly', resetsAt: member.resets_at, includeByok: true }
const expectedWorkspace = { scope: 'workspace', guardrailId: null, budgetId: 'workspace-fixture', limitUsd: 100, spendUsd: 102, remainingUsd: -2, resetInterval: null, resetsAt: null, includeByok: false }
const view = () => usageOwner.usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterObserved: () => state.openrouterObservedKeyUsage(), openrouterLimited: () => ({ state: 'clear' }) })
async function send() {
  const rows: any[] = []
  for await (const row of routedCallModel({ messages: [createUserMessage({ content: 'Hello.' })], systemPrompt: asSystemPrompt(['Fixture.']), thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal, options: { model: 'openrouter/fixture/model', querySource: 'overload_probe', isNonInteractiveSession: true, getToolPermissionContext: async () => ({ mode: 'default' }) } as never })) rows.push(row)
  return rows
}
try {
  const malformed = await state.probeOpenrouterKey('fixture-key', { fetchImpl: (async () => Response.json({ data: { budgets: [{ ...member, scope: { toString: 1 } }], effective_budget: { ...member, remaining_usd: 'unknown' }, free_model_daily_requests: { used: 'unknown', limit: 50, remaining: 0 } } })) as typeof fetch })
  check('malformed budget fields are omitted without coercion or guessed counters', malformed.state === 'accepted' ? [malformed.usage.budgets, malformed.usage.effectiveBudget, malformed.usage.freeModelDailyRequests] : malformed.state, [[], undefined, undefined])
  let read = await state.refreshOpenrouterKeyUsage({ force: true }) as any
  check('budget order and all fields retained', read?.budgets, [expectedMember, expectedWorkspace])
  check('effective budget is the provider choice, not smallest remaining', read?.effectiveBudget, expectedMember)
  check('free-model counter retained independently of key cap', read?.freeModelDailyRequests, { used: 50, limit: 50, remaining: 0 })
  const usage = view()
  const figureText = (usage.figures ?? []).map(row => `${row.value} ${row.label}`).join(' | ')
  check('usage shows enforced member budget and weekly reset', /enforced member budget/.test(figureText) && /weekly/.test(figureText) && figureText.includes(member.resets_at), true)
  check('usage keeps independent key cap and monthly reset', /key cap/.test(figureText) && /monthly/.test(figureText) && figureText.includes('80.00'), true)
  check('usage shows free-model daily remaining', /free-model requests/.test(figureText) && /0 of 50/.test(figureText) && /daily/.test(figureText), true)
  const before = requests
  check('zero budget and free requests never gate inference', (await send()).some(row => row.type === 'assistant' && !row.isApiErrorMessage) && requests === before + 1, true)
  mode = 'budget'
  const refusal = await send()
  check('provider budget refusal still reaches the caller', refusal.some(row => row.isApiErrorMessage && JSON.stringify(row).includes('Org member budget limit exceeded')), true)
  mode = 'rate'
  await send()
  check('Retry-After remains authoritative', mapCompatHttpFailure(429, { error: { message: 'Rate limit exceeded' } }, new Headers({ 'retry-after': '2' })).retryAfterMs, 2000)
  mode = 'serve'
  const resumedAt = requests
  check('manual resume asks provider despite remembered limit and budget', (await send()).some(row => row.type === 'assistant' && !row.isApiErrorMessage) && requests === resumedAt + 1, true)
  check('served reply clears remembered rate limit', state.openrouterLimitWindow().state, 'clear')
  payload = { limit: null, limit_remaining: null, limit_reset: null, budgets: [], effective_budget: null, free_model_daily_requests: null }
  read = await state.refreshOpenrouterKeyUsage({ force: true }) as any
  check('unlimited legacy key and absent effective budget remain distinct', [read?.limit, read?.limitRemaining, read?.limitReset, read?.budgets, read?.effectiveBudget, read?.freeModelDailyRequests], [null, null, null, [], null, null])
  check('unlimited key has no invented enforced budget', view().figures?.some(row => row.key === 'effective-budget'), false)
  payload = { limit: 100, limit_remaining: 80, budgets: [member, workspace], effective_budget: workspace, free_model_daily_requests: { used: 10, limit: null, remaining: null } }
  read = await state.refreshOpenrouterKeyUsage({ force: true }) as any
  check('lifetime budget and negative balance preserved', read?.effectiveBudget, expectedWorkspace)
  check('unlimited free counter preserved', read?.freeModelDailyRequests, { used: 10, limit: null, remaining: null })
  check('lifetime reset says never', view().figures?.some(row => row.key === 'effective-budget' && `${row.value} ${row.label}`.includes('never resets')), true)
  let releaseOld!: (response: Response) => void
  const oldRead = state.refreshOpenrouterKeyUsage({ force: true, fetchImpl: (() => new Promise<Response>(resolve => { releaseOld = resolve })) as typeof fetch })
  process.env.OPENROUTER_API_KEY = 'fixture-second-key'
  check('key change removes old budget reading immediately', state.openrouterObservedKeyUsage().usage, null)
  let freshRequested = false
  const freshRead = state.refreshOpenrouterKeyUsage({ force: true, fetchImpl: (async () => { freshRequested = true; return Response.json({ data: { limit: null, budgets: [], effective_budget: null } }) }) as typeof fetch })
  check('new key reading does not join old credential flight', freshRequested, true)
  releaseOld(Response.json({ data: { label: 'stale old key', ...payload } }))
  await Promise.all([oldRead, freshRead])
  check('old key response cannot republish budgets', (state.openrouterObservedKeyUsage().usage as any)?.budgets, [])
  payload = { limit: 100, limit_remaining: 80, limit_reset: 'monthly', budgets: [member, workspace], effective_budget: member, free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } }
  await state.refreshOpenrouterKeyUsage({ force: true })
  const painted = view()
  const families = [{ id: 'openrouter' as const, available: true, credentialed: true, credentialLabel: 'fixture key' }]
  const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  mock.module('../../src/services/providers/providerUsage.js', () => ({ ...usageOwner, providerFamilyPresences: () => families, usageForProvider: () => painted, refreshProviderUsage: async () => {}, providerSessionSpend: () => spend }))
  const catalogue = await import('../../src/services/providers/catalogueOnDemand.js')
  mock.module('../../src/services/providers/catalogueOnDemand.js', () => ({ ...catalogue, readCatalogueIfPending: async () => undefined }))
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { Usage } = await import('../../src/components/Settings/Usage.js')
  for (const [cols, rows] of [[180, 50], [80, 25]]) {
    const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { width: cols, height: rows, flexDirection: 'column' }, React.createElement(Usage, { width: cols! - 4, rowBudget: rows! - 4, compact: cols! < 100 }))))
    const mounted = await mountOffscreen(element, cols!, rows!)
    await waitFor(() => mounted.screen().includes('OpenRouter usage'), 5000)
    const screen = mounted.screen()
    check(`${cols}x${rows} usage renders both reset intervals and enforced budget`, screen.includes('member budget') && screen.includes('weekly') && screen.includes('monthly') && screen.includes('80.00') ? true : screen, true)
    if (cols === 80) check('compact usage keeps its existing three rows', screen.split('\n').filter(line => line.trim()).length, 3)
    mounted.unmount()
  }
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
