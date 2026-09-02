import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT } from './mercuryPalette.js'
import { SpecimenGallery, type GalleryItem } from './mercury-ui/SpecimenGallery.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

import { MercuryWelcome } from './MercuryWelcome.js'
import { MercuryPermissionCard } from './MercuryPermissionCard.js'
import { MercuryPromptFooter } from './MercuryPromptFooter.js'
import { MercuryMcpList } from './MercuryMcpList.js'
import { MercuryConfig } from './MercuryConfig.js'
import { MercuryToolCard } from './MercuryToolCard.js'
import { MercuryDiff } from './MercuryDiff.js'
import { MercurySkills } from './MercurySkills.js'
import { MercuryHooks } from './MercuryHooks.js'
import { MercuryTrust } from './MercuryTrust.js'
import { MercurySandbox } from './MercurySandbox.js'
import { MercuryTasks } from './MercuryTasks.js'
import { MercuryAgents } from './MercuryAgents.js'
import { MercuryCompact } from './MercuryCompact.js'
import { MercuryRateLimit } from './MercuryRateLimit.js'
import { MercuryExit } from './MercuryExit.js'
import { MercuryResume } from './MercuryResume.js'
import { MercuryNotices } from './MercuryNotices.js'
import { MercuryLogin } from './MercuryLogin.js'
import { MercuryApiKey } from './MercuryApiKey.js'
import { MercuryCostThreshold } from './MercuryCostThreshold.js'
import { MercuryIdleReturn } from './MercuryIdleReturn.js'
import { MercuryExport } from './MercuryExport.js'
import { MercurySearch } from './MercurySearch.js'
import { MercuryQuickOpen } from './MercuryQuickOpen.js'
import { MercuryLanguagePicker } from './MercuryLanguagePicker.js'
import { MercuryStatusline } from './MercuryStatusline.js'
import { MercuryOnboarding } from './MercuryOnboarding.js'
import { MercuryReleaseNotes } from './MercuryReleaseNotes.js'
import { MercuryMemorySelector } from './MercuryMemorySelector.js'
import { MercuryPlanApproval } from './MercuryPlanApproval.js'
import { MercuryShellOutput } from './MercuryShellOutput.js'
import { MercuryVimIndicator } from './MercuryVimIndicator.js'
import { MercuryContextViz } from './MercuryContextViz.js'
import { MercuryTeleport } from './MercuryTeleport.js'
import { MercuryBridge } from './MercuryBridge.js'
import { MercuryKeybindings } from './MercuryKeybindings.js'
import { MercurySpinnerLine } from './MercurySpinnerLine.js'
import { MercuryTeammateTree } from './MercuryTeammateTree.js'
import { MercuryChannelsNotice } from './MercuryChannelsNotice.js'
import { MercuryEmergencyTip } from './MercuryEmergencyTip.js'
import { MercuryInterrupted } from './MercuryInterrupted.js'
import { MercuryCompactSummary } from './MercuryCompactSummary.js'
import { MercuryPrBadge } from './MercuryPrBadge.js'
import { MercuryTokenWarning } from './MercuryTokenWarning.js'
import { MercuryAutoUpdater } from './MercuryAutoUpdater.js'
import { MercuryEffortCallout } from './MercuryEffortCallout.js'
import { MercuryRemoteCallout } from './MercuryRemoteCallout.js'
import { MercuryIdeStatus } from './MercuryIdeStatus.js'
import { MercuryDegradedBanner } from './MercuryDegradedBanner.js'

function specimen(node: React.ReactNode): React.ComponentType<{ onClose: () => void }> {
  return function Specimen({ onClose }: { onClose: () => void }): React.ReactNode {
    const pastOpenEvent = useOpenEventGate()
    useInput(
      (_i, key) => {
        if (key.escape) return onClose()
        if (key.return && pastOpenEvent()) return onClose()
      },
      { isActive: true },
    )
    const display = React.isValidElement(node)
      ? React.cloneElement(node as React.ReactElement<Record<string, unknown>>, {
          isActive: false,
          onClose: () => {},
        })
      : node
    return (
      <Box flexDirection="column">
        {display}
        <Box marginTop={1}>
          <Text color={FAINT}>esc to back</Text>
        </Box>
      </Box>
    )
  }
}

const item = (key: string, label: string, node: React.ReactNode): GalleryItem => ({
  key,
  label,
  state: 'planned',
  Component: specimen(node),
})

const group = (g: string, ...its: GalleryItem[]): GalleryItem[] =>
  its.map(it => ({ ...it, group: g }))

const ITEMS: GalleryItem[] = [
  ...group(
    'Startup & identity',
    item('welcome', 'Welcome / splash', <MercuryWelcome />),
    item('onboarding', 'Onboarding', <MercuryOnboarding />),
    item('login', 'Login', <MercuryLogin />),
    item('api-key', 'API key', <MercuryApiKey />),
    item('release-notes', 'Release notes', <MercuryReleaseNotes />),
  ),
  ...group(
    'Prompt & input',
    item('prompt-footer', 'Prompt composer footer', <MercuryPromptFooter />),
    item('vim', 'Vim indicator', <MercuryVimIndicator />),
    item('keybindings', 'Keybindings', <MercuryKeybindings />),
    item('search', 'Search', <MercurySearch onClose={() => {}} />),
    item('quick-open', 'Quick open', <MercuryQuickOpen onClose={() => {}} />),
    item('language', 'Language picker', <MercuryLanguagePicker onComplete={() => {}} onCancel={() => {}} />),
  ),
  ...group(
    'Tools & files',
    item('tool-card', 'Tool / action card', <MercuryToolCard />),
    item('diff', 'Diff block', <MercuryDiff />),
    item('shell-output', 'Shell output', <MercuryShellOutput />),
    item('tasks', 'Tasks', <MercuryTasks />),
    item('agents', 'Agents', <MercuryAgents />),
    item('skills', 'Skills list', <MercurySkills />),
    item('hooks', 'Hooks list', <MercuryHooks />),
    item('memory', 'Memory selector', <MercuryMemorySelector onClose={() => {}} />),
  ),
  ...group(
    'Permissions & safety',
    item('permission-card', 'Permission request card', <MercuryPermissionCard />),
    item('trust', 'Trust dialog', <MercuryTrust />),
    item('sandbox', 'Sandbox', <MercurySandbox />),
    item('notices', 'Notices', <MercuryNotices />),
    item('degraded-banner', 'Degraded banner', <MercuryDegradedBanner />),
  ),
  ...group(
    'MCP, config & IDE',
    item('mcp-list', 'MCP server list', <MercuryMcpList onClose={() => {}} />),
    item('config', 'Config / settings', <MercuryConfig onClose={() => {}} />),
    item('statusline', 'Statusline config', <MercuryStatusline />),
    item('ide', 'IDE status', <MercuryIdeStatus />),
  ),
  ...group(
    'Plan & help',
    item('plan-approval', 'Plan approval', <MercuryPlanApproval />),
  ),
  ...group(
    'Status & spinner',
    item('spinner', 'Spinner line', <MercurySpinnerLine />),
    item('effort', 'Effort callout', <MercuryEffortCallout />),
    item('token-warning', 'Token warning', <MercuryTokenWarning />),
    item('context-viz', 'Context viz', <MercuryContextViz />),
    item('compact', 'Compact', <MercuryCompact />),
    item(
      'compact-summary',
      'Compact summary',
      <MercuryCompactSummary
        summary="Summary: refactored the responsive deck/fleet layout and wired the compact card."
        pct={63}
        messagesSummarized={48}
      />,
    ),
    item('interrupted', 'Interrupted', <MercuryInterrupted />),
    item('pr-badge', 'PR badge', <MercuryPrBadge />),
  ),
  ...group(
    'Session & resume',
    item('resume', 'Resume picker', <MercuryResume onClose={() => {}} />),
    item('export', 'Export', <MercuryExport />),
    item('exit', 'Exit', <MercuryExit />),
    item('idle-return', 'Idle return', <MercuryIdleReturn />),
    item('teleport', 'Teleport', <MercuryTeleport />),
  ),
  ...group(
    'Coordination & remote',
    item('bridge', 'Bridge', <MercuryBridge />),
    item('teammate-tree', 'Teammate tree', <MercuryTeammateTree />),
    item('channels', 'Channels notice', <MercuryChannelsNotice />),
    item('remote', 'Remote callout', <MercuryRemoteCallout />),
    item('emergency-tip', 'Emergency tip', <MercuryEmergencyTip />),
  ),
  ...group(
    'Account & limits',
    item('rate-limit', 'Rate limit', <MercuryRateLimit />),
    item('cost-threshold', 'Cost threshold', <MercuryCostThreshold />),
    item('auto-updater', 'Auto-updater', <MercuryAutoUpdater />),
  ),
]

export function MercuryShowcase({ onClose }: { onClose: () => void }): React.ReactNode {
  return (
    <SpecimenGallery
      view="showcase"
      heading="Promoted surfaces"
      note="design specimens · illustrative props, not live data"
      items={ITEMS}
      onClose={onClose}
    />
  )
}
