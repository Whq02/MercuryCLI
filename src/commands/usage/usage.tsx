import * as React from 'react'
import { nextSettingsOpen, useOptionalSettingsPopupFrame } from '../../components/Settings/Settings.js'
import { Usage } from '../../components/Settings/Usage.js'
import { subscribeUsageRecord } from '../../services/anthropicLimits.js'
import { anthropicWindowViews, providerFamilyPresences } from '../../services/providers/providerUsage.js'
import { resolveMoonshotAccount } from '../../services/providers/moonshot/moonshotAccounts.js'
import { walletEntries } from '../../services/wallet/wallet.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'

function UsageBody({ headerLine, ...usage }: React.ComponentProps<typeof Usage> & { headerLine: () => string }): React.ReactNode {
  const setLine = useOptionalSettingsPopupFrame()?.setLine
  React.useLayoutEffect(() => {
    if (setLine === undefined) return
    const follow = (): void => setLine(headerLine())
    follow()
    return subscribeUsageRecord(follow)
  }, [setLine, headerLine])
  return <Usage {...usage} />
}

export const call = async (_args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const openToken = nextSettingsOpen()
  const subscriptions = walletEntries().filter(entry => entry.kind === 'subscription-oauth').length
    + (resolveMoonshotAccount()?.kind === 'kimi-oauth' ? 1 : 0)
  const providers = providerFamilyPresences().length
  const headerLine = (): string => {
    const windows = anthropicWindowViews().filter(window => window.state === 'live' && window.usedPct !== undefined)
    const session = windows.find(window => window.key === '5h')
    const week = windows.find(window => window.key === '7d')
    const meters = [
      ...(session ? [`session ${Math.floor(session.usedPct!)}%`] : []),
      ...(week ? [`week ${Math.floor(week.usedPct!)}%`] : []),
    ]
    return `${providers} providers · ${subscriptions} subscriptions signed in${meters.length ? ` · Anthropic ${meters.join(' · ')}` : ''}`
  }
  openSettingsPopup({
    view: 'usage',
    width: hostColumns => Math.min(150, hostColumns),
    rows: 29,
    line: headerLine(),
    hint: '↑↓ scroll · esc or click outside closes',
    body: geometry => <UsageBody key={openToken} headerLine={headerLine} openToken={openToken} width={geometry.inner} rowBudget={geometry.rowBudget} compact={geometry.compact} />,
  })
  return { type: 'skip' }
}
