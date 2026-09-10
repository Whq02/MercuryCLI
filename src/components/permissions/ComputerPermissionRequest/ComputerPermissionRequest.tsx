import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { peekCheckedActApp, type DesktopJudgedApp } from '../../../services/desktop/desktopSession.js'
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getSystemThemeName } from '../../../utils/systemTheme.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

type ComputerOptionValue = 'yes' | 'yes-dont-ask-app' | 'no'

export const COMPUTER_ASK_FIRST_ACT = 'first act in this application this session'
export const COMPUTER_ASK_QUESTION = 'Do you want to allow Mercury to drive your mouse and keyboard here?'

export function computerAskAppLine(app: DesktopJudgedApp | null): string {
  const where = app === null ? 'the application in front' : `${app.name} (${app.identity})`
  return `in ${where} — ${COMPUTER_ASK_FIRST_ACT}`
}

export function computerAppRuleContent(app: DesktopJudgedApp | null): string | null {
  return app === null ? null : `app:${app.identity}`
}

type AskSuggestion = { type?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }

export function judgedAppFromAsk(message: string, suggestions: ReadonlyArray<AskSuggestion> | undefined): DesktopJudgedApp | null {
  let identity: string | null = null
  for (const suggestion of suggestions ?? []) {
    for (const rule of suggestion.rules ?? []) {
      if (typeof rule.ruleContent === 'string' && rule.ruleContent.startsWith('app:')) identity = rule.ruleContent.slice('app:'.length)
    }
  }
  const spelled = / in (.+?) \((\S+)\) — /.exec(message)
  if (spelled !== null) return { identity: identity ?? spelled[2]!, name: spelled[1]! }
  return identity === null ? null : { identity, name: identity }
}

export function ComputerPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const judged = useMemo(
    () =>
      peekCheckedActApp(ownerFromToolUseContext(toolUseConfirm.toolUseContext))?.app ??
      judgedAppFromAsk(toolUseConfirm.permissionResult.message ?? '', (toolUseConfirm.permissionResult as { suggestions?: AskSuggestion[] }).suggestions),
    [toolUseConfirm.toolUseContext, toolUseConfirm.permissionResult],
  )
  const ruleContent = computerAppRuleContent(judged)

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const options: { label: React.ReactNode; value: ComputerOptionValue }[] = [{ label: 'Yes', value: 'yes' }]
  if (ruleContent !== null && judged !== null && shouldShowAlwaysAllowOptions()) {
    options.push({
      label: (
        <Text>
          Yes, and don&apos;t ask again for <Text bold>{judged.name}</Text> in this project
        </Text>
      ),
      value: 'yes-dont-ask-app',
    })
  }
  options.push({
    label: 'No, and tell Mercury what to do differently (esc)',
    value: 'no',
  })

  function handleChange(value: ComputerOptionValue): void {
    switch (value) {
      case 'yes':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        break
      case 'yes-dont-ask-app':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: toolUseConfirm.tool.name, ruleContent: ruleContent! }],
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

  const useMessage = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
    theme: resolveThemeName(),
    verbose,
  })

  return (
    <PermissionDialog title="Computer" workerBadge={workerBadge}>
      <Box flexDirection="column">
        {typeof useMessage === 'string' ? (
          <ConsentBodyText text={useMessage} />
        ) : (
          <Text>{useMessage}</Text>
        )}
        <Text>{computerAskAppLine(judged)}</Text>
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />
        <Text bold>{COMPUTER_ASK_QUESTION}</Text>
        <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
