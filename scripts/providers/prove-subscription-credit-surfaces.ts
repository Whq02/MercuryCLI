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
    providerUsageView: () => ({ provider: 'openai', entries: [{ kind: 'subscription-oauth', label: 'ChatGPT Pro' }], activeEntry: { kind: 'subscription-oauth' }, sessionSpend: view.spend, limits: { kind: 'openai-observed', window: { state: 'clear' } } }),
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
  const { Deck } = await import(world.path('src/components/Deck.tsx'))
  const { AccountView } = await import(world.path('src/components/mercury-ui/parity/AccountView.tsx'))
  const { AppStateProvider } = await import(world.path('src/state/AppState.tsx'))
  const { HelmTelemetryRail } = await import(world.path('src/components/HelmTelemetryRail.tsx'))
  const { railPlanAt } = await import(world.path('src/utils/helmGeometry.ts'))
  for (const columns of [80, 120]) {
    const at = { columns, rows: 70 }
    for (const [name, node] of [
      ['usage', React.createElement(Usage, { width: columns - 4, rowBudget: 60 })],
      ['deck', React.createElement(Deck, { onClose() {} })],
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
} finally {
  world.close()
}
finish()
