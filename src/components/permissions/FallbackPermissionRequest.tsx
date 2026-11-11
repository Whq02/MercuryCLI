import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { resolveThemeName } from './resolveThemeName.js'
import { DEBUG_TOOL_NAME } from '../../tools/DebugTool/prompt.js'
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
  const lines = (tool.shellCommandOf?.(input) ?? '').split('\n')
  if (tool.name === 'Service' && input.op === 'input' && typeof input.text === 'string') lines.push(...input.text.split('\n'))
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
  workerBadge,
  title = 'Tool use',
  body,
}: PermissionRequestProps & { title?: string; body?: React.ReactNode }): React.ReactNode {
  const tool = toolUseConfirm.tool

  usePermissionRequestLogging(toolUseConfirm)

  const rawName = tool.userFacingName(toolUseConfirm.input as never) ?? ''
  const isMcpNamed = rawName.endsWith(MCP_SUFFIX)
  const displayName = isMcpNamed ? rawName.slice(0, -MCP_SUFFIX.length) : rawName
  const runsCode = tool.shellCommandOf !== undefined || RUNS_PROJECT_PROGRAMS.has(tool.name)

  const options = useMemo<PermissionPromptOption<FallbackOptionValue>[]>(() => {
    const result: PermissionPromptOption<FallbackOptionValue>[] = [
      { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (shouldShowAlwaysAllowOptions() && !runsCode) {
      result.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{displayName}</Text> in this project
          </Text>
        ),
        value: 'yes-dont-ask-again',
      })
    }
    result.push({
      label: 'No, and tell Mercury what to do differently (esc)',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })
    return result
  }, [displayName, runsCode])

  function handleSelect(value: FallbackOptionValue, feedback?: string): void {
    switch (value) {
      case 'yes':
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      case 'yes-dont-ask-again':
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: tool.name }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        break
      case 'no':
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        break
    }
  }

  const useMessage = tool.renderToolUseMessage(toolUseConfirm.input as never, {
    theme: resolveThemeName(),
    verbose: true,
  })
  const suffix = isMcpNamed ? <Text dimColor>{MCP_SUFFIX}</Text> : null
  const shown = typeof useMessage === 'string' ? useMessage : ''
  const startedCommands = sentOrStarted(tool, toolUseConfirm.input, shown)

  return (
    <PermissionDialog title={title} workerBadge={workerBadge}>
      <Box flexDirection="column">
        {body !== undefined ? (
          body
        ) : typeof useMessage === 'string' ? (
          <ConsentBodyText text={`${displayName}(${useMessage})`} after={suffix} />
        ) : (
          <Text>
            {displayName}({useMessage}){suffix}
          </Text>
        )}
        {body !== undefined || startedCommands.length === 0 ? null : <ConsentBodyText text={startedCommands.join('\n')} />}
        {body !== undefined ? null : <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>}
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect('no')}
        />
      </Box>
    </PermissionDialog>
  )
}
