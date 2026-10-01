#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.js'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(proofHome)
delete process.env.NODE_ENV
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS

const { PROVIDER_ID_SPACES, FIRST_PARTY_ID_MARK, classifyModelRoute } = await import('../../src/services/providers/idSpaces.js')
const { currentPatience, patienceWords } = await import('../../src/services/providers/patience.js')
const idle = await import('../../src/services/providers/streamIdleBudget.js')
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
const firstParty = classifyModelRoute(`${FIRST_PARTY_ID_MARK}fixture`, {})
if (firstParty.kind !== 'route') throw new Error('the declared first-party id space must route')
const routes = [...new Set([firstParty.route, ...PROVIDER_ID_SPACES.map(space => space.route)])]
const fed = new Set(['anthropic', 'zai', 'openai-compat', 'deepseek', 'openrouter'])
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${String(detail)}`}`)
}
function setPatience(value: unknown): void {
  const { error } = updateSettingsForSource('userSettings', { patience: value } as never)
  if (error !== null) throw error
  resetSettingsCache()
}

try {
  for (const mode of [
    { label: 'normal', setting: 'normal', fed: 360_000, quiet: 900_000 },
    { label: 'patient', setting: 'patient', fed: 720_000, quiet: 1_800_000 },
    { label: 'custom', setting: { streamIdleSeconds: 369, quietStreamIdleSeconds: 1234 }, fed: 369_000, quiet: 1_234_000 },
  ]) {
    setPatience(mode.setting)
    check(`${mode.label}: the settings pipeline selected the mode`, currentPatience().mode === mode.label)
    for (const route of routes) {
      const expected = fed.has(route) ? mode.fed : mode.quiet
      const actual = idle.streamIdleTimeoutMsForRoute(route)
      check(`${mode.label} ${route} idle`, actual === expected, `actual=${actual} expected=${expected}`)
      if (mode.label !== 'normal') check(`${mode.label} ${route} never takes the unknown-route default`, actual !== idle.STREAM_IDLE_DEFAULT_MS)
      const normal = fed.has(route) ? 360_000 : 900_000
      const fence = route === 'local' ? null : Math.max(30_000, Math.round(30_000 * expected / normal))
      check(`${mode.label} ${route} first body byte`, idle.silentAfterHeadersMsForRoute(route) === fence, `actual=${idle.silentAfterHeadersMsForRoute(route)} expected=${fence}`)
      check(`${mode.label} ${route} warm window`, idle.silentAfterHeadersWindowMs({ route, cold: false, promptTokens: 20_000, idleMs: expected }) === fence)
      check(`${mode.label} ${route} cold allowance`, idle.silentAfterHeadersWindowMs({ route, cold: true, promptTokens: 20_000, idleMs: expected }) === (fence === null ? null : fence + 24_000))
    }
    for (const route of [null, 'unknown-route', 'toString']) {
      check(`${mode.label} ${route} alone keeps the unknown default`, idle.streamIdleTimeoutMsForRoute(route) === 120_000 && idle.silentAfterHeadersMsForRoute(route) === null)
    }
    process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1001'
    process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '700'
    for (const route of routes) {
      check(`${mode.label} ${route} explicit idle pin`, idle.streamIdleTimeoutMsForRoute(route) === 1001)
      check(`${mode.label} ${route} explicit fence pin`, idle.silentAfterHeadersWindowMs({ route, cold: true, promptTokens: 200_000, idleMs: 1001 }) === (route === 'local' ? null : 700))
    }
    process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '500'
    process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '5'
    for (const route of routes) {
      const expected = fed.has(route) ? mode.fed : mode.quiet
      check(`${mode.label} ${route} invalid pins fall through`, idle.streamIdleTimeoutMsForRoute(route) === expected && idle.silentAfterHeadersMsForRoute(route) === (route === 'local' ? null : Math.max(30_000, Math.round(30_000 * expected / (fed.has(route) ? 360_000 : 900_000)))))
    }
    delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
    delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
  }
  setPatience({ streamIdleSeconds: 2, quietStreamIdleSeconds: 3 })
  for (const route of routes) {
    check(`${route}: a smaller custom idle budget remains the first deadline`, idle.silentAfterHeadersWindowMs({ route, cold: false, promptTokens: 0, idleMs: idle.streamIdleTimeoutMsForRoute(route) }) === null)
  }
  setPatience(undefined)
  setPatience({ streamIdleSeconds: 369 })
  check('a missing custom quiet number keeps its normal value', routes.filter(route => !fed.has(route)).every(route => idle.streamIdleTimeoutMsForRoute(route) === 900_000))
  setPatience('patient')
  const now = Date.now
  const later = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  let clock = 0
  let timer: { at: number; fn: () => void } | null = null
  Date.now = () => clock
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    timer = { at: clock + ms, fn }
    return 1
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (() => { timer = null }) as typeof clearTimeout
  const advance = (to: number): void => {
    while (timer !== null && timer.at <= to) {
      const due = timer
      timer = null
      clock = due.at
      due.fn()
    }
    clock = to
  }
  const timeoutMs = idle.streamIdleTimeoutMsForRoute('xai')
  const silentAfterHeadersMs = idle.silentAfterHeadersWindowMs({ route: 'xai', cold: false, promptTokens: 0, idleMs: timeoutMs })
  try {
    const watchdog = idle.createStreamIdleWatchdog({ timeoutMs, silentAfterHeadersMs })
    advance(30_001)
    check('patient: an initially silent response survives the old 30-second fence', watchdog.fired() === null)
    advance(60_000)
    check('patient: a byte-less response meets the doubled fence', watchdog.fired()?.noBytes === true && watchdog.fired()?.silentMs === 60_000)
    watchdog.stop()
    const active = idle.createStreamIdleWatchdog({ timeoutMs, silentAfterHeadersMs })
    active.noteActivity()
    advance(120_001)
    check('one body byte disables the first-byte fence without shortening the idle budget', active.fired() === null)
    active.stop()
  } finally {
    Date.now = now
    globalThis.setTimeout = later
    globalThis.clearTimeout = clear
  }
  const config = readFileSync(resolve(import.meta.dir, '../../src/components/Settings/Config.tsx'), 'utf8')
  const row = config.slice(config.indexOf("id: 'patience'"), config.indexOf('change: direction =>', config.indexOf("id: 'patience'")))
  check('the Patience row explicitly covers every provider without a provider-only exception', /every provider/.test(row) && !/OpenAI|only on|except|excluding/.test(row))
  check('the value calls the quiet budget quiet, not OpenAI-only', /quiet/.test(patienceWords(currentPatience().numbers)) && !/OpenAI/.test(patienceWords(currentPatience().numbers)))
  const idleWords = FLAG_REGISTRY.find(flag => flag.env === 'MERCURY_STREAM_IDLE_TIMEOUT_MS')?.off ?? ''
  const fenceWords = FLAG_REGISTRY.find(flag => flag.env === 'MERCURY_SILENT_AFTER_HEADERS_MS')?.off ?? ''
  check('the flag registry no longer promises a fixed budget on other providers', idleWords.includes('every provider') && !idleWords.includes('every other road'))
  check('the flag registry names normal and patient first-body-byte budgets', fenceWords.includes('normal is 30 s') && fenceWords.includes('patient is 60 s'))
} finally {
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(`prove-patience-every-route: ${routes.length} declared routes, ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
