#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-dotted-ids-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const context = await import('../../src/utils/context.ts')
const model = await import('../../src/utils/model/model.ts')

const pairs: Array<[string, string]> = [
  ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
  ['claude-opus-4.6', 'claude-opus-4-6'],
  ['claude-haiku-4.5', 'claude-haiku-4-5'],
  ['claude-sonnet-4.5', 'claude-sonnet-4-5'],
  ['claude-haiku-4.5-20251001', 'claude-haiku-4-5-20251001'],
  ['claude-opus-4.6[1m]', 'claude-opus-4-6[1m]'],
]

section('§1 a model id spelled with a dot reads the same window and output limit as its dashed spelling (settings engine.model and MERCURY_MODEL reach the readers unfolded)')
for (const [dotted, dashed] of pairs) {
  const window = [context.getContextWindowForModel(dotted), context.getContextWindowForModel(dashed)]
  const output = [context.getModelMaxOutputTokens(dotted), context.getModelMaxOutputTokens(dashed)]
  check(`${dotted}: the context window is the dashed spelling's (${window[1]})`, window[0] === window[1], `${window[0]} vs ${window[1]}`)
  check(`${dotted}: the output limit is the dashed spelling's (${j(output[1])})`, j(output[0]) === j(output[1]), `${j(output[0])} vs ${j(output[1])}`)
  check(`${dotted}: the canonical name is the dashed spelling's (${model.getCanonicalName(dashed)})`, model.getCanonicalName(dotted) === model.getCanonicalName(dashed), model.getCanonicalName(dotted))
}

section('§2 the two faults the mining found, pinned by value: Sonnet 4.6 is not Sonnet 4, Haiku 4.5 is not the newest Haiku')
{
  check('claude-sonnet-4.6 carries the 128k output limit of Sonnet 4.6, not the 64k of Sonnet 4', context.getModelMaxOutputTokens('claude-sonnet-4.6').upperLimit === 128_000, j(context.getModelMaxOutputTokens('claude-sonnet-4.6')))
  check('claude-opus-4.6 carries the 128k output limit of Opus 4.6, not the 32k of Opus 4', context.getModelMaxOutputTokens('claude-opus-4.6').upperLimit === 128_000, j(context.getModelMaxOutputTokens('claude-opus-4.6')))
  check('claude-haiku-4.5 keeps the 200k window; it is not read as the newest Haiku', context.getContextWindowForModel('claude-haiku-4.5') === 200_000, String(context.getContextWindowForModel('claude-haiku-4.5')))
  check('the id itself is untouched: the string sent to the provider stays as the operator spelled it', model.normalizeModelStringForAPI('claude-sonnet-4.6') === 'claude-sonnet-4.6' && model.normalizeModelStringForAPI('claude-opus-4.6[1m]') === 'claude-opus-4.6', model.normalizeModelStringForAPI('claude-sonnet-4.6'))
}

section('§3 a dot that is not a generation separator changes nothing')
{
  check('a gateway-prefixed id keeps the carrier road', context.getModelMaxOutputTokens('my-gw/claude-opus-4.6').upperLimit === context.getModelMaxOutputTokens('my-gw/claude-opus-4-6').upperLimit)
  check('a dashed id reads as before', context.getModelMaxOutputTokens('claude-sonnet-4-6').upperLimit === 128_000 && context.getContextWindowForModel('claude-sonnet-4-6') === 200_000)
}

console.log(failures === 0 ? '\nprove-dotted-model-id-limits: all green' : `\nprove-dotted-model-id-limits: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
