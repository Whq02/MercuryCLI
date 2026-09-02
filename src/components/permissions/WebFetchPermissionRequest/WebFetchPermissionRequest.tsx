import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getSystemThemeName } from '../../../utils/systemTheme.js'
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

/** The concrete theme name for tool-use rendering ('auto' resolved). */
function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

type FetchOptionValue = 'yes' | 'yes-dont-ask-domain' | 'no'

/**
 * The rule content for the domain allow: `domain:<hostname>` normally; when
 * schema validation fails or URL parsing throws, it degrades to `input:`
 * followed by the DEFAULT string conversion of the input object (the generic
 * object marker, deliberately not a JSON serialisation).
 */
function domainRuleContent(input: unknown): string {
  try {
    const parsed = WebFetchTool.inputSchema.safeParse(input)
    if (!parsed.success) return `input:${String(input)}`
    const { url } = parsed.data as { url: string }
    return `domain:${new URL(url).hostname}`
  } catch {
    return `input:${String(input)}`
  }
}

/**
 * URL fetch consent card. The header hostname derivation is UNGUARDED — an
 * unparseable URL throws before any option is built. This card has no
 * feedback affordance at all.
 */
export function WebFetchPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const hostname = new URL((toolUseConfirm.input as { url: string }).url).hostname

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const options: { label: React.ReactNode; value: FetchOptionValue }[] = [
    { label: 'Yes', value: 'yes' },
  ]
  if (shouldShowAlwaysAllowOptions()) {
    options.push({
      label: (
        <Text>
          Yes, and don&apos;t ask again for <Text bold>{hostname}</Text>
        </Text>
      ),
      value: 'yes-dont-ask-domain',
    })
  }
  options.push({
    label: 'No, and tell Mercury what to do differently (esc)',
    value: 'no',
  })

  function handleChange(value: FetchOptionValue): void {
    switch (value) {
      case 'yes':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        break
      case 'yes-dont-ask-domain':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [
              {
                toolName: toolUseConfirm.tool.name,
                ruleContent: domainRuleContent(toolUseConfirm.input),
              },
            ],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        break
      case 'no':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject', false)
        toolUseConfirm.onReject()
        onReject()
        onDone()
        break
    }
  }

  return (
    <PermissionDialog title="Fetch" workerBadge={workerBadge}>
      <Box flexDirection="column">
        <Text>
          {toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
            theme: resolveThemeName(),
            verbose,
          })}
        </Text>
        <Text dimColor>{toolUseConfirm.description}</Text>
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <Text bold>Do you want to allow Mercury to fetch this content?</Text>
        <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
