#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_MODEL']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-headroom-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const policy = await import('../../src/engine/compaction/autoFold.ts')
const { contextFillView } = await import('../../src/engine/context-window/contextFill.ts')
const { contextLeftOutput } = await import('../../src/tools/context-left/ContextLeftTool.ts')
const forecast = await import('../../src/screen/cockpit-gauges/ctxForecast.ts')
const { foldAvailability, overflowRefusalText } = await import('../../src/engine/compaction/overflowRecovery.ts')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `: ${detail}` : ''}`)
}
const model = 'claude-sonnet-5-5'
const messages = [{ type: 'assistant', uuid: 'headroom-reply', message: { id: 'reply', role: 'assistant', model, content: [{ type: 'text', text: 'reply' }], stop_reason: 'end_turn', usage: { input_tokens: 940_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]
const edge = policy.getBlockingLimit(model)
const threshold = policy.getAutoFoldThreshold(model)
check('Sonnet 5.5 folds at 957,000, exactly 20,000 below its edge', edge === 977_000 && threshold === 957_000)
check('one token below the fold waits; the fold point fires', !(await policy.shouldAutoFold([{ ...messages[0], message: { ...messages[0].message, usage: { input_tokens: threshold - 1, output_tokens: 0 } } }] as never, model)) && await policy.shouldAutoFold([{ ...messages[0], message: { ...messages[0].message, usage: { input_tokens: threshold, output_tokens: 0 } } }] as never, model))
const view = contextFillView(messages as never, model)
const tool = contextLeftOutput(view)
check('the gauge and ContextLeft use the same fold point and measured count', view.compactAtPct === 95.7 && tool.leftUntilCompactTokens === 16_000 && tool.usedTokens === 941_000, tool.text)
check('warning, fold and blocking are three distinct tiers', policy.calculateTokenWarningState(937_000, model).level === 'warn' && policy.calculateTokenWarningState(threshold, model).level === 'compact' && policy.calculateTokenWarningState(edge, model).level === 'blocked')
forecast.resetCtxForecastForTest()
for (const pct of [87, 89, 91]) { forecast.recordCtxSample(pct); forecast.noteCtxTurnBoundary() }
check('the forecast counts down to the very same threshold', forecast.estimateTurnsToFold(91, view.compactAtPct) === 3)
process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '100'
check('the percent override can still select the edge, never beyond it', policy.getAutoFoldThreshold(model) === edge)
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE
saveGlobalConfig(c => ({ ...c, autoCompactWindow: 100_000 }))
check('a 100k settings window reserves 12,500 for the turn and folds at 64,500', policy.getTurnReserveTokens(model) === 12_500 && policy.getAutoFoldThreshold(model) === 64_500)
saveGlobalConfig(c => ({ ...c, autoCompactWindow: undefined }))
process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '8'
check('a tiny usable edge keeps a positive proportional floor', policy.getAutoFoldThreshold(model) === 2)
delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
const signal = { source: 'estimate', family: 'anthropic', shape: 'blocking-limit', actualTokens: 990_000, limitTokens: edge } as const
for (const road of ['config', 'auto-env', 'master-env'] as const) {
  if (road === 'config') saveGlobalConfig(c => ({ ...c, autoCompactEnabled: false }))
  else process.env[road === 'auto-env' ? 'MERCURY_AUTO_COMPACT' : 'MERCURY_COMPACT'] = '0'
  const reason = road === 'config' ? 'turned off in /config' : road === 'auto-env' ? 'MERCURY_AUTO_COMPACT=0' : 'MERCURY_COMPACT=0'
  const availability = foldAvailability({ tracking: undefined, hasHistory: true })
  check(`${road}: the reason is named and early folding is off`, !policy.isAutoFoldEnabled() && policy.autoFoldDisabledReason() === reason && policy.foldSettingsText().includes(reason), policy.foldSettingsText())
  check(`${road}: only the master switch disables emergency recovery`, availability.available === (road !== 'master-env'))
  const sentence = overflowRefusalText(signal, road === 'master-env' ? 'compaction-off' : 'fold-failed', { nonInteractive: true, detail: 'fixture summary refused' })
  check(`${road}: the refusal names the road`, sentence.includes(reason), sentence)
  check(`${road}: there is no misleading early fold line`, contextFillView(messages as never, model).compactAtPct === null)
  if (road === 'config') saveGlobalConfig(c => ({ ...c, autoCompactEnabled: true }))
  else delete process.env[road === 'auto-env' ? 'MERCURY_AUTO_COMPACT' : 'MERCURY_COMPACT']
}
check('failure breaker still stops emergency recovery', !foldAvailability({ tracking: { folded: false, turnCounter: 0, turnId: 't', consecutiveFailures: 3 }, hasHistory: true }).available)
const { memoryChecks } = await import('../../src/platform/health/sections/memory.ts')
const contextRow = memoryChecks().find(row => row.id === 'context')
const contextSays = await contextRow?.run()
check('/health context row uses the same switch explanation even without a sample', contextRow?.label === 'Context & resume' && contextSays?.evidence.startsWith('no context sample published yet this session') === true && contextSays.evidence.includes(policy.foldSettingsText()), contextSays?.evidence)
console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
