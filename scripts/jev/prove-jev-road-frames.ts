#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('jev-road-frames')
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1'
for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_REDUCED_MOTION']) delete process.env[name]
mock.module('node:child_process', () => ({ ...childProcess, execFile: (...args: unknown[]) => {
  const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
  setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
  return { kill() {}, on() {}, unref() {} }
} }))
let reportedCredits: { limitRemaining: number; observedAtMs: number } | null = null
const routerUsage = await import('../../src/services/providers/openrouter/openrouterUsageState.js')
mock.module('../../src/services/providers/openrouter/openrouterUsageState.js', () => ({ ...routerUsage, openrouterObservedKeyUsage: () => ({ usage: reportedCredits }) }))
const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.ts')
const command = await import('../../src/commands/jev/jev.tsx')
const routerCommandPath = '../../src/commands/jevor/jevor.ts'
const routerCommand = await import(routerCommandPath).catch(() => ({ call: async () => ({ type: 'text', value: '/jevor is not registered' }) }))
const key = await import('../../src/services/jev/jevKey.ts')
const ledger = await import('../../src/services/jev/jevLedger.ts')
const status = await import('../../src/services/jev/jevStatus.ts')
const reader = await import('../../src/services/jev/jevSessionFacts.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const jevCard = (await import('../../src/components/Settings/Jev.js')) as Record<string, unknown> & typeof import('../../src/components/Settings/Jev.js')
const { BootSettingsScreen } = await import('../../src/components/BootSettingsScreen.js')
const providerUsage = await import('../../src/services/providers/providerUsage.js')
mock.module('../../src/services/providers/providerUsage.js', () => ({ ...providerUsage, refreshProviderUsage: async () => undefined }))
const { call: usageCall } = await import('../../src/commands/usage/usage.js')
const cap = await import('../../src/services/switchboard/capacityCheck.js')
cap._setHeldMachineSeatReadingForTesting(6, { cores: 8, availableBytes: 6 * cap.SEAT_COST_BYTES.runner, read: 'vm_stat', sampledAt: 0 })
const index = process.argv.indexOf('--frames')
const dir = index < 0 ? undefined : process.argv[index + 1]
if (dir) mkdirSync(dir, { recursive: true })
const frames: string[] = []
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}
const flat = (m: Mounted) => m.screen().replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')
const keep = (name: string, m: Mounted, cols: number, rows: number): void => {
  const lines = m.lines()
  check(`${name} fits without a render error or secret`, lines.length <= rows && lines.every(line => stringWidth(line) <= cols) && !m.screen().includes('RENDER ERROR') && !m.screen().includes('proof-jev-road-frame-key'))
  frames.push(`${name}.txt`)
  if (dir) writeFileSync(join(dir, `${name}.txt`), lines.join('\n') + '\n')
}
const wrap = (element: unknown, cols: number, rows: number) => React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: cols, height: rows }, element as never)))
const missingControls = (m: Mounted): string[] => {
  const lines = m.lines()
  return jevCard.JEV_ROWS.filter(id => !lines.some(line => line.includes(`  ${jevCard.JEV_ROW_LABELS[id]} `) || line.includes(`${jevCard.JEV_ROW_MARK} ${jevCard.JEV_ROW_LABELS[id]} `)))
}
const framed = (name: string, m: Mounted, cols: number, rows: number): string => `${name} at ${cols}x${rows}:\n${m.lines().join('\n')}`
const controls = (name: string, m: Mounted, cols: number, rows: number): void => {
  const missing = missingControls(m)
  check(`${name}: every control row is on the card`, missing.length === 0, `missing ${missing.join(', ')} — ${framed(name, m, cols, rows)}`)
}
const select = async (m: Mounted, needle: string): Promise<void> => {
  for (let i = 0; i < 70 && !m.screen().includes(needle); i++) { m.push(KEY.down); await settle(45) }
}
slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => 'proof-session', usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false, jev: reader.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus()) }) }))
try {
  {
    const plan = jevCard.jevCardPlan as ((demand: { rowBudget: number; controlRows: number; statusRows: number; noteRows: number; receiptRows: number | null; promptRows: number | null }) => { compact: boolean; status: boolean; note: boolean; receipt: boolean; prompt: boolean; input: boolean }) | undefined
    const at = (rowBudget: number, controlRows: number, extra: Partial<{ statusRows: number; noteRows: number; receiptRows: number | null; promptRows: number | null }> = {}) => plan!({ rowBudget, controlRows, statusRows: 1, noteRows: 1, receiptRows: null, promptRows: null, ...extra })
    check('the card plans whole rows: the eight controls and their spend lines first, then the note (or the receipt, or the entry row), then the status line — never a control', typeof plan === 'function' && (() => {
      const tight = at(12, 11)
      const full = at(12, 12)
      const roomy = at(13, 11)
      const receipt = at(12, 11, { receiptRows: 1 })
      const entry = at(12, 11, { promptRows: 1 })
      const wide = at(42, 12, { noteRows: 3, receiptRows: 2 })
      return tight.compact && tight.note && !tight.status && !full.note && !full.status && roomy.note && roomy.status && receipt.receipt && !receipt.note && !receipt.status && entry.input && !entry.prompt && !entry.status && !wide.compact && wide.status && wide.note && wide.receipt
    })(), `jevCardPlan is ${typeof plan}`)
  }
  for (const [cols, rows] of [[178, 51], [80, 21]] as const) {
    for (const road of ['official', 'openrouter'] as const) {
      for (const enabled of [false, true]) for (const present of [false, true]) {
        await (road === 'official' ? command : routerCommand).call('on', {} as never)
        popup.closeSettingsPopup()
        setting.setJevEnabled(enabled)
        key.storeJevApiKey(road === 'official' && present ? 'proof-jev-road-frame-key-official' : null)
        secrets.writeStoredOpenrouterApiKey(road === 'openrouter' && present ? 'proof-jev-road-frame-key-router' : null)
        const m = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
        popup.openSettingsPopup(command.jevPopupRequest())
        await waitFor(() => m.screen().includes('Mercury · jev'), 4000)
        await settle(60)
        keep(`jev-${road}-${enabled ? 'on' : 'off'}-${present ? 'key' : 'no-key'}-${cols}x${rows}`, m, cols, rows)
        controls(`jev-${road}-${enabled ? 'on' : 'off'}-${present ? 'key' : 'no-key'}`, m, cols, rows)
        check(`${road}: card names the selected road`, flat(m).includes('Road') && flat(m).includes(road === 'official' ? 'official' : 'OpenRouter'), flat(m))
        if (enabled && !present) check(`${road}: missing key names its own repair door`, flat(m).includes(road === 'official' ? '/jev' : '/logins') && flat(m).includes('no key'))
        popup.closeSettingsPopup()
        m.unmount()
      }
      await (road === 'official' ? command : routerCommand).call('on', {} as never)
      popup.closeSettingsPopup()
      if (road === 'openrouter') {
        reportedCredits = { limitRemaining: 12.5, observedAtMs: 1000 }
        ledger.resetJevLedger()
        ledger.noteJevAttempt(1000)
        ledger.settleJevCall({ input_tokens: 476, output_tokens: 70, cost: 0.000019992 }, 'typesafe/jev-1.13-20260917', 1000, 'openrouter', 'gen-dec-frame-answer')
        for (const failed of [false, true]) {
          if (failed) ledger.noteJevWireFailure({ kind: 'provider-refused', status: 403, detail: 'fixture access refused', requestId: 'gen-dec-frame-refusal' }, Date.now(), () => 0.5)
          const last = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
          popup.openSettingsPopup(command.jevPopupRequest())
          await waitFor(() => last.screen().includes('Mercury · jev'), 4000)
          await settle(80)
          keep(`jev-last-${failed ? 'refusal' : 'answer'}-${cols}x${rows}`, last, cols, rows)
          check('the last-call line leaves every control visible', flat(last).includes('Sub-agents') && flat(last).includes('Request ceiling'), `missing ${missingControls(last).join(', ') || 'nothing by label'} — ${framed(`jev-last-${failed ? 'refusal' : 'answer'}`, last, cols, rows)}`)
          controls(`jev-last-${failed ? 'refusal' : 'answer'}`, last, cols, rows)
          check('known OpenRouter key credits are labelled as observed, not a live balance', flat(last).includes('$12.50 under key cap') && flat(last).includes('(read '))
          check('last call reports actual id and cost or failure words', failed ? flat(last).includes('HTTP 403') && flat(last).includes('fixture access refused') && flat(last).includes('gen-dec-frame-refusal') : flat(last).includes('typesafe/jev-1.13-20260917') && flat(last).includes('stated $0.000019992') && flat(last).includes('gen-dec-frame-answer'))
          popup.closeSettingsPopup()
          last.unmount()
        }
        ledger.resetJevLedger()
      }
      const cfg = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
      popup.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
      await settle(120)
      await select(cfg, `${CONFIG_ROW_MARK} JEV`)
      keep(`config-${road}-${cols}x${rows}`, cfg, cols, rows)
      check(`${road}: config JEV row names the stored road`, cfg.lines().some(line => line.includes(`${CONFIG_ROW_MARK} JEV`) && line.includes(road === 'official' ? 'official' : 'OpenRouter')))
      popup.closeSettingsPopup()
      cfg.unmount()
      const boot = await mountOffscreen(wrap(React.createElement(BootSettingsScreen as never, { fullScene: { columns: cols, rows }, onClose: () => {} }), cols, rows), cols, rows)
      await settle(150)
      await select(boot, '❯ JEV')
      keep(`boot-${road}-${cols}x${rows}`, boot, cols, rows)
      check(`${road}: Boot row names the stored road`, boot.lines().some(line => line.includes('❯ JEV') && line.includes(road === 'official' ? 'official' : 'OpenRouter')))
      boot.unmount()
      if (road === 'openrouter') ledger.settleJevCall({ input_tokens: 476, output_tokens: 70, cost: 0.000019992 }, 'typesafe/jev-1.13-20260917', 1000, 'openrouter', 'gen-dec-usage-answer')
      const usage = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true }), cols, rows), cols, rows)
      await usageCall('', {} as never)
      await waitFor(() => usage.screen().includes('Mercury · usage'), 4000)
      await settle(150)
      keep(`usage-${road}-${cols}x${rows}`, usage, cols, rows)
      check(`${road}: usage section names the road`, flat(usage).includes(road === 'official' ? 'official' : 'OpenRouter'))
      if (road === 'openrouter') check('usage states the call cost and the known credits without clipping either', flat(usage).includes('last stated $0.000019992') && flat(usage).includes('$12.50 under key cap'))
      popup.closeSettingsPopup()
      usage.unmount()
    }
  }
} finally {
  popup.closeSettingsPopup()
  slot._resetFocusedSessionConnectorForTesting()
  cap._setHeldMachineSeatReadingForTesting(null)
  if (dir) writeFileSync(join(dir, 'index.txt'), ['Source renders: complete /jev cards, /config and Boot faces, and the /usage JEV section; 178x51 and 80x21; no PTY or network.', ...frames].join('\n') + '\n')
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-jev-road-frames: ${frames.length} frames; ${failures ? `${failures} FAILED` : 'ALL PASS'}`)
process.exit(failures ? 1 : 0)
