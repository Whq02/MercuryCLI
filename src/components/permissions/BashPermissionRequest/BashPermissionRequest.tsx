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

/** The concrete theme name for tool-use rendering ('auto' resolved). */
function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

type BashCardInput = { command: string }

/** The engine's suggested Bash rules with non-empty content. */
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
  // Strict parse: a schema failure throws; there is no local recovery.
  const input = BashTool.inputSchema.parse(toolUseConfirm.input) as BashCardInput

  // Pure input-driven delegation, BEFORE any hooks run: an in-place sed
  // substitution renders the sed-edit card instead of this one.
  const sedEditInfo = parseSedEditCommand(input.command)
  if (sedEditInfo !== null) {
    return <SedEditPermissionRequest {...props} sedEditInfo={sedEditInfo} />
  }
  return <BashCommandPermissionRequest {...props} command={input.command} />
}

function BashCommandPermissionRequest(
  props: PermissionRequestProps & { command: string },
): React.ReactNode {
  const { columns, rows: termRows } = useTerminalSize()
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

  // Load-bearing memo: the warning analysis and the sandbox derivation walk
  // the whole command string; recomputing them per keystroke burns CPU.
  const derived = useMemo(() => {
    const warningEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'mercury_destructive_command_warning',
      // Mercury deliberately flipped THIS card's default on (the base
      // default is false and the gate is never set) to get the informational
      // warning; the PowerShell card keeps the default.
      true,
    )
    return {
      warning: warningEnabled ? getDestructiveCommandWarning(command) : null,
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

  // The always-allow slot is fed ONLY from an `ask` decision, and only while
  // persisted-rule creation is permitted.
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

  // Sync prefix seed. A compound command takes the engine's suggestion as
  // authoritative: exactly one Bash rule seeds the editable input, otherwise
  // there is no seed (the non-editable option saves every rule atomically).
  // A simple command seeds from the local heuristics, falling back to the
  // raw command so the seed is never absent.
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

  // Async parser-backed refinement — never on a compound command; cancelled
  // on unmount; abandoned once the user edits. Inert while the parser lane is
  // hollow (the extractor answers an empty list), and kept wired so a
  // re-armed parser makes it live.
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
        // refinement failure keeps the sync seed
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
        // Verbatim from the decision — an ask OR a passthrough decision both
        // carry consumable suggestions here; missing means empty.
        const result = toolUseConfirm.permissionResult
        const verbatim = ('suggestions' in result ? result.suggestions : undefined) ?? []
        toolUseConfirm.onAllow(toolUseConfirm.input, verbatim)
        onDone()
        break
      }
      case 'yes-edited-prefix': {
        // Accept telemetry fires BEFORE the empty check either way.
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
            {/* C5 (TS-6): the command preview is HEIGHT-BOUND — an uncapped
                heredoc pushed this card's own Yes/No off the pane; the cut is
                named so nothing hides silently. Non-string inputs keep the
                tool's own renderer. */}
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
