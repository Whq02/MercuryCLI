import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { resolveThemeName } from './resolveThemeName.js'
import { DEBUG_TOOL_NAME } from '../../constants/tools/debug.js'
import { EVAL_TOOL_NAME } from '../../tools/EvalTool/constants.js'
import type { Tool } from '../../Tool.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { ConsentBodyText } from './ConsentBodyText.js'
import { PermissionDialog } from './PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from './PermissionPrompt.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from './hooks.js'
import type { PermissionRequestProps } from './PermissionRequest.js'

const MCP_SUFFIX = ' (MCP)'
const RUNS_PROJECT_PROGRAMS: ReadonlySet<string> = new Set([DEBUG_TOOL_NAME, EVAL_TOOL_NAME, 'Launch', 'Test'])

function sentOrStarted(tool: Tool, input: Record<string, unknown>, shown: string): string[] {
  const sent = tool.name === 'Service' && input.op === 'input' && typeof input.text === 'string' ? input.text : undefined
  const lines = (sent ?? tool.shellCommandOf?.(input) ?? '').split('\n')
  if (tool.name === 'Service' && input.op === 'start') {
    for (const [name, value] of Object.entries((input.env ?? {}) as Record<string, unknown>)) lines.push(`${name}=${String(value)}`)
    if (typeof input.cwd === 'string') lines.push(`in ${input.cwd}`)
  }
  if (tool.name === 'Journey' && Array.isArray(input.steps)) {
    for (const step of input.steps as Array<{ kind?: unknown; cwd?: unknown }>) if (step?.kind === 'command.run' && typeof step.cwd === 'string') lines.push(`in ${step.cwd}`)
  }
  return [...new Set(lines)].filter(line => line.trim() !== '' && !shown.includes(line))
}

type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function FallbackPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
  title,
  body,
  screen,
}: PermissionRequestProps & {
  title?: string
  body?: React.ReactNode
  screen?: 'MediaPermissionRequest'
}): React.ReactNode {
  usePermissionRequestLogging(toolUseConfirm, screen)

  const rawName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input) || toolUseConfirm.tool.name
  const isMcp = rawName.endsWith(MCP_SUFFIX)
  const displayName = isMcp ? rawName.slice(0, -MCP_SUFFIX.length) : rawName

  const runsCode =
    toolUseConfirm.tool.shellCommandOf !== undefined ||
    RUNS_PROJECT_PROGRAMS.has(toolUseConfirm.tool.name)
  const showAlwaysAllow = !runsCode && shouldShowAlwaysAllowOptions()

  const options = useMemo<PermissionPromptOption<FallbackOptionValue>[]>(() => {
    const list: PermissionPromptOption<FallbackOptionValue>[] = [
      {
        value: 'yes',
        label: 'Yes',
        feedbackConfig: { type: 'accept' },
      },
    ]
    if (showAlwaysAllow) {
      list.push({
        value: 'yes-dont-ask-again',
        label: (
          <Text>
            Yes, and don't ask again for <Text bold>{displayName}</Text> in this project
          </Text>
        ),
      })
    }
    list.push({
      value: 'no',
      label: 'No, and tell Mercury what to do differently (esc)',
      feedbackConfig: { type: 'reject' },
    })
    return list
  }, [showAlwaysAllow, displayName])

  function handleSelect(value: FallbackOptionValue, feedback?: string): void {
    switch (value) {
      case 'yes':
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        return
      case 'yes-dont-ask-again':
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: toolUseConfirm.tool.name }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        return
      case 'no':
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        return
    }
  }

  function handleCancel(): void {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }

  let bodyNode: React.ReactNode = null
  if (body !== undefined) {
    bodyNode = body === null ? null : (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {body}
      </Box>
    )
  } else {
    const useMessage = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input, {
      theme: resolveThemeName(),
      verbose,
    })
    const isStringMessage =
      typeof useMessage === 'string' || useMessage === null || useMessage === undefined
    const shown = isStringMessage ? `${displayName}(${useMessage ?? ''})` : ''
    const startedLines = sentOrStarted(toolUseConfirm.tool, toolUseConfirm.input, shown)
    bodyNode = (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {isStringMessage ? (
          <ConsentBodyText
            text={shown}
            after={isMcp ? <Text dimColor>{MCP_SUFFIX}</Text> : undefined}
          />
        ) : (
          <Box flexDirection="column">
            <Text>
              {displayName}
              {isMcp ? <Text dimColor>{MCP_SUFFIX}</Text> : null}
            </Text>
            {useMessage}
          </Box>
        )}
        {startedLines.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {startedLines.map((line, index) => (
              <Text key={index} dimColor>{line}</Text>
            ))}
          </Box>
        ) : null}
        {toolUseConfirm.description ? (
          <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
        ) : null}
      </Box>
    )
  }

  return (
    <PermissionDialog
      title={title ?? 'Tool use'}
      crewmate={toolUseConfirm.crewmate}
      workerBadge={workerBadge}
    >
      {bodyNode}
      <Box flexDirection="column">
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      </Box>
    </PermissionDialog>
  )
}
