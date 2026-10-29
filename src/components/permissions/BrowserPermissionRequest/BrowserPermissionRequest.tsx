import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { activeSession, originOf } from '../../../services/browser/browserSession.js'
import { approvalScopeWords, crossingScopeWords } from '../../../services/browser/browserWords.js'
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../../services/run/ownerKey.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type BrowserOptionValue = 'yes' | 'yes-dont-ask-origin' | 'no'

function originRuleContent(input: unknown, askingContext: { owner?: OwnerKey; agentId?: string }): string | null {
  const i = input as { op?: string; url?: string; secretRef?: string }
  if (i.op === 'provision') return null

  const origin =
    i.op === 'open' && typeof i.url === 'string'
      ? originOf(i.url)
      : originOf(activeSession(ownerFromToolUseContext(askingContext))?.page.url() ?? '')
  if (!origin.startsWith('http')) return null

  if (i.op === 'type' && typeof i.secretRef === 'string') return `secret:${i.secretRef}@${origin}`
  return `origin:${origin}`
}

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

  usePermissionRequestLogging(toolUseConfirm)

  const input = toolUseConfirm.input as { op?: string; secretRef?: string }
  const provisioning = input.op === 'provision'
  const reason =
    'decisionReason' in toolUseConfirm.permissionResult ? toolUseConfirm.permissionResult.decisionReason : undefined
  const downloadLines =
    provisioning && reason?.type === 'other' ? reason.reason.split('\n').filter(Boolean) : []
  const suggestedRule =
    'suggestions' in toolUseConfirm.permissionResult
      ? toolUseConfirm.permissionResult.suggestions?.find(s => s.type === 'addRules')
      : undefined
  const suggestedContent =
    suggestedRule && suggestedRule.type === 'addRules' ? suggestedRule.rules[0]?.ruleContent : undefined
  const askedOrigin = (ruleContent ?? suggestedContent ?? '').replace(/^origin:/, '')
  const scopeLines =
    provisioning || input.secretRef !== undefined || !askedOrigin.startsWith('http')
      ? []
      : input.op === 'open'
        ? approvalScopeWords(askedOrigin)
        : reason?.type === 'safetyCheck' && reason.reason.includes('reached by navigation')
          ? crossingScopeWords(askedOrigin)
          : []

  const options: { label: React.ReactNode; value: BrowserOptionValue }[] = [
    { label: provisioning ? 'Yes, download it' : 'Yes', value: 'yes' },
  ]
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
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        break
      case 'yes-dont-ask-origin':
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
        toolUseConfirm.onReject()
        onReject()
        onDone()
        break
    }
  }

  const useMessage = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
    theme: resolveThemeName(),
    verbose,
  })

  if (provisioning) {
    return (
      <PermissionDialog title="Browser download" workerBadge={workerBadge}>
        <Box flexDirection="column">
          {downloadLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Text dimColor>Nothing is downloaded until you say yes; your installed browsers are never driven.</Text>
          <Text bold>Download this browser build?</Text>
          <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
        </Box>
      </PermissionDialog>
    )
  }

  return (
    <PermissionDialog title="Browser" workerBadge={workerBadge}>
      <Box flexDirection="column">
        {typeof useMessage === 'string' ? (
          <ConsentBodyText text={useMessage} />
        ) : (
          <Text>{useMessage}</Text>
        )}
        {scopeLines.length > 0 ? (
          scopeLines.map((line, i) => <Text key={i}>{line}</Text>)
        ) : (
          <Text dimColor>{toolUseConfirm.description}</Text>
        )}
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
        <Text bold>Do you want to allow Mercury to drive this page?</Text>
        <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
