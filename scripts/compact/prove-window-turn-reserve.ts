#!/usr/bin/env bun
// gate-watch: src/services/compact/autoCompact.ts src/services/compact/verbatimTail.ts src/services/compact/compact.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from '../daemon/dupline-world.ts'

const home = mkdtempSync(join(tmpdir(), 'window-turn-reserve-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'ollama=http://127.0.0.1:11434'
for (const key of ['MERCURY_HOME', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_MAX_OUTPUT_TOKENS']) delete process.env[key]
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { writeLocalWindowSetting, __resetLocalWindowsForTest } = await import('../../src/services/providers/local/localWindow.ts')
const auto = await import('../../src/services/compact/autoCompact.ts')
const { foldLandingCeiling } = await import('../../src/services/compact/verbatimTail.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { estimateTurnsToCompact, recordCtxSample, noteCtxTurnBoundary, resetCtxForecastForTest } = await import('../../src/utils/cockpit/ctxForecast.ts')
const { ollamaChatBody } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const model = 'local/window-proof:9b'
const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname
  return Response.json(path === '/api/tags' ? { models: [{ name: 'window-proof:9b', size: 6_000_000_000 }] }
    : path === '/api/show' ? { model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'] }
    : path === '/api/version' ? { version: 'fixture' } : { models: [] })
}) as typeof fetch
await refreshLocalDiscovery({ force: true, fetchImpl })
const record = localRecordFor(model)!
const before = getModelMaxOutputTokens(model)
const tally = makeTally('prove-window-turn-reserve')
try {
  for (const window of [8192, 32768, 65536, 131072, 262144]) {
    writeLocalWindowSetting(record, window)
    __resetLocalWindowsForTest()
    const turn = Math.min(20_000, before.upperLimit, Math.floor(window / 8))
    const blocking = auto.getBlockingLimit(model)
    const threshold = auto.getAutoCompactThreshold(model)
    const expected = Math.max(1, blocking - turn, Math.ceil(blocking / 4))
    tally.check(`${window}: the advance reserve follows the window and output ceiling`, threshold === expected, JSON.stringify({ threshold, expected, turn }))
    const history = [createUserMessage({ content: 'read the next file' }), createAssistantMessage({ content: 'read it' })]
    const landing = foldLandingCeiling(expected, history, 1, [], turn)
    tally.check(`${window}: a small round does not demand a cloud-sized landing gap`, landing === expected - Math.min(turn, Math.floor(expected / 2)), JSON.stringify({ landing, expected, turn }))
    if (window === 32768) {
      resetCtxForecastForTest()
      for (const used of [9338, 11838, 14338]) { recordCtxSample(used / window * 100); noteCtxTurnBoundary() }
      tally.check('the 14k request is below the fold point and the vitals forecast has a turn left', threshold > 14338 && estimateTurnsToCompact(14338 / window * 100, threshold / window * 100)! > 0, String(threshold))
      tally.check('a 15.6k folded request can land below the threshold without an artificial no-room gap', foldLandingCeiling(21576, history, 1, [], turn) > 15600)
    }
  }
  const smallOutput = 'claude-3-haiku-20240307'
  const ceiling = getModelMaxOutputTokens(smallOutput).upperLimit
  tally.check('a real 4096-token output ceiling also bounds the advance reserve', ceiling === 4096 && auto.getAutoCompactThreshold(smallOutput) === auto.getBlockingLimit(smallOutput) - ceiling)
  tally.check('no model output ceiling is reduced', JSON.stringify(getModelMaxOutputTokens(model)) === JSON.stringify(before))
  const body = ollamaChatBody({ model: record.id, messages: [{ role: 'user', content: 'continue' }], extra: { max_tokens: before.default } }, { numCtx: 32768, think: true })
  tally.check('the wire still requests the full output default with thinking on', (body.options as { num_predict: number }).num_predict === before.default && body.think === true)
} finally {
  rmSync(home, { recursive: true, force: true })
}
tally.finish()
