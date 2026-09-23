import * as React from 'react'
import { nextSettingsOpen } from '../../components/Settings/Settings.js'
import { Usage } from '../../components/Settings/Usage.js'
import { anthropicWindowViews, providerFamilyPresences } from '../../services/providers/providerUsage.js'
import { resolveMoonshotAccount } from '../../services/providers/moonshot/moonshotAccounts.js'
import { walletEntries } from '../../services/wallet/wallet.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'

export const call = async (_args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const openToken = nextSettingsOpen()
  const subscriptions = walletEntries().filter(entry => entry.kind === 'subscription-oauth').length
    + (resolveMoonshotAccount()?.kind === 'kimi-oauth' ? 1 : 0)
  const windows = anthropicWindowViews().filter(window => window.state === 'live' && window.usedPct !== undefined)
  const session = windows.find(window => window.key === '5h')
  const week = windows.find(window => window.key === '7d')
  const meters = [
    ...(session ? [`session ${Math.floor(session.usedPct!)}%`] : []),
    ...(week ? [`week ${Math.floor(week.usedPct!)}%`] : []),
  ]
  openSettingsPopup({
    view: 'usage',
    width: 150,
    rows: 29,
    line: `${providerFamilyPresences().length} providers · ${subscriptions} subscriptions signed in${meters.length ? ` · Anthropic ${meters.join(' · ')}` : ''}`,
    hint: '↑↓ scroll · esc or click outside closes',
    body: geometry => <Usage key={openToken} openToken={openToken} width={geometry.inner} rowBudget={geometry.rowBudget} />,
  })
  return { type: 'skip' }
}
