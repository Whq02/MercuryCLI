#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('openrouter-low-balance')
process.env.HOME = home
process.env.OPENROUTER_API_KEY = 'fixture-openrouter'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1/api/v1'
delete process.env.ANTHROPIC_API_KEY
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const owner = await import('../../src/services/providers/providerUsage.js')
const usageForProvider = owner.usageForProvider
const state = await import('../../src/services/providers/openrouter/openrouterUsageState.js')
const now = Date.now()
const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
async function decoded(limit: unknown, remaining: unknown): Promise<import('../../src/services/providers/openrouter/openrouterUsageState.js').OpenrouterKeyUsage | null> {
  state.__resetOpenrouterUsageStateForTest()
  return await state.refreshOpenrouterKeyUsage({ force: true, now: () => now, fetchImpl: (async () => new Response(JSON.stringify({ data: { limit, limit_remaining: remaining, usage: 1 } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
}
const view = (usage: import('../../src/services/providers/openrouter/openrouterUsageState.js').OpenrouterKeyUsage | null, lastError?: string) => usageForProvider('openrouter', { openrouterKeyPresent: () => true, openrouterLimited: () => ({ state: 'clear' }), openrouterObserved: () => ({ usage, ...(lastError ? { lastError } : {}) }), spend: () => spend })
const low = view(await decoded(20, 8.42))
const note = 'remaining under the key cap is $8.42 — below Mercury’s $10 floor; check the key cap and credits at openrouter.ai/settings/credits'
check('decoded /key balance under ten carries the notice', low.readerNote === note, low.readerNote)
check('rail and usage share the same notice', low.readerNoteCompact === note, low.readerNoteCompact)
check('the existing cap meter and credit figures are retained', low.windows.length === 1 && low.figures?.some(f => f.key === 'cap-remaining' && f.value === '8.42') === true)
for (const remaining of [10, 10.01, 25, null, undefined, '8.42']) {
  const usage = view(await decoded(20, remaining))
  check(`no low-balance notice for ${String(remaining)}`, usage.readerNote === undefined && usage.readerNoteCompact === undefined, usage.readerNote)
}
for (const remaining of [null, 0, 8.42]) {
  const usage = view(await decoded(null, remaining))
  check(`uncapped key with ${String(remaining)} never gets a floor notice`, usage.readerNote === undefined && usage.readerNoteCompact === undefined)
}
for (const remaining of [0, -0.01, 9.99, 9.999]) {
  const usage = view(await decoded(20, remaining))
  check(`finite remaining ${remaining} below ten gets a notice`, usage.readerNote?.includes('below Mercury’s $10 floor') === true, usage.readerNote)
  check('a just-under-ten value never prints ten dollars as below ten', !usage.readerNote?.includes('is $10.00'))
}
check('nothing observed does not fabricate a balance', view(null).readerNote === undefined)
check('a failed read keeps its own failure words', view(null, 'fixture refusal').readerNote?.includes('credit truth unavailable') === true)
const { usageCompactLines, usageSectionPlan } = await import('../../src/components/Settings/Usage.js')
const families = [{ id: 'openrouter' as const, available: true, credentialed: true, credentialLabel: 'fixture key' }]
const plan = usageSectionPlan(families)
check('compact usage includes both notice parts beside its credit facts', note.split('; ').every(part => usageCompactLines(plan, { usage: () => low, identity: () => 'fixture key', anthropicWindows: () => [], anthropicPools: () => [], openaiWindows: () => [], jev: () => '' }).some(line => line.text.includes(part))))
let current = low
mock.module('../../src/services/providers/providerUsage.js', () => ({ ...owner, providerFamilyPresences: () => families, usageForProvider: () => current, refreshProviderUsage: async () => {}, providerSessionSpend: () => spend }))
const catalogue = await import('../../src/services/providers/catalogueOnDemand.js')
mock.module('../../src/services/providers/catalogueOnDemand.js', () => ({ ...catalogue, readCatalogueIfPending: async () => undefined }))
const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { Usage } = await import('../../src/components/Settings/Usage.js')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
for (const [cols, rows] of [[178, 51], [80, 21]] as const) {
  for (const under of [true, false]) {
    current = under ? low : view(await decoded(20, 10))
    const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { width: cols, height: rows, flexDirection: 'column' }, React.createElement(Usage, { width: cols - 4, rowBudget: rows - 4, compact: cols < 100 }))))
    const m = await mountOffscreen(element, cols, rows)
    await waitFor(() => m.screen().includes('OpenRouter usage'), 5000)
    const screen = m.screen()
    check(`${cols}x${rows}: /usage ${under ? 'paints the notice with the cap figures' : 'does not warn at ten'}`, screen.includes('OpenRouter usage') && (under ? screen.includes('$8.42') && screen.includes('Mercury’s $10 floor') && screen.includes('openrouter.ai/settings/credits') : !screen.includes('floor')), screen)
    if (frames) writeFileSync(join(frames, `usage-openrouter-${cols}x${rows}-${under ? 'low' : 'floor'}.txt`), m.lines().join('\n') + '\n')
    m.unmount()
  }
}
await releaseScratchHome(home)
console.log(`prove-openrouter-low-balance: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
