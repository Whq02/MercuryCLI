import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getSystemThemeName } from '../../../utils/systemTheme.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import {
  getFirstWordPrefix,
  getSimpleCommandPrefix,
} from '../../../tools/BashTool/bashPermissions.js'
import { getDestructiveCommandWarning } from '../../../tools/BashTool/destructiveCommandWarning.js'
import { parseSedEditCommand } from '../../../tools/BashTool/sedEditParser.js'
import { shouldUseSandbox } from '../../../tools/BashTool/shouldUseSandbox.js'
import { getCompoundCommandPrefixesStatic } from '../../../utils/bash/prefix.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { SandboxManager } from '../../../utils/sandbox/sandbox-adapter.js'
import type { Message } from '../../../types/message.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js'
import {
  PermissionExplainerContent,
  usePermissionExplainerUI,
} from '../PermissionExplanation.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { SedEditPermissionRequest } from '../SedEditPermissionRequest/SedEditPermissionRequest.js'
import { logUnaryPermissionEvent } from '../utils.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { bashToolUseOptions, type BashToolUseOption } from './bashToolUseOptions.js'

function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

type BashCardInput = { command: string }

function suggestedBashRuleContents(suggestions: PermissionUpdate[]): string[] {
  const contents: string[] = []
  for (const update of suggestions) {
    if (update.type !== 'addRules') continue
    for (const rule of update.rules) {
      if (rule.toolName === BASH_TOOL_NAME && rule.ruleContent) contents.push(rule.ruleContent)
    }
  }
  return contents
}

export function BashPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm } = props
  const input = BashTool.inputSchema.parse(toolUseConfirm.input) as BashCardInput

  const sedEditInfo = parseSedEditCommand(input.command)
  if (sedEditInfo !== null) {
    return <SedEditPermissionRequest {...props} sedEditInfo={sedEditInfo} />
  }
  return <BashCommandPermissionRequest {...props} command={input.command} />
}

function BashCommandPermissionRequest(
  props: PermissionRequestProps & { command: string },
): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, workerBadge, command } = props
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

  const derived = useMemo(() => {
    return {
      warning: getDestructiveCommandWarning(command),
      unsandboxed:
        SandboxManager.isSandboxingEnabled() &&
        !shouldUseSandbox(toolUseConfirm.input as { command?: string }),
    }
  }, [command, toolUseConfirm.input])

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

  const decisionReason =
    'decisionReason' in toolUseConfirm.permissionResult
      ? toolUseConfirm.permissionResult.decisionReason
      : undefined
  const isCompound = decisionReason?.type === 'subcommandResults'

  const initialSeed = useMemo(() => {
    if (isCompound) {
      const contents = gatedSuggestions ? suggestedBashRuleContents(gatedSuggestions) : []
      return contents.length === 1 ? contents[0] : undefined
    }
    const simple = getSimpleCommandPrefix(command)
    if (simple !== null) return `${simple}:*`
    const first = getFirstWordPrefix(command)
    if (first !== null) return `${first}:*`
    return command
  }, [isCompound, gatedSuggestions, command])

  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(initialSeed)
  const userEditedRef = useRef(false)
  const handleEditablePrefixChange = (value: string): void => {
    userEditedRef.current = true
    setEditablePrefix(value)
  }

  useEffect(() => {
    if (isCompound) return
    let cancelled = false
    void getCompoundCommandPrefixesStatic(command, subcommand =>
      BashTool.isReadOnly({ command: subcommand } as never),
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
  }, [command, isCompound])

  const options = bashToolUseOptions({
    suggestions: gatedSuggestions,
    decisionReason,
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

  function handleChange(value: BashToolUseOption): void {
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
              rules: [{ toolName: BASH_TOOL_NAME, ruleContent: trimmed }],
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
      <PermissionDialog
        title={derived.unsandboxed ? 'Bash command (unsandboxed)' : 'Bash command'}
        workerBadge={workerBadge}
      >
        <Box flexDirection="column">
          <Box flexDirection="column">
            {
}
            {typeof (toolUseConfirm.input as { command?: unknown }).command === 'string' ? (
              <ConsentBodyText
                text={(toolUseConfirm.input as { command: string }).command}
                tail=" (the whole command runs)"
                dimColor={explainer.visible}
              />
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
              toolName="Bash"
            />
          ) : (
            <>
              {derived.warning ? <Text color="warning">{derived.warning}</Text> : null}
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
                onInputModeToggle={value => {
                  feedback.handleInputModeToggle(value)
                }}
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
