import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getSystemThemeName } from '../../utils/systemTheme.js'
import { env } from '../../utils/env.js'
import { logUnaryEvent } from '../../utils/unaryLogging.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { PermissionDialog } from './PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from './PermissionPrompt.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from './hooks.js'
import type { PermissionRequestProps } from './PermissionRequest.js'

/** The concrete theme name for tool-use rendering ('auto' resolved). */
function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

/** The exact suffix the MCP tool wrapper appends to user-facing names. */
const MCP_SUFFIX = ' (MCP)'

type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

/**
 * Generic consent card for any tool without a bespoke one. The arguments are
 * rendered in VERBOSE mode unconditionally — the card ignores its own
 * `verbose` prop — and the full description is truncated to three lines.
 */
export function FallbackPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const tool = toolUseConfirm.tool

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const rawName = tool.userFacingName(toolUseConfirm.input as never) ?? ''
  const isMcpNamed = rawName.endsWith(MCP_SUFFIX)
  const displayName = isMcpNamed ? rawName.slice(0, -MCP_SUFFIX.length) : rawName

  // This card's decision emitter is DIRECT: language none, the raw process
  // platform, and no had-feedback field at all.
  function logDecision(event: 'accept' | 'reject'): void {
    void logUnaryEvent({
      event,
      completion_type: 'tool_use_single',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
  }

  const options = useMemo<PermissionPromptOption<FallbackOptionValue>[]>(() => {
    const result: PermissionPromptOption<FallbackOptionValue>[] = [
      { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (shouldShowAlwaysAllowOptions()) {
      result.push({
        label: (
          // The label states exactly what the rule below persists: the whole
          // tool, in this project's local settings — never a narrower claim
          // (the old cwd wording promised directory scoping the grant does
          // not have).
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
  }, [displayName])

  function handleSelect(value: FallbackOptionValue, feedback?: string): void {
    switch (value) {
      case 'yes':
        logDecision('accept')
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      case 'yes-dont-ask-again':
        logDecision('accept')
        // The whole tool: an allow-rule naming the tool with NO rule content.
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
        logDecision('reject')
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        break
    }
  }

  return (
    <PermissionDialog title="Tool use" workerBadge={workerBadge}>
      <Box flexDirection="column">
        <Text>
          {displayName}(
          {tool.renderToolUseMessage(toolUseConfirm.input as never, {
            theme: resolveThemeName(),
            verbose: true,
          })})
          {isMcpNamed ? <Text dimColor>{MCP_SUFFIX}</Text> : null}
        </Text>
        <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
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
