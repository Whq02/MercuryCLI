#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startJevStandin, openrouterFailure } from './lib/jevStandin.ts'

const home = mkdtempSync(join(tmpdir(), 'jev-roads-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const official = await startJevStandin()
const router = await startJevStandin('openrouter')
process.env.MERCURY_JEV_BASE = official.base
process.env.MERCURY_OPENROUTER_API_BASE = `${router.base}/api/v1`
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.ts')
const key = await import('../../src/services/jev/jevKey.ts')
const ledger = await import('../../src/services/jev/jevLedger.ts')
const status = await import('../../src/services/jev/jevStatus.ts')
const client = await import('../../src/services/jev/jevClient.ts')
const tool = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const command = await import('../../src/commands/jev/jev.tsx')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const assembly = await import('../../src/tools/JevEvalTool/jevEvalRequest.ts')
const facts = await import('../../src/services/jev/jevSessionFacts.ts')
const contract = await import('../../src/services/jev/jevContract.ts')
const input = { goal: 'Check supplied evidence', evidence: { fact: 'A measured fact' }, questions: [{ id: 'yes', kind: 'noul' as const, ask: 'Does the fact support this?' }] }
const OR_KEY = 'proof-openrouter-key-not-real'
const TS_KEY = 'proof-typesafe-key-not-real'
const road = () => (setting.readJevSettings() as unknown as { road?: string }).road
let checks = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}
const routerCommandPath = '../../src/commands/jevor/jevor.ts'
const routerCommand = await import(routerCommandPath).catch(() => ({ call: async () => ({ type: 'text', value: '/jevor is not registered' }) }))
async function select(words: string): Promise<void> {
  await (words.startsWith('/jevor ') ? routerCommand.call(words.slice(7), {} as never) : command.call(words, {} as never))
  popup.closeSettingsPopup()
}
try {
  check('absent road migrates to official without switching JEV on', road() === 'official' && !setting.jevEnabled())
  secrets.writeStoredOpenrouterApiKey(OR_KEY)
  const off = await tool.jevEvalCall(input)
  check('OpenRouter sign-in alone neither lights the roster nor sends a request', !tool.jevEvalEnabled() && off.status === 'off' && router.received.length + official.received.length === 0)
  await select('/jevor on')
  check('/jevor on stores the explicit road and turns on', road() === 'openrouter' && setting.jevEnabled(), JSON.stringify(setting.readJevSettings()))
  key.storeJevApiKey(TS_KEY)
  const answered = await tool.jevEvalCall(input)
  const sent = router.received[0]
  check('the OpenRouter request alone reaches POST /api/v1/systemone', router.received.length === 1 && official.received.length === 0 && sent?.method === 'POST' && sent?.path === '/api/v1/systemone', `${router.received.length} router / ${official.received.length} official`)
  check('OpenRouter gets its own key, the documented pin, and the deny/fallback block', sent?.headers.authorization === `Bearer ${OR_KEY}` && JSON.stringify(sent?.body) === JSON.stringify({ model: 'typesafe/jev-1.13', state: input.evidence, questions: { yes: { type: 'noul', instructions: input.questions[0]!.ask } }, provider: { data_collection: 'deny', allow_fallbacks: false } }))
  check('served model is printed and the meter uses the stated cost, not token arithmetic', answered.status === 'ok' && answered.text.includes('typesafe/jev-1.13-20260917') && ledger.jevLedgerSnapshot().spendUsd === 0.0007319, answered.text)
  const callFacts = facts.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus())
  check('the additive fact records which road answered', (callFacts as unknown as { road?: string }).road === 'openrouter')
  check('the last-call fact and result header report the actual generation and stated cost', (callFacts as unknown as { lastRequestId?: string }).lastRequestId === 'gen-dec-fixture-header' && answered.text.includes('id=gen-dec-fixture-header') && answered.text.includes('stated $0.0007319'))
  void contract
  const request = assembly.assembleJevEvalRequest(input)
  if (!request.ok) throw new Error(request.reason)
  const direct = await client.jevSystemOne(request.request, OR_KEY, { road: 'openrouter' } as never)
  check('OpenRouter generation header and cost survive decoding', direct.ok && direct.requestId === 'gen-dec-fixture-header' && (direct.response.usage as unknown as { cost?: number }).cost === 0.0007319)
  router.next({ status: 200, body: { id: 'gen-dec-body-only', model: 'typesafe/jev-1.13-20260917', answers: { yes: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 100, output_tokens: 2, cost: 0 } } })
  const bodyId = await client.jevSystemOne(request.request, OR_KEY, { road: 'openrouter' } as never)
  check('body id is the fallback and a stated zero cost is retained', bodyId.ok && bodyId.requestId === 'gen-dec-body-only' && (bodyId.response.usage as unknown as { cost?: number }).cost === 0)
  const cases = [
    { code: 403, source: undefined, kind: 'provider-refused', final: false },
    { code: 402, source: 'openrouter_in_flight_budget', kind: 'in-flight-budget', final: false },
    { code: 402, source: 'openrouter_key_limit', kind: 'key-limit', final: true },
    { code: 402, source: 'openrouter_credits', kind: 'provider-credit', final: true },
    { code: 402, source: undefined, kind: 'provider-refused', final: false },
    { code: 404, source: undefined, kind: 'model-not-served', final: true },
    { code: 408, source: undefined, kind: 'provider-down', final: false },
    { code: 413, source: undefined, kind: 'bad-request', final: false },
    { code: 401, source: undefined, kind: 'invalid-key', final: true },
  ]
  for (const c of cases) {
    ledger.resetJevLedger()
    setting.setJevEnabled(true)
    const fixture = openrouterFailure(c.code, c.source)
    const outcome = await client.jevSystemOne(request.request, OR_KEY, { road: 'openrouter', fetchImpl: async () => new Response(JSON.stringify(fixture.body), { status: fixture.status, headers: fixture.headers }) } as never)
    const failure = outcome.ok ? undefined : outcome.failure
    check(`OpenRouter ${c.code} ${c.source ?? ''} has its own map`, failure?.kind === c.kind, JSON.stringify(failure))
    if (!failure) continue
    const metadata = failure as unknown as { limitSource?: string; providerCode?: string }
    check('metadata and generation id ride the failure', metadata.limitSource === c.source && metadata.providerCode === 'fixture-code' && failure.requestId === 'gen-dec-fixture-failure')
    const now = Date.now()
    ledger.noteJevWireFailure(failure, now, () => 0.5)
    const current = status.jevStatus(undefined, now)
    check(`${c.code} stays switched on with the right finality`, setting.jevEnabled() && status.jevStatusIsFinalForSession(current.kind) === c.final, JSON.stringify(current))
    if (c.source === 'openrouter_in_flight_budget') {
      check('transient credit words wait exactly Retry-After, then become ready', current.retryInMs === 2000 && status.jevStatus(undefined, now + 2001).kind === 'ready', JSON.stringify(current))
    }
    if (c.source === 'openrouter_credits' || c.code === 401) {
      secrets.writeStoredOpenrouterApiKey(`${OR_KEY}-${c.code}`)
      check('a changed OpenRouter credential clears only its stale credential hold', status.jevStatus().kind === 'ready')
      secrets.writeStoredOpenrouterApiKey(OR_KEY)
    }
  }
  ledger.resetJevLedger()
  setting.setJevAllowanceUsd(0.002)
  await tool.jevEvalCall(input)
  check('the OpenRouter cap holds its stated spend plus its 32k worst call', status.jevStatus().kind === 'allowance-hit')
  await select('on')
  check('/jev on selects official, retaining its independent default cap and untouched meter', road() === 'official' && setting.readJevSettings().allowanceUsd === 20 && ledger.jevLedgerSnapshot().spendUsd === 0)
  const officialAnswer = await tool.jevEvalCall(input)
  check('official sends only its own key and model, without OpenRouter provider preferences', officialAnswer.status === 'ok' && official.received.at(-1)?.headers.authorization === `Bearer ${TS_KEY}` && (official.received.at(-1)?.body as { model?: string })?.model === 'jev-1.13.0' && !('provider' in (official.received.at(-1)?.body as object)))
  await select('/jevor on')
  check('returning to OpenRouter restores its cap, spend and hold', setting.readJevSettings().allowanceUsd === 0.002 && ledger.jevLedgerSnapshot().spendUsd === 0.0007319 && status.jevStatus().kind === 'allowance-hit')
  ledger.resetJevLedger()
  router.next({ status: 200, delayMs: 40, headers: { 'x-generation-id': 'gen-dec-road-switch' }, body: { model: 'typesafe/jev-1.13-20260917', answers: { yes: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12, output_tokens: 1, cost: 0.0003 } } })
  const pendingRoad = tool.jevEvalCall(input)
  await select('on')
  const switchedAnswer = await pendingRoad
  const snapshotFor = ledger.jevLedgerSnapshot as (now: number, road: 'official' | 'openrouter') => ReturnType<typeof ledger.jevLedgerSnapshot>
  check('switching roads while an answer is in flight settles only the attempted road', switchedAnswer.status === 'ok' && ledger.jevLedgerSnapshot().spendUsd === 0 && snapshotFor(Date.now(), 'openrouter').spendUsd === 0.0003)
  await select('/jevor on')
  ledger.resetJevLedger()
  secrets.writeStoredOpenrouterApiKey(null)
  const beforeMissing = official.received.length + router.received.length
  check('a TypeSafe key never substitutes for a missing OpenRouter credential', !tool.jevEvalEnabled() && (await tool.jevEvalCall(input)).status === 'no-key' && status.jevStatus().words.includes('/logins') && official.received.length + router.received.length === beforeMissing)
  secrets.writeStoredOpenrouterApiKey(OR_KEY)
  key.storeJevApiKey(null)
  await select('on')
  check('an OpenRouter key never substitutes for the official key', !tool.jevEvalEnabled() && (await tool.jevEvalCall(input)).status === 'no-key' && official.received.length + router.received.length === beforeMissing)
  const large = { ...input, questions: [{ ...input.questions[0]!, ask: 'x'.repeat(72000) }, { ...input.questions[0]!, id: 'two', ask: 'x'.repeat(72000) }] }
  const assemble = assembly.assembleJevEvalRequest as (input: typeof large, road?: 'official' | 'openrouter') => ReturnType<typeof assembly.assembleJevEvalRequest>
  check('the same 36k batched request fits official and is refused before OpenRouter', assemble(large, 'official').ok && !assemble(large, 'openrouter').ok)
  const beforeBad = JSON.stringify(setting.readJevSettings())
  const bad = await command.call('on other', {} as never)
  const badRouter = await routerCommand.call('unknown', {} as never)
  check('unknown command grammar prints each command\'s two forms and changes nothing', JSON.stringify(bad).includes('/jev on') && JSON.stringify(bad).includes('/jev off') && JSON.stringify(badRouter).includes('/jevor on') && JSON.stringify(badRouter).includes('/jevor off') && beforeBad === JSON.stringify(setting.readJevSettings()))
  await select('/jevor off')
  check('/jevor off stores its road but neither lights nor sends', road() === 'openrouter' && !setting.jevEnabled() && !tool.jevEvalEnabled())
  await select('off')
  check('/jev off stops both the roster and all traffic', !setting.jevEnabled() && !tool.jevEvalEnabled() && (await tool.jevEvalCall(input)).status === 'off')
} finally {
  popup.closeSettingsPopup()
  await Promise.all([official.close(), router.close()])
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-jev-roads: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
