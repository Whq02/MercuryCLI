import { resolve } from 'node:path'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../../../hooks/effects.js'
import { Box, Text } from '../../../ink.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import {
  getFirstWordPrefix,
  getSimpleCommandPrefix,
} from '../../../tools/BashTool/bashPermissions.js'
import { getDestructiveCommandWarning } from '../../../utils/shell/destructiveCommandWarning.js'
import { parseSedEditCommand } from '../../../tools/BashTool/sedEditParser.js'
import { getCompoundCommandPrefixesStatic } from '../../../utils/bash/prefix.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { expandPath, toTildePath } from '../../../utils/path.js'
import { getFocusedWorkspaceCwd, getFocusedWorkspaceOriginalCwd, useFocusedWorkspaceCwd, useFocusedWorkspaceOriginalCwd } from '../../../hooks/useFocusedWorkspaceCwd.js'
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
import { usePermissionRequestLogging } from '../hooks.js'
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { bashToolUseOptions, type BashToolUseOption } from './bashToolUseOptions.js'
import { passedOver } from '../../../utils/passedOver.js'

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
  return <BashCommandPermissionRequest {...props} command={input.command} cwd={input.cwd} />
}

export function MonitorPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { command, description } = props.toolUseConfirm.input as { command?: unknown; description?: unknown }
  return (
    <BashCommandPermissionRequest
      {...props}
      command={typeof command === 'string' ? command : ''}
      title="Monitor command"
      summary={typeof description === 'string' ? description : ''}
    />
  )
}

function BashCommandPermissionRequest(
  props: PermissionRequestProps & { command: string; cwd?: string; title?: string; summary?: string },
): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, workerBadge, command, cwd, title, summary } = props

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
      bashToolUseOptions({
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

  function handleSelect(value: BashToolUseOption): void {
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

  return (
    <Box flexDirection="column">
      <PermissionDialog title={title ?? 'Bash command'} workerBadge={workerBadge}>
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
              <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
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
