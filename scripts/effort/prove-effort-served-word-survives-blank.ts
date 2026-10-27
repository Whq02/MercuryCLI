#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' EFFORT — a served word survives a blank live list; a non-empty list replaces it')
console.log('============================================================')

for (const key of ['OPENAI_API_KEY', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_HOME', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-effort-served-word-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

const authFile = join(process.env.MERCURY_CONFIG_DIR, '.openai-auth.json')
function landSignIn(tail: string, accountId: string): void {
  const now = Date.now()
  writeFileSync(
    authFile,
    JSON.stringify({
      version: 1,
      tokens: { idToken: `fixture-id-${tail}`, accessToken: `fixture-access-${tail}`, refreshToken: `fixture-refresh-${tail}`, accountId, planType: 'pro', accessTokenExpiresAtMs: now + 86_400_000 },
      lastRefreshMs: now,
      preferredSource: 'chatgpt-subscription',
    }) + '\n',
    { mode: 0o600 },
  )
}

const row = (slug: string, levels: string[], def?: string) => ({ slug, display_name: slug, supported_reasoning_levels: levels, ...(def !== undefined ? { default_reasoning_level: def } : {}), visibility: 'list', priority: 1, context_window: 400_000 })
const FULL = [row('gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium'), row('gpt-5.6-luna', ['low', 'medium', 'high'], 'medium'), row('gpt-5.6-terra', [], 'medium')]
let listBody: unknown = { models: FULL }
let listStatus = 200
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: unknown) => {
  const u = String(url)
  if (u.includes('/models')) return new Response(listStatus === 200 ? JSON.stringify(listBody) : 'down', { status: listStatus, headers: { 'content-type': listStatus === 200 ? 'application/json' : 'text/plain' } })
  throw new Error(`unexpected fixture URL: ${u}`)
}) as unknown as typeof fetch

const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const capabilities = await import('../../src/utils/model/capabilities.ts')
const effort = await import('../../src/utils/effort.ts')
const { effortSentOf } = await import('../../src/services/engine-connector/seatProjections.ts')
const truthOf = (model: string, word: string | undefined) => {
  const truth = effort.resolveEffortTruth(model, word as never)
  return { catalogue: truth.catalogue, wire: truth.wire, adjustedFrom: truth.adjustedFrom, supportsEffort: truth.supportsEffort, sent: effortSentOf(truth) }
}

section('§1 a session resolves max on a served list')
{
  catalogue.__resetOpenaiCatalogueForTest()
  landSignIn('a1', 'acct-owner')
  await catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  const served = truthOf('gpt-6-astra', 'max')
  check("Astra served: gpt-live, wire max, the facts read 'max'", served.catalogue === 'gpt-live' && served.wire === 'max' && served.sent === 'max', JSON.stringify(served))
  check('the capability edge agrees (max offered)', capabilities.modelSupportsMaxEffort('gpt-6-astra'))
  const terra = truthOf('gpt-5.6-terra', 'max')
  check("a row stating an empty vocabulary omits the key (known-empty, the facts read null)", terra.catalogue === 'gpt-known-empty' && terra.wire === undefined && terra.supportsEffort === false && terra.sent === null, JSON.stringify(terra))
}

section('§2 the live list blanks under the session: the served word stands')
{
  landSignIn('b1', 'acct-other')
  check('the list is blank under the new credential', catalogue.getCachedOpenaiCatalogue('chatgpt-subscription') === null)
  const view = capabilities.gptEffortVocabularyView('gpt-6-astra')
  check('the vocabulary view keeps the served list (live, max among the words)', view.state === 'live' && view.vocabulary.includes('max') && view.defaultEffort === 'medium', JSON.stringify(view))
  const kept = truthOf('gpt-6-astra', 'max')
  check("the resolver still reads gpt-live / max and the facts read 'max' — never null, never a lower word", kept.catalogue === 'gpt-live' && kept.wire === 'max' && kept.adjustedFrom === undefined && kept.sent === 'max', JSON.stringify(kept))
  check('the capability edge still offers max', capabilities.modelSupportsMaxEffort('gpt-6-astra') && capabilities.getMaxSupportedEffortLevel('gpt-6-astra') === 'max')
  const never = truthOf('gpt-5.6-luna', 'max')
  check('a model this session never read follows the unavailable rule (no key, the facts read null)', never.catalogue === 'gpt-unavailable' && never.wire === undefined && never.sent === null, JSON.stringify(never))
  const terra = truthOf('gpt-5.6-terra', 'max')
  check('a row read only as stated-empty has no served word to keep (unavailable)', terra.catalogue === 'gpt-unavailable' && terra.wire === undefined, JSON.stringify(terra))
}

section('§3 a failed refresh under the new credential leaves the served word standing')
{
  listStatus = 500
  const failed = await catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  check('the refresh failed and labelled an empty list', failed !== null && failed.models.length === 0 && typeof failed.lastError === 'string', JSON.stringify(failed))
  const kept = truthOf('gpt-6-astra', 'max')
  check("Astra still resolves max and the facts read 'max'", kept.catalogue === 'gpt-live' && kept.wire === 'max' && kept.sent === 'max', JSON.stringify(kept))
  listStatus = 200
}

section('§4 a non-empty list replaces the served word: the live truth, never a blind max')
{
  listBody = { models: [row('gpt-6-astra', ['low', 'medium', 'high', 'xhigh'], 'medium')] }
  await catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  const stepped = truthOf('gpt-6-astra', 'max')
  check('the new list without max steps the request to xhigh with the asked word on the record', stepped.catalogue === 'gpt-live' && stepped.wire === 'xhigh' && stepped.adjustedFrom === 'max' && stepped.sent === 'xhigh', JSON.stringify(stepped))
  landSignIn('c1', 'acct-third')
  const blankAgain = truthOf('gpt-6-astra', 'max')
  check('blank again: the LAST served list stands (xhigh), not the older one', blankAgain.catalogue === 'gpt-live' && blankAgain.wire === 'xhigh' && blankAgain.adjustedFrom === 'max', JSON.stringify(blankAgain))
  listBody = { models: FULL }
  await catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  const back = truthOf('gpt-6-astra', 'max')
  check('a list serving max again: max rides from the row', back.wire === 'max' && back.sent === 'max')
}

section('§5 a fresh process has no served word (today\'s unavailable rule holds)')
{
  catalogue.__resetOpenaiCatalogueForTest()
  const fresh = truthOf('gpt-6-astra', 'max')
  check('after the reset Astra is unavailable: the wire omits the key and no vocabulary is invented', fresh.catalogue === 'gpt-unavailable' && fresh.wire === undefined && effort.resolveEffortTruth('gpt-6-astra', 'max').providerVocabulary === undefined, JSON.stringify(fresh))
}

globalThis.fetch = realFetch
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
