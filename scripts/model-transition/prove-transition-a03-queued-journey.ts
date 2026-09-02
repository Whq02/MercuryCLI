#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-a03-queued-journey.ts — A03
//  substrate: the scripted-stream fixture seam + the queued-journey
//  choreography scaffolding (the boundary LAW itself is pure-pinned by
//  prove-transition-a07-idempotent-settlement §B; the rendered journey rides the
//  transition-queued-* scenarios).
//
//    §A the seam — MERCURY_SCRIPTED_STREAM is registered; scriptedCallModel
//       returns a bounded generator for the known script, null for unknown
//       names; the deps factory falls back to the provider router whenever
//       the seam yields nothing (never a dead lane)
//    §B the scripted stream honors abort (a capture teardown never hangs)
//    §C the choreography — both transition-queued scenarios exist with the
//       mid-turn picker sends and the env requirement documented
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a03-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-a03-home-'))
delete process.env.MERCURY_SCRIPTED_STREAM

const ROOT = join(import.meta.dir, '..', '..')

const { scriptedCallModel } = await import('../../src/query/scriptedStream.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the seam — registered flag, known script, honest fallback')
{
  const row = getFlagSpec('MERCURY_SCRIPTED_STREAM')
  check('MERCURY_SCRIPTED_STREAM is registry-native', row !== undefined)
  check('the registered consumer is the deps seam', row?.consumer === 'src/query/deps.ts')
  check('the known script yields a generator', typeof scriptedCallModel('slow-text') === 'function')
  check('an unknown script yields null (fallback, never a dead lane)', scriptedCallModel('no-such-script') === null)
  const unset = productionDeps()
  check('flag unset ⇒ the provider router (production behavior)', typeof unset.callModel === 'function')
  process.env.MERCURY_SCRIPTED_STREAM = 'no-such-script'
  const unknown = productionDeps()
  check(
    'unknown script name ⇒ still the provider router',
    unknown.callModel === unset.callModel,
  )
  process.env.MERCURY_SCRIPTED_STREAM = 'slow-text'
  const armed = productionDeps()
  check('the armed seam swaps callModel', armed.callModel !== unset.callModel)
  delete process.env.MERCURY_SCRIPTED_STREAM
}

section('§B the scripted stream honors abort')
{
  const scripted = scriptedCallModel('slow-text')!
  const controller = new AbortController()
  const gen = scripted({
    messages: [],
    systemPrompt: [],
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: controller.signal,
    options: {},
  } as never)
  const started = Date.now()
  const first = await gen.next()
  check('the stream opens with a ping event', !first.done && (first.value as { type?: string }).type === 'stream_event')
  const second = gen.next()
  controller.abort()
  await second
  check('abort closes the active window immediately (no 8s hang)', Date.now() - started < 2_000, `${Date.now() - started}ms`)
}

section('§C the choreography scaffolding')
{
  const scenarios = readFileSync(join(ROOT, 'scripts/ui/renderScenarios.ts'), 'utf8')
  check(
    'both transition-queued scenarios exist',
    scenarios.includes("'transition-queued-journey'") && scenarios.includes("'transition-queued-settled'"),
  )
  check('the env requirement is documented at the scenario', scenarios.includes('MERCURY_SCRIPTED_STREAM='))
  check('the mid-turn picker send rides the choreography (CSI-u alt+p)', scenarios.includes('\\u001b[112;3u'))
}

console.log(failures === 0 ? '\n ✅ SCRIPTED-STREAM SEAM READY (journey choreography scaffolded)' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
