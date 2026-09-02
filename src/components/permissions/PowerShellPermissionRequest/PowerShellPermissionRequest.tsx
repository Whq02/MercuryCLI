import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { consentCommandPreview } from '../consentPreview.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/featureGates.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getSystemThemeName } from '../../../utils/systemTheme.js'
import { PowerShellTool } from '../../../tools/PowerShellTool/PowerShellTool.js'
import { POWERSHELL_TOOL_NAME } from '../../../tools/PowerShellTool/toolName.js'
import { getDestructiveCommandWarning } from '../../../tools/PowerShellTool/destructiveCommandWarning.js'
import { isAllowlistedCommand } from '../../../tools/PowerShellTool/readOnlyValidation.js'
import { getCompoundCommandPrefixesStatic } from '../../../utils/powershell/staticPrefix.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import type { Message } from '../../../types/message.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js'
import {
  PermissionExplainerContent,
  usePermissionExplainerUI,
} from '../PermissionExplanation.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import {
  powershellToolUseOptions,
  type PowerShellToolUseOption,
} from './powershellToolUseOptions.js'

function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

type PowerShellCardInput = { command: string }

export function PowerShellPermissionRequest({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const { columns, rows: termRows } = useTerminalSize()
  const input = PowerShellTool.inputSchema.parse(toolUseConfirm.input) as PowerShellCardInput
  const command = input.command
  const [debugVisible, setDebugVisible] = useState(false)

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const feedback = useShellPermissionFeedback({
    toolUseConfirm,
    onDone,
    onReject,
    explainerVisible: undefined,
  })

  const warning = useMemo(() => {
    const warningEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'mercury_destructive_command_warning',
      false,
    )
    return warningEnabled ? getDestructiveCommandWarning(command) : null
  }, [command])

  const explainer = usePermissionExplainerUI({
    toolName: toolUseConfirm.tool.name,
    toolInput: toolUseConfirm.input,
    toolDescription: toolUseConfirm.description,
    messages: (toolUseContext as { messages?: Message[] }).messages,
  })

  const askSuggestions =
    toolUseConfirm.permissionResult.behavior === 'ask'
      ? toolUseConfirm.permissionResult.suggestions
      : undefined
  const gatedSuggestions = shouldShowAlwaysAllowOptions() ? askSuggestions : undefined

  const initialSeed = useMemo(
    () => (command.includes('\n') ? undefined : command),
    [command],
  )
  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(initialSeed)
  const userEditedRef = useRef(false)
  const handleEditablePrefixChange = (value: string): void => {
    userEditedRef.current = true
    setEditablePrefix(value)
  }

  useEffect(() => {
    let cancelled = false
    void getCompoundCommandPrefixesStatic(command, element =>
      isAllowlistedCommand(element, command),
    )
      .then(prefixes => {
        if (cancelled || userEditedRef.current) return
        const first = prefixes[0]
        if (first) setEditablePrefix(`${first}:*`)
      })
      .catch(() => {
      })
    return () => {
      cancelled = true
    }
  }, [command])

  const options = powershellToolUseOptions({
    suggestions: gatedSuggestions,
    onAcceptFeedbackChange: feedback.setAcceptFeedback,
    onRejectFeedbackChange: feedback.setRejectFeedback,
    yesInputMode: feedback.yesInputMode,
    noInputMode: feedback.noInputMode,
    editablePrefix,
    onEditablePrefixChange: handleEditablePrefixChange,
  })

  useKeybinding(
    'permission:toggleDebug',
    () => setDebugVisible(current => !current),
    { context: 'Confirmation' },
  )

  function handleChange(value: PowerShellToolUseOption): void {
    switch (value) {
      case 'yes': {
        const accept = feedback.acceptFeedback.trim() || undefined
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', accept !== undefined)
        toolUseConfirm.onAllow(toolUseConfirm.input, [], accept)
        onDone()
        break
      }
      case 'yes-apply-suggestions': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        const result = toolUseConfirm.permissionResult
        const verbatim = ('suggestions' in result ? result.suggestions : undefined) ?? []
        toolUseConfirm.onAllow(toolUseConfirm.input, verbatim)
        onDone()
        break
      }
      case 'yes-edited-prefix': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        const trimmed = (editablePrefix ?? '').trim()
        if (trimmed === '') {
          toolUseConfirm.onAllow(toolUseConfirm.input, [])
        } else {
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [{ toolName: POWERSHELL_TOOL_NAME, ruleContent: trimmed }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
        }
        onDone()
        break
      }
      case 'no':
        feedback.handleReject(feedback.rejectFeedback)
        break
    }
  }

  const focusedIsFeedbackRole =
    (feedback.focusedOption === 'yes' && !feedback.yesInputMode) ||
    (feedback.focusedOption === 'no' && !feedback.noInputMode)
  const debugMode = Boolean(
    (toolUseContext as { options?: { debug?: boolean } }).options?.debug,
  )

  return (
    <Box flexDirection="column">
      <PermissionDialog title="PowerShell command" workerBadge={workerBadge}>
        <Box flexDirection="column">
          <Box flexDirection="column">
            {
}
            {typeof (toolUseConfirm.input as { command?: unknown }).command === 'string' ? (
              (() => {
                const preview = consentCommandPreview(
                  (toolUseConfirm.input as { command: string }).command,
                  columns,
                  termRows,
                )
                return (
                  <>
                    <Text dimColor={explainer.visible}>{preview.text}</Text>
                    {preview.hiddenLines > 0 ? (
                      <Text dimColor>… +{preview.hiddenLines} more lines (the whole command runs)</Text>
                    ) : null}
                  </>
                )
              })()
            ) : (
              <Text dimColor={explainer.visible}>
                {toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
                  theme: resolveThemeName(),
                  verbose: true,
                })}
              </Text>
            )}
            {explainer.visible ? null : (
              <Text dimColor>{toolUseConfirm.description}</Text>
            )}
          </Box>
          <PermissionExplainerContent visible={explainer.visible} promise={explainer.promise} />
          {debugVisible ? (
            <PermissionDecisionDebugInfo
              permissionResult={toolUseConfirm.permissionResult}
              toolName="PowerShell"
            />
          ) : (
            <>
              {warning ? <Text color="warning">{warning}</Text> : null}
              <PermissionRuleExplanation
                permissionResult={toolUseConfirm.permissionResult}
                toolType="command"
              />
              <Text bold>Do you want to proceed?</Text>
              <Select
                options={options}
                onChange={handleChange}
                onCancel={() => feedback.handleReject(undefined)}
                onFocus={feedback.handleFocus}
                onInputModeToggle={feedback.handleInputModeToggle}
              />
            </>
          )}
        </Box>
      </PermissionDialog>
      <Box marginTop={1} justifyContent="space-between">
        <Text color="subtle">
          {'esc cancel'}
          {focusedIsFeedbackRole ? ' · tab amend' : ''}
          {explainer.enabled
            ? ` · ctrl+e ${explainer.visible ? 'hide' : 'explain'}`
            : ''}
        </Text>
        {debugMode ? <Text color="subtle">ctrl+d debug</Text> : null}
      </Box>
    </Box>
  )
}
