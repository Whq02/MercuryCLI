#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-a03-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-a03-home-'))
delete process.env.MERCURY_SCRIPTED_STREAM

const ROOT = join(import.meta.dir, '..', '..')

const { scriptedCallModel } = await import('../../src/engine/turn-entry/scriptedStream.ts')
const { productionDeps } = await import('../../src/engine/turn-entry/turnLoopDeps.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')

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
  check('MERCURY_SCRIPTED_STREAM is registry-native', row !== undefined, 'register MERCURY_SCRIPTED_STREAM in FLAG_REGISTRY')
  check('the registered consumer is the deps seam', row?.consumer === 'src/engine/turn-entry/turnLoopDeps.ts', `consumer is ${row?.consumer}; set consumer to src/engine/turn-entry/turnLoopDeps.ts on the MERCURY_SCRIPTED_STREAM row in FLAG_REGISTRY`)
  check('the known script yields a generator', typeof scriptedCallModel('slow-text') === 'function', 'scriptedCallModel in src/engine/turn-entry/scriptedStream.ts must return a generator function for the slow-text script')
  check('an unknown script yields null (fallback, never a dead lane)', scriptedCallModel('no-such-script') === null, 'scriptedCallModel in src/engine/turn-entry/scriptedStream.ts must return null for a script name it does not know')
  const unset = productionDeps()
  check('flag unset ⇒ the provider router (production behavior)', typeof unset.callModel === 'function', 'productionDeps in src/engine/turn-entry/turnLoopDeps.ts must return the provider callModel when MERCURY_SCRIPTED_STREAM is unset')
  process.env.MERCURY_SCRIPTED_STREAM = 'no-such-script'
  const unknown = productionDeps()
  check(
    'unknown script name ⇒ still the provider router',
    unknown.callModel === unset.callModel,
    'productionDeps in src/engine/turn-entry/turnLoopDeps.ts must keep the provider callModel when scriptedCallModel returns null for the named script',
  )
  process.env.MERCURY_SCRIPTED_STREAM = 'slow-text'
  const armed = productionDeps()
  check('the armed seam swaps callModel', armed.callModel !== unset.callModel, 'productionDeps in src/engine/turn-entry/turnLoopDeps.ts must swap in scriptedCallModel when MERCURY_SCRIPTED_STREAM names a known script')
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
  check('the stream opens with a ping event', !first.done && (first.value as { type?: string }).type === 'stream_event', 'the first value of the slow-text generator in src/engine/turn-entry/scriptedStream.ts must be a stream_event')
  const second = gen.next()
  controller.abort()
  await second
  check('abort closes the active window immediately (no 8s hang)', Date.now() - started < 2_000, `${Date.now() - started}ms; the slow-text generator in src/engine/turn-entry/scriptedStream.ts must return as soon as options.signal aborts`)
}

section('§C the choreography scaffolding')
{
  const scenarios = readFileSync(join(ROOT, 'scripts/ui/renderScenarios.ts'), 'utf8')
  check(
    'both transition-queued scenarios exist',
    scenarios.includes("'transition-queued-journey'") && scenarios.includes("'transition-queued-settled'"),
    'restore the transition-queued-journey and transition-queued-settled scenarios in scripts/ui/renderScenarios.ts',
  )
  check('the mid-turn picker send rides the choreography (CSI-u alt+p)', scenarios.includes('\\u001b[112;3u'), 'the transition-queued scenarios in scripts/ui/renderScenarios.ts must send the alt+p CSI-u sequence mid-turn')
  check('the scripted-stream requirement is a field of the scenario', scenarios.includes("requiresEnv: { MERCURY_SCRIPTED_STREAM: 'slow-text' }"), 'the transition-queued scenarios in scripts/ui/renderScenarios.ts must set requiresEnv MERCURY_SCRIPTED_STREAM to slow-text')
}

console.log(failures === 0 ? '\n ✅ SCRIPTED-STREAM SEAM READY (journey choreography scaffolded)' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
