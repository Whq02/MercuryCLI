import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../../../hooks/effects.js'
import { Box, Text } from '../../../ink.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { PowerShellTool } from '../../../tools/PowerShellTool/PowerShellTool.js'
import { POWERSHELL_TOOL_NAME } from '../../../constants/tools/powershell.js'
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
import { usePermissionRequestLogging } from '../hooks.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import {
  powershellToolUseOptions,
  type PowerShellToolUseOption,
} from './powershellToolUseOptions.js'
import { passedOver } from '../../../utils/passedOver.js'

type PowerShellCardInput = { command: string }
export function PowerShellPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const { command }: PowerShellCardInput = PowerShellTool.inputSchema.parse(toolUseConfirm.input)
  const description = toolUseConfirm.description

  usePermissionRequestLogging(toolUseConfirm)
  const feedback = useShellPermissionFeedback({ toolUseConfirm, onDone, onReject })
  const [debugMode, setDebugMode] = useState(false)

  useKeybinding(
    'permission:toggleDebug',
    () => setDebugMode(prev => !prev),
    { context: 'Confirmation' },
  )

  const messages: Message[] | undefined = toolUseConfirm.toolUseContext?.messages
  const explainer = usePermissionExplainerUI({
    toolName: POWERSHELL_TOOL_NAME,
    toolInput: toolUseConfirm.input,
    toolDescription: description,
    messages,
  })

  const suggestions = useMemo(
    () =>
      shouldShowAlwaysAllowOptions() && toolUseConfirm.permissionResult.behavior === 'ask'
        ? (toolUseConfirm.permissionResult.suggestions ?? [])
        : [],
    [toolUseConfirm.permissionResult],
  )

  const isSingleLine = !command.includes('\n') && !command.includes('\r')
  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(() =>
    isSingleLine ? command : undefined,
  )
  const [isWildcard, setIsWildcard] = useState(false)
  const userEditedRef = useRef(false)

  useLoad(signal => {
    if (!isSingleLine) return
    getCompoundCommandPrefixesStatic(command, element => isAllowlistedCommand(element, command))
      .then(prefixes => {
        if (signal.aborted || userEditedRef.current) return
        const prefix = prefixes.length === 1 ? prefixes[0] : undefined
        if (prefix) {
          setEditablePrefix(prefix.includes('*') ? prefix : `${prefix} *`)
          setIsWildcard(true)
        }
      })
      .catch(passedOver)
  }, [command, isSingleLine])

  const handleEditablePrefixChange = React.useCallback((next: string): void => {
    userEditedRef.current = true
    setEditablePrefix(next)
  }, [])

  const options = useMemo(
    () =>
      powershellToolUseOptions({
        suggestions,
        onRejectFeedbackChange: feedback.setRejectFeedback,
        onAcceptFeedbackChange: feedback.setAcceptFeedback,
        yesInputMode: feedback.yesInputMode,
        noInputMode: feedback.noInputMode,
        editablePrefix,
        onEditablePrefixChange: handleEditablePrefixChange,
      }),
    [
      suggestions,
      feedback.setRejectFeedback,
      feedback.setAcceptFeedback,
      feedback.yesInputMode,
      feedback.noInputMode,
      editablePrefix,
      handleEditablePrefixChange,
    ],
  )

  const handleSelect = (value: PowerShellToolUseOption): void => {
    toolUseConfirm.onUserInteraction()
    switch (value) {
      case 'yes': {
        const trimmed = feedback.acceptFeedback.trim()
        toolUseConfirm.onAllow(toolUseConfirm.input, [], trimmed || undefined)
        onDone()
        return
      }
      case 'yes-apply-suggestions': {
        toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
        onDone()
        return
      }
      case 'yes-edited-prefix': {
        const trimmed = (editablePrefix ?? '').trim()
        if (trimmed === '') {
          toolUseConfirm.onAllow(toolUseConfirm.input, [])
          onDone()
          return
        }
        const ruleContent = isWildcard && !trimmed.includes('*') ? `${trimmed} *` : trimmed
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: POWERSHELL_TOOL_NAME, ruleContent }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        return
      }
      case 'no': {
        feedback.handleReject(feedback.rejectFeedback)
        return
      }
    }
  }

  const toolUseMessage = !command
    ? toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input, {
        theme: resolveThemeName(),
        verbose,
      })
    : null

  const canAmend =
    !debugMode &&
    ((feedback.focusedOption === 'yes' && !feedback.yesInputMode) ||
      (feedback.focusedOption === 'no' && !feedback.noInputMode))

  return (
    <PermissionDialog
      title="PowerShell command"
      crewmate={toolUseConfirm.crewmate}
      workerBadge={workerBadge}
    >
      <Box flexDirection="column">
        {command ? (
          <ConsentBodyText
            text={command}
            tail=" (the whole command runs)"
            dimColor={explainer.visible}
          />
        ) : typeof toolUseMessage === 'string' ? (
          <Text dimColor={explainer.visible}>{toolUseMessage}</Text>
        ) : (
          toolUseMessage
        )}
        {!explainer.visible && description ? <Text dimColor>{description}</Text> : null}
        <PermissionExplainerContent
          visible={explainer.visible}
          promise={explainer.promise}
        />
        {debugMode ? (
          <PermissionDecisionDebugInfo
            permissionResult={toolUseConfirm.permissionResult}
            toolName="PowerShell"
          />
        ) : (
          <Box flexDirection="column">
            <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
            <Text bold>Do you want to proceed?</Text>
            <Select
              scrollMovesFocus={false}
              options={options}
              onChange={handleSelect}
              onCancel={() => feedback.handleReject()}
              onFocus={feedback.handleFocus}
              onInputModeToggle={feedback.handleInputModeToggle}
            />
          </Box>
        )}
        <Box justifyContent="space-between" marginTop={1}>
          <Text dimColor>
            esc cancel
            {canAmend ? ' · tab amend' : ''}
            {explainer.enabled ? ` · ctrl+e ${explainer.visible ? 'hide' : 'explain'}` : ''}
          </Text>
          {debugMode ? <Text dimColor>ctrl+d debug</Text> : null}
        </Box>
      </Box>
    </PermissionDialog>
  )
}
