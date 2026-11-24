import * as React from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import { Select } from '../../../screen/select/Select.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { WebFetchTool } from '../../../tools/web-fetch/WebFetchTool.js'
import { shouldShowAlwaysAllowOptions } from '../../rules/permissionsLoader.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../cardArrival.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type FetchOptionValue = 'yes' | 'yes-dont-ask-domain' | 'no'

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

export function WebFetchPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
}: PermissionRequestProps): React.ReactNode {
  usePermissionRequestLogging(toolUseConfirm)

  const parsedInput = WebFetchTool.inputSchema.safeParse(toolUseConfirm.input)
  const rawUrl = parsedInput.success ? parsedInput.data.url : undefined
  const hostname =
    rawUrl !== undefined && rawUrl !== '' ? (URL.parse(rawUrl)?.hostname ?? '') : ''

  const options: Array<{ label: React.ReactNode; value: FetchOptionValue }> = [
    { label: 'Yes', value: 'yes' },
  ]
  if (hostname !== '' && shouldShowAlwaysAllowOptions()) {
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

  const handleSelect = (value: FetchOptionValue): void => {
    toolUseConfirm.onUserInteraction()
    switch (value) {
      case 'yes':
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        return
      case 'yes-dont-ask-domain':
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
        return
      case 'no':
        toolUseConfirm.onReject()
        onReject()
        onDone()
        return
    }
  }

  const useMessage = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input, {
    theme: resolveThemeName(),
    verbose,
  })

  return (
    <PermissionDialog
      title="Fetch"
      crewmate={toolUseConfirm.crewmate}
    >
      <Box flexDirection="column">
        {typeof useMessage === 'string' ? (
          <ConsentBodyText text={useMessage} />
        ) : (
          useMessage
        )}
        {toolUseConfirm.description ? <Text dimColor>{toolUseConfirm.description}</Text> : null}
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
        <Text bold>Do you want to allow Mercury to fetch this content?</Text>
        <Select
          scrollMovesFocus={false}
          options={options}
          onChange={handleSelect}
          onCancel={() => handleSelect('no')}
        />
      </Box>
    </PermissionDialog>
  )
}
