import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { activeSession, originOf } from '../../../services/browser/browserSession.js'
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../../services/run/ownerKey.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getSystemThemeName } from '../../../utils/systemTheme.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

/** The concrete theme name for tool-use rendering ('auto' resolved). */
function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

type BrowserOptionValue = 'yes' | 'yes-dont-ask-origin' | 'no'

/**
 * The origin this ask is really about: open's TARGET url, otherwise the
 * live page's origin (acts run where the page is). Only a real web origin
 * yields a persistable rule — a provision ask, a non-web scheme or a dead
 * session return null and the card offers NO persist option at all: the
 * whole-tool allow rule (one keystroke disabling the origin grammar for
 * every origin forever) deliberately does not exist on this card.
 */
function originRuleContent(input: unknown, askingContext: { owner?: OwnerKey; agentId?: string }): string | null {
  const i = input as { op?: string; url?: string; secretRef?: string }
  if (i.op === 'provision') return null
  // Sessions are per owner: the live page consulted here must be the ASKING
  // lane's own page, never another agent's.
  const origin =
    i.op === 'open' && typeof i.url === 'string'
      ? originOf(i.url)
      : originOf(activeSession(ownerFromToolUseContext(askingContext))?.page.url() ?? '')
  if (!origin.startsWith('http')) return null
  // A secret fill persists as its PAIRING rule (secret NAME @ origin) —
  // never as a bare origin rule an unrelated act could ride.
  if (i.op === 'type' && typeof i.secretRef === 'string') return `secret:${i.secretRef}@${origin}`
  return `origin:${origin}`
}

/** Browser consent card: origin-scoped persistence, never whole-tool. */
export function BrowserPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const ruleContent = useMemo(
    () => originRuleContent(toolUseConfirm.input, toolUseConfirm.toolUseContext),
    [toolUseConfirm.input, toolUseConfirm.toolUseContext],
  )

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const options: { label: React.ReactNode; value: BrowserOptionValue }[] = [{ label: 'Yes', value: 'yes' }]
  if (ruleContent !== null && shouldShowAlwaysAllowOptions()) {
    options.push({
      label: (
        <Text>
          Yes, and don&apos;t ask again for <Text bold>{ruleContent.replace(/^origin:/, '')}</Text> in this project
        </Text>
      ),
      value: 'yes-dont-ask-origin',
    })
  }
  options.push({
    label: 'No, and tell Mercury what to do differently (esc)',
    value: 'no',
  })

  function handleChange(value: BrowserOptionValue): void {
    switch (value) {
      case 'yes':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        break
      case 'yes-dont-ask-origin':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: toolUseConfirm.tool.name, ruleContent: ruleContent! }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        break
      case 'no':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject', false)
        toolUseConfirm.onReject()
        onReject()
        onDone()
        break
    }
  }

  return (
    <PermissionDialog title="Browser" workerBadge={workerBadge}>
      <Box flexDirection="column">
        <Text>
          {toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
            theme: resolveThemeName(),
            verbose,
          })}
        </Text>
        <Text dimColor>{toolUseConfirm.description}</Text>
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />
        <Text bold>Do you want to allow Mercury to drive this page?</Text>
        <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
