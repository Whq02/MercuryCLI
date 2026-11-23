#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'transition-r02-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


section('§A the ONE provider station — the /logins card mounted in the walk')
{
  const { loginFamilyRows, SIGN_IN_LATER_ROW } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.ts')
  const { parseFamilyFocus } = await import('../../src/commands/logins/login.tsx')

  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  const { updateSettingsForSource } = await import('../../src/platform/settings/settings.ts')
  enableConfigs()
  const configured = updateSettingsForSource('userSettings', () => ({ compatProvider: { entryfixture: { baseUrl: 'http://127.0.0.1:1/v1', models: ['Fixture'] } } }))
  if (configured.error) throw configured.error
  const families = loginFamilyRows({ engineLegs: true })
  const providerRows = families.filter(row => !row.value.startsWith('compat/'))
  const { configuredCompatEndpoints } = await import('../../src/models/roads/openaicompat/compatAccounts.ts')
  const endpointRows = configuredCompatEndpoints().filter(endpoint => endpoint.named).map(endpoint => `compat/${endpoint.name}`)
  check('the owner carries exactly twenty-two provider sign-in rows (one Anthropic row, its two roads behind the arm pick)', providerRows.length === 22 && families.filter(row => row.value === 'anthropic').length === 1 && ['xai', 'meta', 'mistral', 'nous', 'zen', 'minimax', 'together', 'cohere', 'groq', 'melious', 'orcarouter', 'cerebras', 'fireworks', 'qwen'].every(id => families.some(row => row.value === id)), `providers=${providerRows.length} — change loginFamilyRows in src/models/sign-in/flow-cards/loginFamilyRows.ts so the owner list holds twenty-two provider rows with one anthropic row`)
  check('the named endpoints each add exactly their own sign-in row, including the fixture endpoint', endpointRows.includes('compat/entryfixture') && JSON.stringify(families.filter(row => row.value.startsWith('compat/')).map(row => row.value)) === JSON.stringify(endpointRows), JSON.stringify(endpointRows) + ' — change loginFamilyRows in src/models/sign-in/flow-cards/loginFamilyRows.ts so each named compat endpoint from configuredCompatEndpoints adds exactly one compat/<name> row')
  check(
    'every owner family is nameable — /logins <family> resolves each row value',
    families.every(row => parseFamilyFocus(row.value) === row.value),
    JSON.stringify(families.map(row => [row.value, parseFamilyFocus(row.value)])) +
      ' — change parseFamilyFocus in src/commands/logins/login.tsx so it resolves every row value from loginFamilyRows',
  )
  const { signInLaterRow } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.ts')
  check(
    'with no local server the later row carries its honest caveat: the agent needs a sign-in or a local model, and names /localsetup',
    /sign in later/i.test(SIGN_IN_LATER_ROW.label) &&
      /The agent needs a sign-in or a local model \(\/localsetup\)/.test(SIGN_IN_LATER_ROW.label) &&
      signInLaterRow({ models: 0, labels: [] }).label === SIGN_IN_LATER_ROW.label,
    SIGN_IN_LATER_ROW.label + ' — change SIGN_IN_LATER_ROW and signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts so the no-local-server label carries the caveat and /localsetup',
  )
  check(
    'with a local server answering the later row names the local road and drops the caveat',
    signInLaterRow({ models: 7, labels: ['Ollama 0.34.4'] }).label === 'Sign in later to look around, or run a local model — 7 found on Ollama 0.34.4' &&
      signInLaterRow({ models: 7, labels: ['Ollama 0.34.4'] }).value === SIGN_IN_LATER_ROW.value,
    signInLaterRow({ models: 7, labels: ['Ollama 0.34.4'] }).label + ' — change signInLaterRow in src/models/sign-in/flow-cards/loginFamilyRows.ts so a local server names the local road, drops the caveat and keeps the row value',
  )
}


section('§D the typed credentialless fallback — the computed default')
{
  const { evaluateComputedDefault } = await import('../../src/models/catalogue/computedDefault.ts')
  type Verdict = { usable: true; setting: string; row: string; why: string } | { usable: false; why: string }
  const usable = (setting: string): Verdict => ({ usable: true, setting, row: setting, why: 'usable' })
  const REG = ['anthropic', 'openai', 'zai', 'openrouter', 'gemini', 'moonshot', 'deepseek', 'openai-compat', 'huggingface', 'local']
  const T = 1_788_298_400_000
  const decide = (credentials: Array<{ family: string; at: number | null }>, rows: Record<string, Verdict>) =>
    evaluateComputedDefault({
      credentials,
      registryOrder: REG,
      laneRow: family => rows[family] ?? { usable: false, why: 'no selectable row' },
      keyless: { setting: 'claude-sonnet-4-5', why: 'no provider is signed in yet' },
    })
  check(
    'a first-party credential alone ⇒ the default stays home (its own newest usable row)',
    decide([{ family: 'anthropic', at: T }], { anthropic: usable('claude-sonnet-4-5') }).setting === 'claude-sonnet-4-5',
    'change evaluateComputedDefault in src/models/catalogue/computedDefault.ts so a first-party credential alone keeps its own usable row',
  )
  check(
    'credentialless at home + a live GPT lane ⇒ the qualified GPT row',
    decide([{ family: 'openai', at: T }], { openai: usable('gpt-5.6-sol') }).setting === 'gpt-5.6-sol',
    'change evaluateComputedDefault in src/models/catalogue/computedDefault.ts so a live GPT lane gives the qualified GPT row',
  )
  const nothing = decide([], {})
  check(
    'no credential anywhere ⇒ NO default: the keyless placeholder stays put, named (typed refusal downstream, never silent)',
    nothing.source === 'keyless' && nothing.setting === 'claude-sonnet-4-5' && nothing.provider === null && nothing.row === 'no sign-in yet',
    'change evaluateComputedDefault in src/models/catalogue/computedDefault.ts so no credential returns the keyless placeholder: ' + JSON.stringify(nothing),
  )
  const gatedGpt = decide([{ family: 'openai', at: T + 1 }, { family: 'anthropic', at: T }], { openai: { usable: false, why: 'GPT-5.6: not served by the connected source' }, anthropic: usable('claude-sonnet-4-5') })
  check(
    'a gated GPT row is never chosen — the default falls through to the earlier sign-in, named',
    gatedGpt.setting === 'claude-sonnet-4-5' && gatedGpt.source === 'fallthrough' && gatedGpt.why.includes('Skipped: openai'),
    'change evaluateComputedDefault in src/models/catalogue/computedDefault.ts so a gated row falls through to the earlier sign-in and names the skip: ' + JSON.stringify(gatedGpt),
  )
}

section('§E the no-Anthropic boot honesty notice — every family alike')
{
  const { nonAnthropicBootNotice } = await import(
    '../../src/models/roads/providerUsability.ts'
  )
  const u = (over: Record<string, unknown>) =>
    ({
      anthropic: { provider: 'anthropic', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] },
      openai: { provider: 'openai', credential: 'oauth', limit: 'unknown', usable: true, blockers: [] },
      zai: { provider: 'zai', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] },
      ...over,
    }) as never
  const notice = nonAnthropicBootNotice(u({}))
  check('openai-only ⇒ the notice fires, naming OpenAI as ready', typeof notice === 'string' && /OpenAI is ready/.test(notice ?? ''), 'change nonAnthropicBootNotice in src/models/roads/providerUsability.ts so openai-only fires the notice naming OpenAI: ' + String(notice))
  check(
    'the notice names the dormant Claude-ACCOUNT surfaces and never claims crewmates stay Claude-backed (they ride the session family)',
    Boolean(notice && /usage windows/.test(notice) && /tools and crewmates run on the session/.test(notice) && !/non-goal/.test(notice)),
    String(notice) + ' — change the notice text in nonAnthropicBootNotice in src/models/roads/providerUsability.ts',
  )
  check(
    'a Claude credential silences it',
    nonAnthropicBootNotice(
      u({ anthropic: { provider: 'anthropic', credential: 'oauth', limit: 'allowed', usable: true, blockers: [] } }),
    ) === null,
    'change nonAnthropicBootNotice in src/models/roads/providerUsability.ts so a usable anthropic credential returns null',
  )
  check(
    'no usable engine lane silences it (nothing to boot onto)',
    nonAnthropicBootNotice(
      u({ openai: { provider: 'openai', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] } }),
    ) === null,
    'change nonAnthropicBootNotice in src/models/roads/providerUsability.ts so no usable engine lane returns null',
  )
  const openrouterOnly = nonAnthropicBootNotice(
    u({
      openai: { provider: 'openai', credential: 'none', limit: 'unknown', usable: false, blockers: ['x'] },
      openrouter: { provider: 'openrouter', credential: 'api-key', limit: 'unknown', usable: true, blockers: [] },
    }),
  )
  check('an OpenRouter-only boot gets the SAME honesty (no family-specific silence)', typeof openrouterOnly === 'string' && /OpenRouter is ready/.test(openrouterOnly ?? ''), String(openrouterOnly) + ' — change nonAnthropicBootNotice in src/models/roads/providerUsability.ts so every family gets the same notice')
  const two = nonAnthropicBootNotice(
    u({ gemini: { provider: 'gemini', credential: 'oauth', limit: 'unknown', usable: true, blockers: [] } }),
  )
  check('several usable lanes are all named', typeof two === 'string' && /OpenAI, Gemini are ready/.test(two ?? ''), String(two) + ' — change nonAnthropicBootNotice in src/models/roads/providerUsability.ts so it names every usable lane')
}

console.log(
  failures === 0
    ? '\n ✅ — provider-neutral entry over the existing owners + boot honesty'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
