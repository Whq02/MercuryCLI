import { resolve } from 'node:path'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../../../screen/effects/effects.js'
import { Box, Text } from '../../../screen/themedRenderer.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { boundLines, consentBodyBudget, consentContentWidth } from '../consentBodyBudget.js'
import { drawnRows, reasonCutToFit, ROWS_ROUND_THE_CARD_TEXT } from '../consentReasonBudget.js'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import { Select } from '../../../screen/select/Select.js'
import { useKeybinding } from '../../../screen/keys/useKeybinding.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { BashTool } from '../../../tools/shell/BashTool.js'
import { BASH_TOOL_NAME } from '../../../tools/kit/names/bash.js'
import {
  getFirstWordPrefix,
  getSimpleCommandPrefix,
} from '../../../tools/shell/bashPermissions.js'
import { getDestructiveCommandWarning } from '../../rules/shell-commands/destructiveCommandWarning.js'
import { parseSedEditCommand } from '../../../tools/shell/sedEditParser.js'
import { getCompoundCommandPrefixesStatic } from '../../../platform/shell/bash/prefix.js'
import { shouldShowAlwaysAllowOptions } from '../../rules/permissionsLoader.js'
import { expandPath, toTildePath } from '../../../platform/files/path.js'
import { getFocusedWorkspaceCwd, getFocusedWorkspaceOriginalCwd, useFocusedWorkspaceCwd, useFocusedWorkspaceOriginalCwd } from '../../../screen/focused-session/useFocusedWorkspaceCwd.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import type { PermissionUpdate } from '../../rules/permissions.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js'
import {
  PermissionExplainerContent,
  usePermissionExplainerUI,
} from '../PermissionExplanation.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { SedEditPermissionRequest } from '../sed-edit/SedEditPermissionRequest.js'
import { usePermissionRequestLogging } from '../cardArrival.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { shellAskOptions, type ShellAskOption } from './shellAskOptions.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

type BashCardInput = { command: string; cwd?: string }
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

function seedEditablePrefix(
  command: string,
  suggestions: PermissionUpdate[],
  decisionReasonType: string | undefined,
): { prefix: string | undefined; hadWildcard: boolean } {
  let raw: string | undefined
  if (decisionReasonType === 'subcommandResults') {
    const contents = suggestedBashRuleContents(suggestions)
    raw = contents.length === 1 ? contents[0] : undefined
  } else {
    const simple = getSimpleCommandPrefix(command)
    if (simple !== null) {
      raw = `${simple} *`
    } else {
      const firstWord = getFirstWordPrefix(command)
      if (firstWord !== null) {
        raw = `${firstWord} *`
      } else if (!command.includes('*')) {
        raw = command
      }
    }
  }
  if (raw === undefined) return { prefix: undefined, hadWildcard: false }
  if (raw.endsWith(' *')) {
    return { prefix: raw.slice(0, -2), hadWildcard: true }
  }
  return { prefix: raw, hadWildcard: false }
}

export function BashPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm } = props
  const input = BashTool.inputSchema.parse(toolUseConfirm.input) as BashCardInput

  const sedEditInfo = parseSedEditCommand(input.command)
  if (sedEditInfo !== null) {
    const shellCwd = toolUseConfirm.cwd ?? (input.cwd === undefined ? getFocusedWorkspaceCwd() : resolve(getFocusedWorkspaceOriginalCwd(), input.cwd))
    const resolved = { ...sedEditInfo, filePath: expandPath(sedEditInfo.filePath, shellCwd) }
    return <SedEditPermissionRequest {...props} sedEditInfo={resolved} />
  }
  return <ShellPermissionRequest {...props} command={input.command} cwd={input.cwd} />
}

export function MonitorPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { command, description } = props.toolUseConfirm.input as { command?: unknown; description?: unknown }
  return (
    <ShellPermissionRequest
      {...props}
      command={typeof command === 'string' ? command : ''}
      title="Monitor command"
      summary={typeof description === 'string' ? description : ''}
    />
  )
}

function ShellPermissionRequest(
  props: PermissionRequestProps & { command: string; cwd?: string; title?: string; summary?: string },
): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, command, cwd, title, summary } = props

  usePermissionRequestLogging(toolUseConfirm)
  const feedback = useShellPermissionFeedback({ toolUseConfirm, onDone, onReject })
  const [showDebug, setShowDebug] = useState(false)

  useKeybinding('permission:toggleDebug', () => setShowDebug(prev => !prev), {
    context: 'Confirmation',
  })

  const messages: Message[] | undefined = toolUseContext?.messages
  const explainer = usePermissionExplainerUI({
    toolName: toolUseConfirm.tool.name,
    toolInput: toolUseConfirm.input,
    toolDescription: toolUseConfirm.description,
    messages,
  })

  const destructiveWarning = useMemo(() => getDestructiveCommandWarning(command), [command])

  const decisionReason = toolUseConfirm.permissionResult.decisionReason
  const suggestions = useMemo(
    () =>
      shouldShowAlwaysAllowOptions() && toolUseConfirm.permissionResult.behavior === 'ask'
        ? (toolUseConfirm.permissionResult.suggestions ?? [])
        : [],
    [toolUseConfirm.permissionResult],
  )

  const initialSeed = useMemo(
    () => seedEditablePrefix(command, suggestions, decisionReason?.type),
    [command, suggestions, decisionReason?.type],
  )
  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(initialSeed.prefix)
  const hadWildcardRef = useRef(initialSeed.hadWildcard)
  const userEditedRef = useRef(false)

  const handleEditablePrefixChange = useMemo(
    () => (next: string) => {
      userEditedRef.current = true
      setEditablePrefix(next)
    },
    [],
  )

  useLoad(signal => {
    if (decisionReason?.type === 'subcommandResults') return
    const isReadOnly = (subcommand: string): boolean => {
      const parsed = BashTool.inputSchema.safeParse({ command: subcommand })
      return parsed.success ? BashTool.isReadOnly(parsed.data) : false
    }
    getCompoundCommandPrefixesStatic(command, isReadOnly)
      .then(prefixes => {
        if (signal.aborted || userEditedRef.current) return
        if (prefixes.length === 1) {
          const first = prefixes[0]
          if (first) {
            hadWildcardRef.current = true
            setEditablePrefix(first.endsWith(' *') ? first.slice(0, -2) : first)
          }
        }
      })
      .catch(passedOver)
  }, [command, decisionReason?.type])

  const options = useMemo(
    () =>
      shellAskOptions({
        suggestions,
        decisionReason,
        onRejectFeedbackChange: feedback.setRejectFeedback,
        onAcceptFeedbackChange: feedback.setAcceptFeedback,
        yesInputMode: feedback.yesInputMode,
        noInputMode: feedback.noInputMode,
        editablePrefix,
        onEditablePrefixChange: handleEditablePrefixChange,
      }),
    [
      suggestions,
      decisionReason,
      feedback.setRejectFeedback,
      feedback.setAcceptFeedback,
      feedback.yesInputMode,
      feedback.noInputMode,
      editablePrefix,
      handleEditablePrefixChange,
    ],
  )

  function handleSelect(value: ShellAskOption): void {
    switch (value) {
      case 'yes': {
        const trimmedFeedback = feedback.acceptFeedback.trim() || undefined
        toolUseConfirm.onAllow(toolUseConfirm.input, [], trimmedFeedback)
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
        } else {
          const ruleContent = hadWildcardRef.current && !trimmed.includes('*') ? `${trimmed} *` : trimmed
          const updates: PermissionUpdate[] = [
            {
              type: 'addRules',
              rules: [{ toolName: BASH_TOOL_NAME, ruleContent }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ]
          toolUseConfirm.onAllow(toolUseConfirm.input, updates)
        }
        onDone()
        return
      }
      case 'no': {
        feedback.handleReject(feedback.rejectFeedback)
        return
      }
    }
  }

  const focusedCwd = useFocusedWorkspaceCwd()
  const focusedOriginalCwd = useFocusedWorkspaceOriginalCwd()
  const runFolder = toolUseConfirm.cwd ?? (cwd === undefined ? focusedCwd : resolve(focusedOriginalCwd, cwd))
  const descriptionText = summary ?? toolUseConfirm.description
  const inputCommand = toolUseConfirm.input.command
  const showTabAmend =
    (feedback.focusedOption === 'yes' && !feedback.yesInputMode) ||
    (feedback.focusedOption === 'no' && !feedback.noInputMode)
  const { columns, rows } = useTerminalSize()
  const width = consentContentWidth(columns)
  const preview = typeof inputCommand === 'string' ? boundLines(inputCommand.split('\n'), width, consentBodyBudget(rows)) : null
  const rowsBesideTheReason =
    (preview === null ? 1 : drawnRows(preview.lines.join('\n'), width) + (preview.hiddenLines > 0 ? 1 : 0)) +
    (explainer.visible || summary === '' ? 0 : drawnRows(descriptionText, width)) +
    drawnRows(`in ${toTildePath(runFolder)}`, width) +
    (toolUseConfirm.crewmate ? 1 : 0) +
    (destructiveWarning ? drawnRows(destructiveWarning, width) : 0) +
    options.length
  const cutReason = reasonCutToFit(decisionReason, width, rows - ROWS_ROUND_THE_CARD_TEXT - rowsBesideTheReason)

  return (
    <Box flexDirection="column">
      <PermissionDialog title={title ?? 'Bash command'}>
        <Box flexDirection="column">
          <Box flexDirection="column">
            {typeof inputCommand === 'string' ? (
              <ConsentBodyText
                text={inputCommand}
                tail=" (the whole command runs)"
                dimColor={explainer.visible}
              />
            ) : (
              <Text dimColor={explainer.visible}>
                {toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input, {
                  theme: resolveThemeName(),
                  verbose: true,
                })}
              </Text>
            )}
            {explainer.visible || summary === '' ? null : <Text dimColor>{descriptionText}</Text>}
            <Text dimColor>in {toTildePath(runFolder)}</Text>
            {toolUseConfirm.crewmate ? (
              <Text dimColor wrap="truncate-end">
                {toolUseConfirm.crewmate}
              </Text>
            ) : null}
          </Box>
          <PermissionExplainerContent
            visible={explainer.visible}
            promise={explainer.promise}
            fallback={<Text dimColor>{descriptionText}</Text>}
          />
          {showDebug ? (
            <PermissionDecisionDebugInfo
              permissionResult={toolUseConfirm.permissionResult}
              toolName="Bash"
            />
          ) : (
            <>
              {destructiveWarning ? <Text color="warning">{destructiveWarning}</Text> : null}
              <PermissionRuleExplanation
                permissionResult={cutReason === null ? toolUseConfirm.permissionResult : { ...toolUseConfirm.permissionResult, decisionReason: cutReason }}
              />
              <Text bold>Do you want to proceed?</Text>
              <Select
                scrollMovesFocus={false}
                options={options}
                onChange={handleSelect}
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
          esc cancel
          {showTabAmend ? ' · tab amend' : ''}
          {explainer.enabled ? ` · ctrl+e ${explainer.visible ? 'hide' : 'explain'}` : ''}
        </Text>
        {toolUseContext?.options?.debug ? <Text color="subtle">ctrl+d debug</Text> : null}
      </Box>
    </Box>
  )
}
