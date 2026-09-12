import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { COMPUTER_TOOL_NAME, peekCheckedActApp, type DesktopJudgedApp } from '../../../services/desktop/desktopSession.js'
import { timedComputerGrant, writeComputerGrant, type ComputerGrantRecord } from '../../../services/desktop/computerGrant.js'
import { conversationIdHere } from '../../../services/engine-connector/focusedConnector.js'
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js'
import { writeBootEnvChoice } from '../../../substrate/startupMenu.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import { isBypassPermissionsModeDisabled } from '../../../utils/permissions/permissionSetup.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
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

export type ComputerAskChoice = 'yes' | 'no' | 'hour' | 'day' | 'sovereign'

export const COMPUTER_ASK_CHOICES: ReadonlyArray<{ value: ComputerAskChoice; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No, and tell Mercury what to do differently (esc)' },
  { value: 'hour', label: 'Yes, for 1 hour — every application' },
  { value: 'day', label: 'Yes, for 24 hours — every application' },
  { value: 'sovereign', label: 'Enable sovereign mode to avoid further permissions by default' },
]

export const COMPUTER_ASK_FIRST_ACT = 'first act in this application this session'
export const COMPUTER_ASK_QUESTION = 'Do you want to allow Mercury to drive your mouse and keyboard here, and for how long?'
export const COMPUTER_ASK_NOTE = 'A timed grant covers every application and asks again when it runs out; sovereign mode is saved in the Boot Menu and no permission is asked after it, computer use included.'

export function computerAskAppLine(app: DesktopJudgedApp | null): string {
  const where = app === null ? 'the application in front' : `${app.name} (${app.identity})`
  return `in ${where} — ${COMPUTER_ASK_FIRST_ACT}`
}

type AskSuggestion = { type?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }

export function judgedAppFromAsk(message: string, suggestions: ReadonlyArray<AskSuggestion> | undefined, reason = ''): DesktopJudgedApp | null {
  let identity: string | null = null
  for (const suggestion of suggestions ?? []) {
    for (const rule of suggestion.rules ?? []) {
      if (rule.toolName === COMPUTER_TOOL_NAME && typeof rule.ruleContent === 'string' && rule.ruleContent.startsWith('app:') && rule.ruleContent.length > 'app:'.length) identity = rule.ruleContent.slice('app:'.length)
    }
  }
  const spelled = /^(.+?) \((\S+)\) is in front of the operator's screen;/.exec(reason) ?? / in (.+?) \((\S+)\) — /.exec(message)
  if (spelled !== null && (identity === null || identity === spelled[2])) return { identity: spelled[2]!, name: spelled[1]! }
  return identity === null ? null : { identity, name: identity }
}

export interface ComputerAskEffect {
  allow: boolean
  grant: ComputerGrantRecord | null
  saved: 'sovereign' | null
  savedError: string | null
  permissionUpdates: PermissionUpdate[]
}

const NO_UPDATES: PermissionUpdate[] = []

export const SOVEREIGN_MODE_DISABLED = 'Sovereign Mode is disabled by settings or organisation policy.'

export function applyComputerAskChoice(choice: ComputerAskChoice, sessionId: string, now: number = Date.now()): ComputerAskEffect {
  switch (choice) {
    case 'yes':
      return { allow: true, grant: null, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
    case 'no':
      return { allow: false, grant: null, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
    case 'hour':
    case 'day': {
      const grant = timedComputerGrant(choice === 'hour' ? 1 : 24, now)
      writeComputerGrant(sessionId, grant)
      return { allow: true, grant, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
    }
    case 'sovereign': {
      if (isBypassPermissionsModeDisabled()) {
        logForDebugging(`computer ask: sovereign mode was not turned on — ${SOVEREIGN_MODE_DISABLED}`)
        return { allow: true, grant: null, saved: null, savedError: SOVEREIGN_MODE_DISABLED, permissionUpdates: NO_UPDATES }
      }
      const written = writeBootEnvChoice('MERCURY_SKIP_PERMISSIONS', '1')
      if (!written.ok) logForDebugging(`computer ask: sovereign mode was not saved in the Boot Menu — ${written.reason}`)
      return {
        allow: true,
        grant: null,
        saved: written.ok ? 'sovereign' : null,
        savedError: written.ok ? null : written.reason,
        permissionUpdates: [{ type: 'setMode', mode: 'sovereign', destination: 'session' }],
      }
    }
  }
}

export function ComputerPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const judged = useMemo(() => {
    const carried = peekCheckedActApp(ownerFromToolUseContext(toolUseConfirm.toolUseContext))?.app ?? null
    if (carried !== null) return carried
    const ask = toolUseConfirm.permissionResult as { message?: string; suggestions?: AskSuggestion[]; decisionReason?: { message?: string; reason?: string } }
    return judgedAppFromAsk(ask.message ?? '', ask.suggestions, ask.decisionReason?.message ?? ask.decisionReason?.reason)
  }, [toolUseConfirm.toolUseContext, toolUseConfirm.permissionResult])

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const options = COMPUTER_ASK_CHOICES.map(choice => ({ label: choice.label, value: choice.value }))

  function handleChange(value: ComputerAskChoice): void {
    const effect = applyComputerAskChoice(value, conversationIdHere())
    if (!effect.allow) {
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject', false)
      toolUseConfirm.onReject()
      onReject()
      onDone()
      return
    }
    logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept', false)
    toolUseConfirm.onAllow(toolUseConfirm.input, effect.permissionUpdates)
    onDone()
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
        <Text dimColor>{COMPUTER_ASK_NOTE}</Text>
        <Text bold>{COMPUTER_ASK_QUESTION}</Text>
        <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
