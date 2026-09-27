#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-ingest-pace-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' local ingest pace — the promise is measured, not guessed')
console.log('============================================================')

let pace: typeof import('../../src/services/providers/localLiveness.js') | null = null
try {
  pace = await import('../../src/services/providers/localLiveness.js')
} catch (error) {
  pace = null
  check('the local road has a pace store of its own', false, error instanceof Error ? error.message : String(error))
}

if (pace !== null) {
  section('P1 · before any turn: a conservative default by size class from the record\'s parameter count')
  {
    check('≤10B reads at 300 tokens/s', pace.localPaceDefaultFor('9.4B') === 300 && pace.localPaceDefaultFor('0.6B') === 300 && pace.localPaceDefaultFor('10B') === 300, `${pace.localPaceDefaultFor('9.4B')} ${pace.localPaceDefaultFor('10B')}`)
    check('≤35B reads at 100 tokens/s', pace.localPaceDefaultFor('27B') === 100 && pace.localPaceDefaultFor('35B') === 100 && pace.localPaceDefaultFor('14.8B') === 100, `${pace.localPaceDefaultFor('27B')}`)
    check('above 35B reads at 40 tokens/s', pace.localPaceDefaultFor('70B') === 40 && pace.localPaceDefaultFor('235B') === 40 && pace.localPaceDefaultFor('1T') === 40, `${pace.localPaceDefaultFor('70B')}`)
    check('an unstated or unparseable size reads at 100 tokens/s', pace.localPaceDefaultFor(undefined) === 100 && pace.localPaceDefaultFor('large') === 100 && pace.localPaceDefaultFor('') === 100)
    check('the size parser reads billions (a decimal, a million-suffix, a trillion-suffix)', pace.parameterBillionsOf('27B') === 27 && pace.parameterBillionsOf('9.4B') === 9.4 && pace.parameterBillionsOf('500M') === 0.5 && pace.parameterBillionsOf('1T') === 1000 && pace.parameterBillionsOf(undefined) === null)
    check('the promise: 65k tokens on the 27B default reads 812.5 s; the floor is one minute; a nonsense pace takes the unstated default', pace.localFirstBytePromiseMs(65_000, 100) === 812_500 && pace.localFirstBytePromiseMs(100, 300) === 60_000 && pace.localFirstBytePromiseMs(65_000, 0) === 812_500 && pace.LOCAL_PROMISE_MARGIN === 1.25 && pace.LOCAL_PROMISE_FLOOR_MS === 60_000)
    check('nothing is remembered before a turn', pace.rememberedLocalPace('qwen3.5:9b-q4_K_M') === null)
  }

  section('P2 · one cold turn reporting prompt_tokens 60013, cached 8192 over 114 s ⇒ ≈455 tokens/s; the next cold promise for 52k uncached tokens reads ≈143 s')
  {
    const recorded = pace.recordLocalIngestPace({ wireModel: 'qwen3.5:9b-q4_K_M', promptTokens: 60_013, cachedTokens: 8_192, ingestMs: 114_000, nowMs: 1_000 })
    check('the pace was recorded from the uncached tokens ÷ the time to the first byte', recorded !== null && Math.abs(recorded.paceTokensPerSec - 454.6) < 0.5 && recorded.samples === 1, JSON.stringify(recorded))
    const remembered = pace.rememberedLocalPace('qwen3.5:9b-q4_K_M')
    check('…and is remembered per wire model id', remembered !== null && Math.abs(remembered.paceTokensPerSec - 454.6) < 0.5 && remembered.lastPromptTokens === 60_013, JSON.stringify(remembered))
    const promise = pace.localFirstBytePromiseMs(52_000, remembered?.paceTokensPerSec ?? 0)
    check('the next cold promise for 52k uncached tokens reads ≈143 s (52,000 ÷ 454.6 × 1.25)', Math.abs(promise - 143_000) <= 500, String(promise))
    check('the store lives in a file of its own under the config home, never the discovery record', existsSync(pace.localPaceStorePath()) && pace.localPaceStorePath().startsWith(process.env.MERCURY_CONFIG_DIR!) && pace.localPaceStorePath().endsWith('local-ingest-pace.json'), pace.localPaceStorePath())
    const onDisk = JSON.parse(readFileSync(pace.localPaceStorePath(), 'utf8')) as { version: number; models: Record<string, { paceTokensPerSec: number }> }
    check('the file carries the pace by wire model id', onDisk.version === 1 && Math.abs(onDisk.models['qwen3.5:9b-q4_K_M']!.paceTokensPerSec - 454.6) < 0.5, JSON.stringify(onDisk))
    pace.__resetLocalPaceForTest()
    check('a fresh process reads it back from the file', Math.abs((pace.rememberedLocalPace('qwen3.5:9b-q4_K_M')?.paceTokensPerSec ?? 0) - 454.6) < 0.5)
  }

  section('P3 · the guards and the blend')
  {
    check('a turn under 1,000 uncached tokens records nothing', pace.recordLocalIngestPace({ wireModel: 'tiny', promptTokens: 1_500, cachedTokens: 900, ingestMs: 30_000 }) === null && pace.rememberedLocalPace('tiny') === null)
    check('a first byte under five seconds records nothing (a cache hit is not an ingest)', pace.recordLocalIngestPace({ wireModel: 'warm', promptTokens: 60_000, ingestMs: 1_200 }) === null && pace.rememberedLocalPace('warm') === null)
    pace.recordLocalIngestPace({ wireModel: 'qwen3.5:27b', promptTokens: 62_908, cachedTokens: 0, ingestMs: 314_540, nowMs: 2_000 })
    const second = pace.recordLocalIngestPace({ wireModel: 'qwen3.5:27b', promptTokens: 62_908, cachedTokens: 0, ingestMs: 251_632, nowMs: 3_000 })
    check('a second turn blends with the first (200 and 250 tokens/s ⇒ 225), the samples counted', second !== null && Math.abs(second.paceTokensPerSec - 225) < 0.5 && second.samples === 2, JSON.stringify(second))
    pace.noteLocalPromptSize('qwen3.5:27b', 70_000, 4_000)
    check('a warm turn notes the prompt size without touching the pace', Math.abs((pace.rememberedLocalPace('qwen3.5:27b')?.paceTokensPerSec ?? 0) - 225) < 0.5 && pace.rememberedLocalPace('qwen3.5:27b')?.lastPromptTokens === 70_000)
    check('the uncached estimate: a cold turn is the whole prompt; a warm turn is the growth since the last prompt on that model, never under 1,000', pace.localUncachedEstimate({ cold: true, promptTokens: 65_000, remembered: pace.rememberedLocalPace('qwen3.5:27b') }) === 65_000 && pace.localUncachedEstimate({ cold: false, promptTokens: 73_500, remembered: pace.rememberedLocalPace('qwen3.5:27b') }) === 3_500 && pace.localUncachedEstimate({ cold: false, promptTokens: 70_100, remembered: pace.rememberedLocalPace('qwen3.5:27b') }) === 1_000 && pace.localUncachedEstimate({ cold: false, promptTokens: 70_100, remembered: null }) === 70_100)
  }

  section('P4 · the law for a turn, from the record and the store')
  {
    const record = { id: 'qwen3.5:27b', server: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', parameterSize: '27B', loaded: false }
    const law = pace.localStreamLawFor({ wireModel: 'qwen3.5:27b', cold: true, promptTokens: 65_000, record })
    check('the cold promise reads from the remembered pace (65k ÷ 225 × 1.25 ≈ 361 s)', law !== undefined && Math.abs(law.promiseMs - 361_111) <= 100 && law.paceTokensPerSec === 225 && law.uncachedTokens === 65_000 && law.cold, JSON.stringify({ promiseMs: law?.promiseMs, pace: law?.paceTokensPerSec }))
    check('the law carries the record\'s loaded state, the server\'s words and the two-hour cap', law?.loadedAtSend === false && law.serverWords === 'Ollama at 127.0.0.1:11434' && law.capMs === 7_200_000, JSON.stringify({ loaded: law?.loadedAtSend, server: law?.serverWords, cap: law?.capMs }))
    const fresh = pace.localStreamLawFor({ wireModel: 'gemma4:70b', cold: true, promptTokens: 40_000, record: { id: 'gemma4:70b', server: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', parameterSize: '70B' } })
    check('a model with no pace yet takes its size class (40k ÷ 40 × 1.25 = 1,250 s)', fresh?.promiseMs === 1_250_000 && fresh.loadedAtSend === undefined, String(fresh?.promiseMs))
    const warm = pace.localStreamLawFor({ wireModel: 'qwen3.5:27b', cold: false, promptTokens: 74_500, record })
    check('a warm turn promises from the growth since the last prompt (4,500 ÷ 225 × 1.25 = 25 s, floored at one minute)', warm?.promiseMs === 60_000 && warm.uncachedTokens === 4_500, JSON.stringify({ promiseMs: warm?.promiseMs, uncached: warm?.uncachedTokens }))
    check('no record ⇒ no law (the generic road)', pace.localStreamLawFor({ wireModel: 'nowhere', cold: true, promptTokens: 10 }) === undefined)
    law!.noteTurn({ promptTokens: 62_908, cachedTokens: 0, ingestMs: 300_000 })
    check('the turn\'s measured ingest feeds the store through the law (blend of 225 over two samples with 209.7)', Math.abs((pace.rememberedLocalPace('qwen3.5:27b')?.paceTokensPerSec ?? 0) - 219.9) < 0.5 && pace.rememberedLocalPace('qwen3.5:27b')?.samples === 3, JSON.stringify(pace.rememberedLocalPace('qwen3.5:27b')))
  }

  section('P5 · the probe doors per server kind, and what a loaded answer means')
  {
    check('the cheap liveness door per kind', pace.localLivenessProbeUrl('ollama', 'http://127.0.0.1:11434/v1') === 'http://127.0.0.1:11434/api/version' && pace.localLivenessProbeUrl('lmstudio', 'http://127.0.0.1:1234/v1') === 'http://127.0.0.1:1234/api/v1/models' && pace.localLivenessProbeUrl('llamacpp', 'http://127.0.0.1:8080/v1') === 'http://127.0.0.1:8080/health' && pace.localLivenessProbeUrl('vllm', 'http://127.0.0.1:8000/v1') === 'http://127.0.0.1:8000/v1/models')
    check('the loaded door per kind (vLLM has none: the served model is always loaded)', pace.localLoadedProbeUrl('ollama', 'http://127.0.0.1:11434/v1') === 'http://127.0.0.1:11434/api/ps' && pace.localLoadedProbeUrl('vllm', 'http://127.0.0.1:8000/v1') === null)
    check('Ollama: /api/ps lists the model ⇒ loaded; not listed ⇒ not loaded; a foreign shape ⇒ unknown', pace.localLoadedFromAnswer('ollama', 'qwen3.5:27b', 200, { models: [{ name: 'qwen3.5:27b', model: 'qwen3.5:27b' }] }) === true && pace.localLoadedFromAnswer('ollama', 'qwen3.5:27b', 200, { models: [] }) === false && pace.localLoadedFromAnswer('ollama', 'qwen3.5:27b', 200, {}) === null)
    check('LM Studio: a loaded instance ⇒ loaded', pace.localLoadedFromAnswer('lmstudio', 'qwen3.5-27b', 200, { models: [{ key: 'qwen3.5-27b', loaded_instances: [{}] }] }) === true && pace.localLoadedFromAnswer('lmstudio', 'qwen3.5-27b', 200, { models: [{ key: 'qwen3.5-27b', loaded_instances: [] }] }) === false)
    check('llama.cpp: /health 200 ⇒ loaded, 503 ⇒ loading', pace.localLoadedFromAnswer('llamacpp', 'x', 200, { status: 'ok' }) === true && pace.localLoadedFromAnswer('llamacpp', 'x', 503, {}) === false)
    check('the loading words read the size off /api/tags in GB', pace.localSizeGbFromTags({ models: [{ name: 'qwen3.5:27b', size: 17_200_000_000 }] }, 'qwen3.5:27b') === 17.2 && pace.localSizeGbFromTags({ models: [] }, 'qwen3.5:27b') === undefined)
    const words = await import('../../src/services/providers/streamIdleBudget.js')
    check('the loading line', words.requestWaitLine({ kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'qwen3.5:27b', budgetMs: 812_500, sinceMs: 0, attempt: 1, promise: true, phase: 'loading', sizeGb: 17.2 } as never) === 'loading qwen3.5:27b (17.2 GB)')
    const wire = words.requestWaitToWire({ kind: 'silence', model: 'qwen3.5:27b', silentMs: 900_000, sinceMs: 5, answered: true })
    check('the silence wait rides the wire snake_case and decodes back', wire.silent_ms === 900_000 && wire.since_ms === 5 && JSON.stringify(words.decodeRequestWait(words.requestWaitFromWire(wire))) === JSON.stringify({ kind: 'silence', model: 'qwen3.5:27b', silentMs: 900_000, sinceMs: 5, answered: true }), JSON.stringify(wire))
    const promised = words.requestWaitToWire({ kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'qwen3.5:27b', budgetMs: 812_500, sinceMs: 0, attempt: 1, promise: true, checkedMs: 406_000 })
    check('a promised first-byte wait keeps its promise and its check across the wire', promised.checked_ms === 406_000 && (words.decodeRequestWait(words.requestWaitFromWire(promised)) as { promise?: boolean; checkedMs?: number }).promise === true && (words.decodeRequestWait(words.requestWaitFromWire(promised)) as { checkedMs?: number }).checkedMs === 406_000)
    const { statusLine } = await import('../../src/components/SwitchboardTagBar.tsx')
    const live = { inFlight: true, phase: 'replying' } as never
    const seat = (wait: unknown, quietMs: number) => ({ title: 't', projectLabel: 'p', interrupting: false, hardStopping: false, wait, quietMs, watchdogMs: 900_000, phaseMs: null, toolBudgetMs: null, stuck: false }) as never
    check('the status row never says the budget is up on a promise', !statusLine(live, seat({ kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'qwen3.5:27b', budgetMs: 406_000, sinceMs: 0, attempt: 1, promise: true }, 420_000)).includes('the budget is up') && statusLine(live, seat({ kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'Opus 5', budgetMs: 198_000, sinceMs: 0, attempt: 1 }, 420_000)).includes('the budget is up'))
    check('the status row paints the silence line as the owner spells it', statusLine(live, seat({ kind: 'silence', model: 'qwen3.5:27b', silentMs: 900_000, sinceMs: 0, answered: true }, 905_000)) === "no bytes for 15m — qwen3.5:27b's server still answers")
    check('an extended promise carries its own clock: no "so far" suffix rides beside it (a published extension re-stamps the seat)', statusLine(live, seat({ kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'qwen3.5:27b', budgetMs: 609_000, sinceMs: 0, attempt: 1, promise: true, checkedMs: 406_000 }, 30_000)) === 'still ingesting a 65k-token prompt on qwen3.5:27b — about 3m 23s more (its server answered at 6m 46s)' && statusLine(live, seat({ kind: 'first-byte', cold: true, promptTokens: 65_000, model: 'qwen3.5:27b', budgetMs: 406_000, sinceMs: 0, attempt: 1, promise: true }, 30_000)) === 'ingesting a 65k-token prompt on qwen3.5:27b — first byte expected in about 6m 46s · 30s so far')
  }
}

console.log(failures === 0 ? '\nprove-local-ingest-pace: all green' : `\nprove-local-ingest-pace: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
