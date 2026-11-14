import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { approvalScopeWords, checkedRuleContent, crossingScopeWords } from '../../../services/browser/browserWords.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type BrowserOptionValue = 'yes' | 'yes-dont-ask-origin' | 'no'


export function BrowserPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const ruleContent = useMemo(
    () => checkedRuleContent(toolUseConfirm.permissionResult, toolUseConfirm.input),
    [toolUseConfirm.permissionResult, toolUseConfirm.input],
  )

  usePermissionRequestLogging(toolUseConfirm)

  const input = toolUseConfirm.input as { op?: string; secretRef?: string; emulation?: { headers?: unknown; credentials?: unknown } }
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
  const emulationAct = input.op === 'viewport' && (input.emulation?.headers != null || input.emulation?.credentials != null)
  const scopeLines =
    provisioning || emulationAct || input.secretRef !== undefined || ruleContent?.startsWith('secret:') === true || !askedOrigin.startsWith('http')
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
          <Select scrollMovesFocus={false} options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
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
        <Select scrollMovesFocus={false} options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
