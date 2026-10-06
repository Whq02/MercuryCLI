#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { tally, usagePlanWorld } from './lib/usage-plan-world.ts'
import type { ActiveSourceUsage } from '../../src/services/providers/providerUsage.js'

const { check, finish } = tally()
const world = await usagePlanWorld()
try {
  const view: ActiveSourceUsage = {
    provider: 'openai', sourceKind: 'subscription-oauth', shape: 'subscription-windows', label: 'OpenAI usage', tier: 'ChatGPT Pro',
    windows: [{ key: 'wk', label: 'wk', state: 'live', usedPct: 99, source: 'endpoint', observedAtMs: world.now() }], pools: [],
    spend: { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 },
    credits: { state: 'reported', display: '62,500', compact: '62.5k', source: 'endpoint', observedAtMs: world.now() },
  }
  const family = { id: 'openai', available: true, credentialed: true, credentialLabel: 'ChatGPT Pro' }
  const slot = { family: 'openai', id: 'openai:subscription', name: 'chatgpt', kind: 'subscription', kindLabel: 'subscription', identity: 'ChatGPT Pro', active: true, envPinned: false, signedIn: true, removal: { route: 'openai-subscription' } }
  const originalUsage = world.owner.usageForProvider
  mock.module(world.path('src/services/providers/providerUsage.ts'), () => ({
    ...world.owner,
    usageForProvider: (id: string) => id === 'openai' ? view : originalUsage(id as never),
    activeSourceUsage: () => view,
    windowSourceUsages: () => ({ primary: view, others: [] }),
    providerFamilyPresences: () => [family],
    providerUsageView: () => ({ provider: 'openai', entries: [{ kind: 'subscription-oauth', label: 'ChatGPT Pro' }], activeEntry: { kind: 'subscription-oauth' }, sessionSpend: view.spend, limits: { kind: 'openai-observed', window: view.limited !== undefined ? { state: 'limited', resetsAtMs: view.limited.resetsAtMs, observedAtMs: world.now() } : { state: 'clear' } } }),
    openaiObservedWindowViews: () => view.windows,
    refreshProviderUsage: async () => {},
  }))
  const slots = await import(world.path('src/services/providers/accountSlots.ts'))
  mock.module(world.path('src/services/providers/accountSlots.ts'), () => ({ ...slots, deriveFamilySlotGroups: () => [{ family, slots: [slot] }] }))
  const catalogue = await import(world.path('src/services/providers/catalogueOnDemand.ts'))
  mock.module(world.path('src/services/providers/catalogueOnDemand.ts'), () => ({ ...catalogue, readCatalogueIfPending: async () => {} }))
  const hook = await import(world.path('src/hooks/useProviderUsageOnShow.ts'))
  mock.module(world.path('src/hooks/useProviderUsageOnShow.ts'), () => ({ ...hook, useProviderUsageOnShow: () => {} }))
  const { Usage } = await import(world.path('src/components/Settings/Usage.tsx'))
  const { AccountView } = await import(world.path('src/components/mercury-ui/parity/AccountView.tsx'))
  const { AppStateProvider } = await import(world.path('src/state/AppState.tsx'))
  const { HelmTelemetryRail } = await import(world.path('src/components/HelmTelemetryRail.tsx'))
  const { railPlanAt } = await import(world.path('src/utils/helmGeometry.ts'))
  for (const columns of [80, 120]) {
    const at = { columns, rows: 70 }
    for (const [name, node] of [
      ['usage', React.createElement(Usage, { width: columns - 4, rowBudget: 60 })],
      ['accounts', React.createElement(AppStateProvider, { children: React.createElement(AccountView, { onClose() {} }) })],
    ] as const) {
      const board = await world.mount(node, at)
      const frame = board.frame()
      world.save(`credits-${name}`, frame, at)
      check(`${name} at ${columns}: the subscription balance is visible`, frame.includes('62,500'), frame)
      if (name === 'usage') check(`usage at ${columns}: the balance belongs to the account, not the absent key`, frame.indexOf('62,500') < frame.indexOf('API key'), frame)
      check(`${name} at ${columns}: the frame fits`, world.inBounds(frame, at) && !frame.includes('RENDER ERROR'), frame)
      board.close()
    }
    const board = await world.mount(React.createElement(HelmTelemetryRail, { width: 30, availRows: 65 }), at)
    world.save('credits-rail-source', board.frame(), at)
    check(`rail source at ${columns}: the compact balance follows the subscription window`, board.frame().includes('credits 62.5k'), board.frame())
    check(`rail at ${columns}: host visibility follows its existing layout`, typeof railPlanAt(columns, true).telemetry === 'boolean')
    board.close()
  }
  slot.active = false
  Object.assign(slot, { credits: view.credits })
  const inactive = await world.mount(React.createElement(AppStateProvider, { children: React.createElement(AccountView, { onClose() {} }) }), { columns: 80, rows: 70 })
  check('an inactive sign-in with its own credits keeps them on its row', inactive.frame().includes('62,500'), inactive.frame())
  inactive.close()
  view.credits = { state: 'unreported', reason: 'not stated on this reply yet', compact: 'not stated yet' }
  view.windows = []
  const board = await world.mount(React.createElement(Usage, { width: 76, rowBudget: 60 }), { columns: 80, rows: 70 })
  check('the subscription without a figure says why instead of zero', board.frame().includes('credits: not stated on this reply yet') && !board.frame().includes('62,500'), board.frame())
  world.save('credits-usage-unreported', board.frame(), { columns: 80, rows: 70 })
  board.close()

  const shapes: Array<{ name: string; shape: Partial<ActiveSourceUsage>; tab?: string; rail: string[] }> = [
    {
      name: 'openai-full-on-credits',
      shape: {
        provider: 'openai', label: 'OpenAI usage', tier: 'ChatGPT Pro',
        windows: [{ key: 'wk', label: 'wk', state: 'live', usedPct: 100, resetsAtMs: world.now() + 6 * 86_400_000, source: 'endpoint', observedAtMs: world.now() }],
        credits: { state: 'reported', display: '62,500', compact: '62.5k', source: 'endpoint', observedAtMs: world.now() },
        carry: { state: 'carries', display: 'on credits · 62,500 left', compact: 'on credits 62.5k', source: 'endpoint', observedAtMs: world.now() },
      },
      tab: 'A usage window reads 100% · on credits · 62,500 left.',
      rail: ['100% · on credits 62.5k'],
    },
    {
      name: 'openai-walled-no-credits',
      shape: {
        provider: 'openai', label: 'OpenAI usage', tier: 'ChatGPT Pro',
        windows: [{ key: 'wk', label: 'wk', state: 'live', usedPct: 100, resetsAtMs: world.now() + 6 * 86_400_000, source: 'headers', observedAtMs: world.now() }],
        credits: { state: 'unreported', reason: 'no credits on this plan', compact: 'none on this plan', source: 'headers', observedAtMs: world.now() },
        carry: { state: 'nothing', display: 'no credits — nothing carries requests until the reset', compact: 'no credits', source: 'headers', observedAtMs: world.now() },
        limited: { resetsAtMs: world.now() + 30 * 60_000 },
      },
      tab: 'A usage window is reached — resets ',
      rail: ['limit reached · resets', 'no credits'],
    },
    {
      name: 'anthropic-walled-extra-off',
      shape: {
        provider: 'anthropic', label: 'Anthropic usage', tier: 'Claude Max',
        windows: [{ key: '5h', label: '5h', state: 'live', usedPct: 100, resetsAtMs: world.now() + 3_600_000, source: 'endpoint', observedAtMs: world.now() }, { key: '7d', label: '7d', state: 'live', usedPct: 44, resetsAtMs: world.now() + 6 * 86_400_000, source: 'endpoint', observedAtMs: world.now() }],
        credits: { state: 'unreported', reason: 'extra usage off', compact: 'extra off', source: 'endpoint', observedAtMs: world.now() },
        carry: { state: 'nothing', display: 'extra usage off — nothing carries requests until the reset', compact: 'extra usage off', source: 'endpoint', observedAtMs: world.now() },
        limited: { resetsAtMs: world.now() + 3_600_000 },
      },
      rail: ['limit reached · resets', 'extra usage off'],
    },
    {
      name: 'kimi-full-on-wallet',
      shape: {
        provider: 'moonshot', label: 'Kimi usage', tier: 'Kimi sign-in', sourceKind: 'oauth',
        windows: [{ key: '5h', label: '5h', state: 'live', usedPct: 100, resetsAtMs: world.now() + 3_600_000, source: 'endpoint', observedAtMs: world.now() }],
        credits: { state: 'reported', display: 'CNY 12.34 Extra Usage balance', compact: 'CNY 12.34 extra', source: 'endpoint', observedAtMs: world.now() },
        carry: { state: 'carries', display: 'on Extra Usage · CNY 12.34 left', compact: 'on Extra Usage CNY 12.34', source: 'endpoint', observedAtMs: world.now() },
      },
      rail: ['100% · on Extra Usage CNY 12.34'],
    },
  ]
  for (const { name, shape, tab, rail } of shapes) {
    delete view.limited
    Object.assign(view, { sourceKind: 'subscription-oauth', shape: 'subscription-windows', pools: [] }, shape)
    for (const columns of [80, 120]) {
      const at = { columns, rows: 70 }
      if (tab !== undefined) {
        const usageBoard = await world.mount(React.createElement(Usage, { width: columns - 4, rowBudget: 60 }), at)
        world.save(`carry-${name}-usage`, usageBoard.frame(), at)
        const usageFrame = usageBoard.frame().replace(/\s+/g, ' ')
        check(`${name}: the /usage tab at ${columns} says what carries the requests after its reached sentence`, usageFrame.includes(tab) && (view.limited === undefined || usageFrame.includes(view.carry!.display)) && world.inBounds(usageBoard.frame(), at) && !usageBoard.frame().includes('RENDER ERROR'), usageBoard.frame())
        usageBoard.close()
      }
      const railBoard = await world.mount(React.createElement(HelmTelemetryRail, { width: 30, availRows: 65 }), at)
      world.save(`carry-${name}-rail`, railBoard.frame(), at)
      const railFlat = railBoard.frame().split('\n').map(line => line.replace(/[│╭╮╰╯─]/g, '').trim()).join(' ').replace(/\s+/g, ' ')
      check(`${name}: the rail at ${columns} paints the compact carry words under its reached line`, rail.every(words => railFlat.includes(words)) && railFlat.indexOf(rail[rail.length - 1]!) >= railFlat.indexOf(rail[0]!) && !railBoard.frame().includes('RENDER ERROR'), railBoard.frame())
      railBoard.close()
    }
  }
} finally {
  world.close()
}
finish()
