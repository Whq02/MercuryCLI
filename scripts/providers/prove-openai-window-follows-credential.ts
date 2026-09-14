#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SCRATCH = mkdtempSync(join(tmpdir(), 'openai-window-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.OPENAI_API_KEY

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

const ROOT = join(import.meta.dir, '..', '..')
const state = await import('../../src/services/providers/openai/openaiLimitState.ts')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const usability = await import('../../src/services/providers/providerUsability.ts')
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

const NOW = 1_900_000_000_000
const clock = (at: number) => () => at
const note = (state as Record<string, unknown>).noteOpenaiSourceIdentity as
  | ((source: 'chatgpt-subscription' | 'api-key', identity: string) => boolean)
  | undefined

section('§A the observed window belongs to the credential that observed it')
{
  check('the latch exports the identity note', typeof note === 'function')
  if (typeof note === 'function') {
    state.__resetOpenaiLimitStateForTest()
    check('a note with nothing observed forgets nothing and answers false', note('chatgpt-subscription', 'id-a') === false && state.openaiLimitWindow('chatgpt-subscription', clock(NOW)).state === 'clear')
    state.recordOpenaiUsageLimit(NOW + 3_600_000, 'chatgpt-subscription', clock(NOW))
    state.recordOpenaiRateHeaders(new Headers({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300' }), clock(NOW))
    check('the wall stands under the credential that observed it', state.openaiLimitWindow('chatgpt-subscription', clock(NOW)).state === 'limited')
    check('the same credential noted again keeps the wall and its bands', note('chatgpt-subscription', 'id-a') === false && state.openaiLimitWindow('chatgpt-subscription', clock(NOW)).state === 'limited' && state.openaiObservedUsage().primary?.usedPct === 100)
    state.recordOpenaiUsageLimit(NOW + 3_600_000, 'api-key', clock(NOW))
    note('api-key', 'key-1')
    const moved = note('chatgpt-subscription', 'id-b')
    check('another credential on the source forgets the wall it did not observe', moved === true && state.openaiLimitWindow('chatgpt-subscription', clock(NOW)).state === 'clear')
    check("…and the departed sign-in's bands with it", state.openaiObservedUsage().primary === undefined)
    check("…while the key slot's own wall stands (its own pool, its own credential)", state.openaiLimitWindow('api-key', clock(NOW)).state === 'limited')
    check('a sign-out (no credential) forgets the wall too', note('api-key', 'none') === true && state.openaiLimitWindow('api-key', clock(NOW)).state === 'clear')
    check('the wall still lapses at the reset it names under the same credential', (() => {
      note('api-key', 'key-2')
      state.recordOpenaiUsageLimit(NOW + 60_000, 'api-key', clock(NOW))
      return state.openaiLimitWindow('api-key', clock(NOW)).state === 'limited' && state.openaiLimitWindow('api-key', clock(NOW + 61_000)).state === 'clear'
    })())
    state.__resetOpenaiLimitStateForTest()
  }
}

section('§B the refusal names the blocker that blocks — the window, never the catalogue state')
{
  const base: Reads = {
    anthropicApiKey: () => null,
    anthropicSubscriber: () => false,
    anthropicBearerToken: () => false,
    anthropicLimitStatus: () => 'allowed',
    gptSeat: () => ({ state: 'ready' }),
    zaiKeyPresent: () => false,
    moonshotAccount: () => undefined,
    deepseekKeyPresent: () => false,
    compatConfigured: () => false,
    huggingfaceAccount: () => undefined,
    localServerPresent: () => false,
    openrouterKeyPresent: () => false,
    geminiAccount: () => undefined,
  }
  const pendingSeat = { state: 'disabled' as const, why: 'catalogue-pending' as const, reason: 'live catalogue not fetched yet — retry shortly' }
  const errorSeat = { state: 'disabled' as const, why: 'catalogue-error' as const, reason: 'live catalogue unreachable (http-500)' }
  const limited = () => ({ state: 'limited' as const })
  for (const [name, seat] of [
    ['pending', pendingSeat],
    ['error', errorSeat],
  ] as const) {
    const map = usability.resolveProviderUsability({ ...base, gptSeat: () => seat, openaiLimitWindow: limited })
    const refusal = usability.delegationDispatchBlocker('openai', map)
    const bracket = refusal?.match(/\(([^)]*)\)/)?.[1] ?? ''
    check(`a walled lane with the catalogue ${name} is refused for the window`, refusal !== null && refusal.includes('cannot take delegated work') && bracket.includes('usage window is reached'), String(refusal))
    check(`…and the bracket never carries the catalogue ${name} words as if they were the block`, refusal !== null && !bracket.includes('live catalogue'), bracket)
    check(`…while the lane's own blockers still name the catalogue ${name} for the surfaces that show the seat`, map.openai.blockers.some(b => b.includes('live catalogue')) && map.openai.blockers.some(b => b.includes('usage window is reached')), JSON.stringify(map.openai.blockers))
  }
  const pendingOnly = usability.resolveProviderUsability({ ...base, gptSeat: () => pendingSeat })
  check('a pending catalogue alone never refuses delegated work (it is a wait, not a block)', usability.delegationDispatchBlocker('openai', pendingOnly) === null)
  const readyWalled = usability.resolveProviderUsability({ ...base, openaiLimitWindow: limited })
  const readyRefusal = usability.delegationDispatchBlocker('openai', readyWalled) ?? ''
  check('with the catalogue ready the bracket is the window alone', readyRefusal.match(/\(([^)]*)\)/)?.[1] === 'the openai usage window is reached — resets per /usage', readyRefusal)
  const anthropicCapped = usability.delegationDispatchBlocker('anthropic', usability.resolveProviderUsability({ ...base, anthropicSubscriber: () => true, anthropicLimitStatus: () => 'rejected' })) ?? ''
  check("the Anthropic refusal's bracket is its window words, as before", anthropicCapped.includes('usage window is reached') && anthropicCapped.includes('never silently rerouted'), anthropicCapped)
}

section('§C the catalogue memo follows the credential')
{
  const forget = (catalogue as Record<string, unknown>).forgetDepartedOpenaiCatalogues as ((env?: NodeJS.ProcessEnv) => number) | undefined
  check('the catalogue exports the departed-memo drop', typeof forget === 'function')
  if (typeof forget === 'function') {
    catalogue.__resetOpenaiCatalogueForTest()
    const row = { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', visibility: 'list', priority: 1, supportedInApi: true }
    const oldEnv = { ...process.env, OPENAI_API_KEY: 'sk-old-key' }
    const newEnv = { ...process.env, OPENAI_API_KEY: 'sk-new-key' }
    check('a snapshot primes under the old key', catalogue.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [row as never], fetchedAtMs: NOW }, oldEnv) === true && catalogue.getCachedOpenaiCatalogue('api-key', oldEnv) !== null)
    check('the new key reads no snapshot of its own (the memo is keyed on the credential)', catalogue.getCachedOpenaiCatalogue('api-key', newEnv) === null)
    check("the drop under the new key removes the departed key's snapshot", forget(newEnv) === 1 && catalogue.getCachedOpenaiCatalogue('api-key', oldEnv) === null)
    check('a snapshot under the current key is kept by the drop', catalogue.primeOpenaiCatalogue({ sourceKind: 'api-key', models: [row as never], fetchedAtMs: NOW }, newEnv) === true && forget(newEnv) === 0 && catalogue.getCachedOpenaiCatalogue('api-key', newEnv) !== null)
    catalogue.__resetOpenaiCatalogueForTest()
  }
}

section('§D the roads: the runner reads the account again on the word, and the gate reads the catalogue before it decides')
{
  const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const print = src('src/cli/print.ts')
  const runnerCase = print.indexOf("case 'credential_change'")
  const runnerArm = runnerCase === -1 ? '' : print.slice(runnerCase, runnerCase + 900)
  check("the runner's credential_change arm reads the OpenAI account again beside the Anthropic reset", runnerArm.includes('resetLimitsForCredentialSwitch()') && runnerArm.includes('readOpenaiAccountAgain()'), runnerArm.slice(0, 300))
  const cat = src('src/services/providers/openai/openaiCatalogue.ts')
  const again = cat.indexOf('export function readOpenaiAccountAgain')
  const againBody = again === -1 ? '' : cat.slice(again, again + 1200)
  check('reading the account again notes both sources, drops departed memos and reads the pending catalogue bounded', againBody.includes('noteOpenaiSourceIdentity(') && againBody.includes('forgetDepartedOpenaiCatalogues(') && againBody.includes('readOpenaiCatalogueIfPending('), againBody.slice(0, 300))
  const runAgent = src('src/tools/AgentTool/runAgent.ts')
  const read = runAgent.indexOf("readCatalogueIfPending('openai')")
  const gate = runAgent.indexOf('delegationDispatchBlocker(agentRouteVerdict.route)')
  check('runAgent reads the OpenAI catalogue (bounded) before the dispatch verdict, and only for the OpenAI route', read !== -1 && gate !== -1 && read < gate && runAgent.slice(read - 200, read).includes("route === 'openai'"), `read=${read} gate=${gate}`)
  const call = src('src/services/providers/openai/openaiCallModel.ts')
  const noteAt = call.indexOf('noteOpenaiSourceIdentity(auth.account.kind')
  const recordAt = call.indexOf('recordOpenaiUsageLimit(outcome.fault.resetsAtMs, auth.account.kind)')
  check('the wall writer notes the credential it observed under before recording', noteAt !== -1 && recordAt !== -1 && noteAt < recordAt, `note=${noteAt} record=${recordAt}`)
  const live = src('src/services/providers/providerUsability.ts')
  check('the live window read notes the active credential before answering', live.includes('noteOpenaiSourceIdentity(active.kind, openaiSourceIdentity(active.kind))'))
  check('the verdict reads the limit blocker, never the joined blockers, for a walled lane', live.includes('lane.limitBlocker'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
