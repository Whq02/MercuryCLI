#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_MODEL']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-headroom-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const policy = await import('../../src/services/compact/autoCompact.ts')
const { contextFillView } = await import('../../src/utils/contextFill.ts')
const { contextLeftOutput } = await import('../../src/tools/ContextLeftTool/ContextLeftTool.ts')
const forecast = await import('../../src/utils/cockpit/ctxForecast.ts')
const { foldAvailability, overflowRefusalText } = await import('../../src/services/compact/overflowRecovery.ts')
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
const threshold = policy.getAutoCompactThreshold(model)
check('Sonnet 5.5 folds at 957,000, exactly 20,000 below its edge', edge === 977_000 && threshold === 957_000)
check('one token below the fold waits; the fold point fires', !(await policy.shouldAutoCompact([{ ...messages[0], message: { ...messages[0].message, usage: { input_tokens: threshold - 1, output_tokens: 0 } } }] as never, model)) && await policy.shouldAutoCompact([{ ...messages[0], message: { ...messages[0].message, usage: { input_tokens: threshold, output_tokens: 0 } } }] as never, model))
const view = contextFillView(messages as never, model)
const tool = contextLeftOutput(view)
check('the gauge and ContextLeft use the same fold point and measured count', view.compactAtPct === 95.7 && tool.leftUntilCompactTokens === 16_000 && tool.usedTokens === 941_000, tool.text)
check('warning, fold and blocking are three distinct tiers', policy.calculateTokenWarningState(937_000, model).level === 'warn' && policy.calculateTokenWarningState(threshold, model).level === 'compact' && policy.calculateTokenWarningState(edge, model).level === 'blocked')
forecast.resetCtxForecastForTest()
for (const pct of [87, 89, 91]) { forecast.recordCtxSample(pct); forecast.noteCtxTurnBoundary() }
check('the forecast counts down to the very same threshold', forecast.estimateTurnsToCompact(91, view.compactAtPct) === 3)
process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '100'
check('the percent override can still select the edge, never beyond it', policy.getAutoCompactThreshold(model) === edge)
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE
saveGlobalConfig(c => ({ ...c, autoCompactWindow: 100_000 }))
check('a 100k settings window still receives the full 20k headroom', policy.getAutoCompactThreshold(model) === 57_000)
saveGlobalConfig(c => ({ ...c, autoCompactWindow: undefined }))
process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '8'
check('a tiny usable edge keeps a positive proportional floor', policy.getAutoCompactThreshold(model) === 2)
delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
const signal = { source: 'estimate', family: 'anthropic', shape: 'blocking-limit', actualTokens: 990_000, limitTokens: edge } as const
for (const road of ['config', 'auto-env', 'master-env'] as const) {
  if (road === 'config') saveGlobalConfig(c => ({ ...c, autoCompactEnabled: false }))
  else process.env[road === 'auto-env' ? 'MERCURY_AUTO_COMPACT' : 'MERCURY_COMPACT'] = '0'
  const reason = road === 'config' ? 'turned off in /config' : road === 'auto-env' ? 'MERCURY_AUTO_COMPACT=0' : 'MERCURY_COMPACT=0'
  const availability = foldAvailability({ tracking: undefined, hasHistory: true })
  check(`${road}: the reason is named and early folding is off`, !policy.isAutoCompactEnabled() && policy.autoCompactDisabledReason() === reason && policy.compactionSettingsText().includes(reason), policy.compactionSettingsText())
  check(`${road}: only the master switch disables emergency recovery`, availability.available === (road !== 'master-env'))
  const sentence = overflowRefusalText(signal, road === 'master-env' ? 'compaction-off' : 'fold-failed', { nonInteractive: true, detail: 'fixture summary refused' })
  check(`${road}: the refusal names the road`, sentence.includes(reason), sentence)
  check(`${road}: there is no misleading early fold line`, contextFillView(messages as never, model).compactAtPct === null)
  if (road === 'config') saveGlobalConfig(c => ({ ...c, autoCompactEnabled: true }))
  else delete process.env[road === 'auto-env' ? 'MERCURY_AUTO_COMPACT' : 'MERCURY_COMPACT']
}
check('failure breaker still stops emergency recovery', !foldAvailability({ tracking: { compacted: false, turnCounter: 0, turnId: 't', consecutiveFailures: 3 }, hasHistory: true }).available)
const rail = readFileSync(join(import.meta.dir, '../../src/components/HelmTelemetryRail.tsx'), 'utf8')
check('the rail warning tier reads the same token policy, not a second percent ramp', rail.includes('calculateTokenWarningState(ctx.usedTokens, sessionModel).level') && rail.includes('color={ctxColor}') && !rail.includes('gaugeColor(ctxPct)') && !rail.includes('gaugeColor(95)'))
const doctor = readFileSync(join(import.meta.dir, '../../src/utils/healthReport.ts'), 'utf8')
check('the doctor context row uses the same switch explanation even without a sample', /label: 'Context & resume',[\s\S]{0,700}compactionSettingsText\(\)/.test(doctor))
console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
