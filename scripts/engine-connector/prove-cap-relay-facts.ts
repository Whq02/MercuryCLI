#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'cap-relay-facts-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MOCK_LIMITS = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DISABLE_1M_CONTEXT
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL']) {
  delete process.env[k]
}
const nowSeed = Date.now()
writeFileSync(
  join(home, '.openai-auth.json'),
  JSON.stringify({
    version: 1,
    tokens: {
      idToken: 'fixture-id-astra',
      accessToken: 'fixture-access-astra',
      refreshToken: 'fixture-refresh-astra',
      accountId: 'acct-fixture-astra',
      planType: 'plus',
      email: 'ana@example.com',
      accessTokenExpiresAtMs: nowSeed + 86_400_000,
    },
    lastRefreshMs: nowSeed,
    preferredSource: 'chatgpt-subscription',
  }),
  { mode: 0o600 },
)

const ROOT = join(import.meta.dir, '..', '..')
const limits = await import('../../src/services/claudeAiLimits.ts')
const mock = await import('../../src/services/mockRateLimits.ts')
const failover = await import('../../src/services/capFailover.ts')
const seatWire = await import('../../src/services/engine-connector/seatWire.ts')
const projections = await import('../../src/services/engine-connector/seatProjections.ts')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const epochs = await import('../../src/services/providers/catalogueEpoch.ts')
const capabilities = await import('../../src/utils/model/capabilities.ts')
const contextFill = await import('../../src/utils/contextFill.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const j = (v: unknown): string => JSON.stringify(v)

const OWNER_A = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000aa'
const OWNER_B = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000bb'
const ingest = (): void => limits.extractQuotaStatusFromHeaders(new Headers())

section("§1 the runner answers its latch as a fact: only while observed, only for the slot that observed it")
{
  limits.resetLimitsForCredentialSwitch()
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => 'ana@example.com')
  check('nothing observed: no fact', limits.anthropicWindowFact() === undefined)
  mock.setMockRateLimitScenario('weekly-limit-reached')
  ingest()
  const fact = limits.anthropicWindowFact()
  const statedReset = (limits.currentLimits.resetsAt ?? 0) * 1000
  check('a rejected verdict answers as the status, the moment, the owner, the stated reset and the claim', fact !== undefined && fact.status === 'rejected' && fact.owner === OWNER_A && typeof fact.observedAtMs === 'number' && fact.observedAtMs > 0 && fact.resetsAtMs === statedReset && fact.claim === 'seven_day', j(fact))
  check('the fact carries those five keys and nothing else', fact !== undefined && Object.keys(fact).sort().join(',') === 'claim,observedAtMs,owner,resetsAtMs,status', j(fact))
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_B, () => 'bea@example.com')
  check('a departed slot answers no fact', limits.anthropicWindowFact() === undefined)
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => 'ana@example.com')
  check('the slot back: the fact stands again', limits.anthropicWindowFact()?.status === 'rejected')
  mock.setMockRateLimitScenario('normal')
  ingest()
  const cleared = limits.anthropicWindowFact()
  check('the next allowed reply answers allowed', cleared !== undefined && cleared.status === 'allowed', j(cleared))
  limits.resetLimitsForCredentialSwitch()
  check('a credential switch answers no fact', limits.anthropicWindowFact() === undefined)
}

const T0 = Date.now() - 10_000
const RESET = Date.now() + 5 * 86_400_000
const relayed = { status: 'rejected', observedAtMs: T0, owner: OWNER_A, resetsAtMs: RESET, claim: 'seven_day' }

section("§2 the screen folds a relayed verdict into its own latch: the active slot's freshest observation wins")
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('clear')
  let emits = 0
  const listener = (): void => {
    emits++
  }
  limits.statusListeners.add(listener)
  check('unobserved going in', limits.claudeWindowObserved() === false)
  check('a malformed fact is refused', !limits.adoptAnthropicWindowFact(undefined) && !limits.adoptAnthropicWindowFact(null) && !limits.adoptAnthropicWindowFact([]) && !limits.adoptAnthropicWindowFact({ status: 'rejected' }) && !limits.adoptAnthropicWindowFact({ status: 'walled', observedAtMs: T0, owner: OWNER_A }) && !limits.adoptAnthropicWindowFact({ status: 'rejected', observedAtMs: 'now', owner: OWNER_A }))
  check('a verdict stamped for another slot never enters', !limits.adoptAnthropicWindowFact({ ...relayed, owner: OWNER_B }) && limits.claudeWindowObserved() === false)
  check('a verdict for no slot never enters', !limits.adoptAnthropicWindowFact({ ...relayed, owner: 'none' }) && !limits.adoptAnthropicWindowFact({ ...relayed, owner: '' }))
  check('a refusal emits nothing', emits === 0)
  check("the active slot's verdict is adopted", limits.adoptAnthropicWindowFact(relayed) === true)
  check('the latch now reads observed', limits.claudeWindowObserved() === true)
  check('the record holds the relayed status, reset and claim, with overage and fallback off', limits.currentLimits.status === 'rejected' && limits.currentLimits.resetsAt === RESET / 1000 && limits.currentLimits.rateLimitType === 'seven_day' && limits.currentLimits.isUsingOverage === false && limits.currentLimits.unifiedRateLimitFallbackAvailable === false, j(limits.currentLimits))
  check('one status change emitted', emits === 1, String(emits))
  const verdict = limits.anthropicLimitVerdict()
  check("the verdict carries the runner's moment, the account and the stated reset", verdict.status === 'rejected' && verdict.observedAtMs === T0 && verdict.account === 'ana@example.com' && verdict.resetsAtMs === RESET, j(verdict))
  const homeWindow = failover.observedFamilyWindow('anthropic')
  check("the card's resolver reads it as an observed rejected weekly limit", homeWindow.state === 'rejected' && homeWindow.basis === 'observed' && homeWindow.windowName === 'weekly limit' && homeWindow.resetsAtMs === RESET, j(homeWindow))
  check('the same fact read again is a no-op', limits.adoptAnthropicWindowFact({ ...relayed }) === false && emits === 1)
  check('an older observation never overwrites a fresher one', limits.adoptAnthropicWindowFact({ status: 'allowed', observedAtMs: T0 - 1, owner: OWNER_A }) === false && limits.currentLimits.status === 'rejected')
  check('a fresher allowed observation clears the wall', limits.adoptAnthropicWindowFact({ status: 'allowed', observedAtMs: T0 + 1, owner: OWNER_A }) === true && limits.currentLimits.status === 'allowed' && limits.currentLimits.rateLimitType === undefined && emits === 2, j(limits.currentLimits))
  check("the fact this process would answer is the adopted one", limits.anthropicWindowFact()?.observedAtMs === T0 + 1)
  mock.setMockRateLimitScenario('weekly-limit-reached')
  ingest()
  const ownAt = limits.anthropicLimitVerdict().observedAtMs ?? 0
  check("the screen's own reply stands as the fresher observation", limits.currentLimits.status === 'rejected' && ownAt > T0 + 1, String(ownAt))
  check('a relayed fact older than it is refused', limits.adoptAnthropicWindowFact({ status: 'allowed', observedAtMs: ownAt - 1, owner: OWNER_A }) === false && limits.currentLimits.status === 'rejected')
  mock.setMockRateLimitScenario('clear')
  limits.resetLimitsForCredentialSwitch()
  check('a credential switch drops the adopted verdict', limits.claudeWindowObserved() === false && limits.anthropicWindowFact() === undefined)
  limits.statusListeners.delete(listener)
}

const ZERO_USAGE = {
  totalCostUSD: 0,
  totalAPIDurationMs: 0,
  totalDurationMs: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  hasUnknownModelCost: false,
}
const baseAnswer = {
  model: { effective: 'claude-fable-5-1', setting: null },
  usage: ZERO_USAGE,
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: true, accountEmail: 'ana@example.com' },
  skills: [],
  mcp: [],
  permissionMode: 'default',
  workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] },
  queue: [],
}
const list = {
  sourceKind: 'chatgpt-subscription',
  models: [
    {
      id: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      reasoningEffortsStated: true,
      visibility: 'list',
      priority: 1,
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    },
  ],
  fetchedAtMs: T0,
}
const withFacts = { ...baseAnswer, usage: { ...ZERO_USAGE, anthropicWindow: relayed }, openaiCatalogue: list }

section('§3 the wire: both rows cross in snake_case and decode back; absent stays absent; the publish seam carries them')
{
  const wire = seatWire.sessionFactsToWire(withFacts as never) as { usage: Record<string, unknown>; openai_catalogue?: Record<string, unknown>; openaiCatalogue?: unknown }
  const window = wire.usage.anthropic_window as Record<string, unknown> | undefined
  check('the verdict rides under usage.anthropic_window with snake keys', window !== undefined && window.observed_at_ms === T0 && window.resets_at_ms === RESET && !('observedAtMs' in window) && !('resetsAtMs' in window) && window.status === 'rejected' && window.owner === OWNER_A && window.claim === 'seven_day' && !('anthropicWindow' in wire.usage), j(wire.usage))
  check('the list rides under openai_catalogue with snake keys and the rows untouched', wire.openai_catalogue !== undefined && wire.openai_catalogue.source_kind === 'chatgpt-subscription' && wire.openai_catalogue.fetched_at_ms === T0 && j(wire.openai_catalogue.models) === j(list.models) && !('openaiCatalogue' in wire), j(wire.openai_catalogue))
  const back = seatWire.sessionFactsFromWire(JSON.parse(JSON.stringify(wire)))
  check('the seat decodes both back deep-equal', j(back?.usage.anthropicWindow) === j(relayed) && j(back?.openaiCatalogue) === j(list), j(back?.usage.anthropicWindow))
  const bare = seatWire.sessionFactsToWire(baseAnswer as never) as { usage: Record<string, unknown> }
  check('an answer without the rows mints no key', !('anthropic_window' in bare.usage) && !('openai_catalogue' in bare) && !('openaiCatalogue' in bare))
  const bareBack = seatWire.sessionFactsFromWire(JSON.parse(JSON.stringify(bare)))
  check("an older runner's answer reads back without them", bareBack !== null && !('anthropicWindow' in bareBack.usage) && !('openaiCatalogue' in bareBack))
  const daemonDir = join(scratch, 'daemon')
  const { permissionMode: _mode, ...answerRest } = withFacts
  void _mode
  const publish = (sessionId: string, answer: Record<string, unknown>): void => {
    projections.publishSessionFacts({ schema: 1, sessionId, atMs: Date.now(), ...answer, pendingModel: null, busy: false } as never, daemonDir)
  }
  const readBack = async (sessionId: string): Promise<ReturnType<typeof projections.readSessionFacts>> => {
    for (let i = 0; i < 40; i++) {
      const facts = projections.readSessionFacts(sessionId, daemonDir)
      if (facts !== null) return facts
      await sleep(50)
    }
    return null
  }
  publish('relay-with', answerRest)
  const read = await readBack('relay-with')
  check('a published facts file carries both rows', read !== null && read.usage.anthropicWindow?.observedAtMs === T0 && read.usage.anthropicWindow.owner === OWNER_A && read.openaiCatalogue?.fetchedAtMs === T0 && read.openaiCatalogue.models[0]?.id === 'gpt-6-astra', j(read?.usage))
  const { permissionMode: _m2, ...bareRest } = baseAnswer
  void _m2
  publish('relay-without', bareRest)
  const readBare = await readBack('relay-without')
  check('a facts file without them reads back without them', readBare !== null && readBare.usage.anthropicWindow === undefined && readBare.openaiCatalogue === undefined)
}

section("§4 the roads on the code: the runner answers both rows, the seat publishes the answer whole, the connector folds both")
{
  const printSrc = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  const armAt = printSrc.indexOf("case 'session_facts'")
  check('the session_facts arm is found', armAt >= 0)
  const factsArm = printSrc.slice(Math.max(0, armAt))
  const answerEnd = factsArm.indexOf('respondSuccess(requestId, sessionFactsToWire(answer))')
  check('the answer is sent through the wire codec', answerEnd >= 0)
  const answerBlock = factsArm.slice(0, Math.max(0, answerEnd))
  check('the runner reads its latch fact and its catalogue fact once per answer', answerBlock.includes('const anthropicWindow = anthropicWindowFact()') && answerBlock.includes('const openaiCatalogue = openaiCatalogueFact()'))
  check('…and spreads them onto the usage row and the answer, absent when undefined', answerBlock.includes('...(anthropicWindow !== undefined ? { anthropicWindow } : {})') && answerBlock.includes('...(openaiCatalogue !== undefined ? { openaiCatalogue } : {})'))
  const seatSrc = readFileSync(join(ROOT, 'src/daemon/sessionSeat.ts'), 'utf8')
  check("the seat publishes the runner's answer whole, so both rows ride its spread", seatSrc.includes('const { box: boxAnswer, ...answerRest } = answer') && seatSrc.includes('...answerRest,'))
  const connectorSrc = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const readAt = connectorSrc.indexOf('private readFacts(): void {')
  const asksAt = connectorSrc.indexOf('private readAsks(): void {')
  check('the facts read is found', readAt >= 0 && asksAt >= 0)
  const readFactsBody = connectorSrc.slice(Math.max(0, readAt), Math.max(0, asksAt))
  check('the connector folds the verdict on every facts read, beside the OpenAI bands', readFactsBody.includes('adoptOpenaiObservedUsage(next.usage?.openaiObserved)') && readFactsBody.includes('adoptAnthropicWindowFact(next.usage?.anthropicWindow)'))
  check('…and primes its catalogue when the list moved', readFactsBody.includes('adoptOpenaiCatalogueFact(next.openaiCatalogue)') && readFactsBody.includes('next.openaiCatalogue.fetchedAtMs !== prev?.openaiCatalogue?.fetchedAtMs'))
  const limitsSrc = readFileSync(join(ROOT, 'src/services/claudeAiLimits.ts'), 'utf8')
  check('the fold keys on the stamp the latch keys on: the active slot and the observation moment', limitsSrc.includes('if (f.owner !== resolveOwner()) return false') && limitsSrc.includes('if (verdictObservedAtMs !== null && f.observedAtMs <= verdictObservedAtMs) return false'))
  const catalogueSrc = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCatalogue.ts'), 'utf8')
  check('the list primes through the one claim hand-off door', catalogueSrc.includes('return primeOpenaiCatalogue({ sourceKind: f.sourceKind, models, fetchedAtMs: f.fetchedAtMs }, env)'))
}

section("§5 the screen primes its catalogue from the fact: the pinned window becomes the list's and the mark goes")
{
  const before = capabilities.resolveContextWindow('gpt-6-astra')
  check('before the list: the pin, marked as awaiting the live list', before.source === 'static-pin' && before.pinAwaitingLive === true, j(before))
  check('…and the label carries the mark', contextFill.contextWindowLabel(before.effectiveWindow, before.source, before.pinAwaitingLive === true).endsWith(' pin'))
  const epoch0 = epochs.catalogueEpoch()
  check('a malformed list is refused and moves nothing', !catalogue.adoptOpenaiCatalogueFact(undefined) && !catalogue.adoptOpenaiCatalogueFact({ sourceKind: 'other', models: list.models, fetchedAtMs: T0 }) && !catalogue.adoptOpenaiCatalogueFact({ sourceKind: 'chatgpt-subscription', models: [{ nope: 1 }], fetchedAtMs: T0 }) && !catalogue.adoptOpenaiCatalogueFact({ sourceKind: 'chatgpt-subscription', models: [], fetchedAtMs: T0 }) && !catalogue.adoptOpenaiCatalogueFact({ sourceKind: 'chatgpt-subscription', models: list.models, fetchedAtMs: 0 }) && epochs.catalogueEpoch() === epoch0)
  check("the runner's list primes the screen's catalogue and bumps the epoch", catalogue.adoptOpenaiCatalogueFact(list) === true && epochs.catalogueEpoch() === epoch0 + 1)
  const after = capabilities.resolveContextWindow('gpt-6-astra')
  check("after: the window is the list's ceiling, live, unmarked", after.source === 'live-current' && after.effectiveWindow === 872_000 && after.pinAwaitingLive === undefined && catalogue.liveGptContextWindow('gpt-6-astra') === 272_000, j(after))
  check('the label drops the mark', contextFill.contextWindowLabel(after.effectiveWindow, after.source, false) === '872k')
  check('an older list never replaces a fresher one', catalogue.adoptOpenaiCatalogueFact({ ...list, fetchedAtMs: T0 - 1, models: [{ ...list.models[0], contextWindow: 1 }] }) === false && catalogue.liveGptContextWindow('gpt-6-astra') === 272_000)
  check('the same list again is a no-op', catalogue.adoptOpenaiCatalogueFact(list) === false && epochs.catalogueEpoch() === epoch0 + 1)
  check('the fact this process would answer is the primed list', catalogue.openaiCatalogueFact()?.fetchedAtMs === T0 && catalogue.openaiCatalogueFact()?.models.length === 1)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-cap-relay-facts: ALL LAWS HOLD' : `prove-cap-relay-facts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
