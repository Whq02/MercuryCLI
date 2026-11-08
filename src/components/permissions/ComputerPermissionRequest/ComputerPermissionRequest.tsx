import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { COMPUTER_TOOL_NAME, peekCheckedActApp, type DesktopJudgedApp } from '../../../services/desktop/desktopSession.js'
import { sessionComputerGrant, timedComputerGrant, writeComputerGrant, type ComputerGrantRecord } from '../../../services/desktop/computerGrant.js'
import { CAPTCHA_OPERATOR_COMPLETES } from '../../../tools/ComputerTool/captcha.js'
import { conversationIdHere } from '../../../services/engine-connector/focusedConnector.js'
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js'
import { useAppState } from '../../../state/AppState.js'
import { writeBootEnvChoice } from '../../../substrate/startupMenu.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import { postureBypassesAsks } from '../../../utils/permissions/decision/engine.js'
import { isSovereignDisabled } from '../../../utils/permissions/permissionSetup.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { logForDebugging } from '../../../utils/debug.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type ComputerAskChoice = 'yes' | 'no' | 'hour' | 'day' | 'sovereign'

export const COMPUTER_ASK_CHOICES: ReadonlyArray<{ value: ComputerAskChoice; label: string }> = [
  { value: 'yes', label: 'Yes, for this session — every application' },
  { value: 'no', label: 'No, and tell Mercury what to do differently (esc)' },
  { value: 'hour', label: 'Yes, for 1 hour — every application' },
  { value: 'day', label: 'Yes, for 24 hours — every application' },
  { value: 'sovereign', label: 'Enable sovereign mode to avoid further permissions by default' },
]

export function computerAskChoicesFor(sovereignOn: boolean): ReadonlyArray<{ value: ComputerAskChoice; label: string }> {
  return sovereignOn ? COMPUTER_ASK_CHOICES.filter(choice => choice.value !== 'sovereign') : COMPUTER_ASK_CHOICES
}

export const COMPUTER_CHALLENGE_CHOICES: ReadonlyArray<{ value: ComputerAskChoice; label: string }> = [
  { value: 'yes', label: 'Yes — let Mercury try it in this window until the challenge is gone, at most an hour' },
  { value: 'no', label: 'No — I will complete it myself; Mercury waits and re-issues (esc)' },
]

export const COMPUTER_CLIPBOARD_CHOICES: ReadonlyArray<{ value: ComputerAskChoice; label: string }> = [
  { value: 'yes', label: 'Yes' },
  COMPUTER_ASK_CHOICES[1]!,
  COMPUTER_ASK_CHOICES[4]!,
]

export function computerClipboardChoicesFor(sovereignOn: boolean): ReadonlyArray<{ value: ComputerAskChoice; label: string }> {
  return sovereignOn ? COMPUTER_CLIPBOARD_CHOICES.filter(choice => choice.value !== 'sovereign') : COMPUTER_CLIPBOARD_CHOICES
}

const COMPUTER_ASK_FIRST_ACT = 'the first act this session'
const COMPUTER_ASK_QUESTION = 'Do you want to allow Mercury to drive your mouse and keyboard, and for how long?'
export const COMPUTER_CHALLENGE_QUESTION = 'A human-verification challenge is on screen. Complete it yourself and Mercury carries on, or let Mercury try it?'
export const COMPUTER_ASK_NOTE = 'A timed grant covers every application and asks again when it runs out; sovereign mode is saved in the Boot Menu and no permission is asked after it, computer use included.'
export const COMPUTER_CHALLENGE_NOTE = 'A Computer(captcha) allow rule in your settings answers yes without asking; a deny rule answers no.'

export function computerAskAppLine(app: DesktopJudgedApp | null): string {
  const where = app === null ? 'the application in front' : `${app.name} (${app.identity})`
  return `in ${where} — ${COMPUTER_ASK_FIRST_ACT}`
}

export function computerChallengeAppLine(app: DesktopJudgedApp | null): string {
  const where = app === null ? 'the application in front' : `${app.name} (${app.identity})`
  return `${where} shows a human-verification challenge`
}

type AskSuggestion = { type?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }

export function challengeAsk(suggestions: ReadonlyArray<AskSuggestion> | undefined): boolean {
  return (suggestions ?? []).some(suggestion => (suggestion.rules ?? []).some(rule => rule.toolName === COMPUTER_TOOL_NAME && rule.ruleContent === 'captcha'))
}

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

interface ComputerAskEffect {
  allow: boolean
  grant: ComputerGrantRecord | null
  saved: 'sovereign' | null
  savedError: string | null
  permissionUpdates: PermissionUpdate[]
}

const NO_UPDATES: PermissionUpdate[] = []

const SOVEREIGN_MODE_DISABLED = 'Sovereign Mode is disabled by settings or organisation policy.'

export function applyComputerAskChoice(choice: ComputerAskChoice, sessionId: string, now: number = Date.now(), once = false): ComputerAskEffect {
  switch (choice) {
    case 'yes': {
      if (once) return { allow: true, grant: null, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
      const grant = sessionComputerGrant(now)
      writeComputerGrant(sessionId, grant)
      return { allow: true, grant, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
    }
    case 'no':
      return { allow: false, grant: null, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
    case 'hour':
    case 'day': {
      const grant = timedComputerGrant(choice === 'hour' ? 1 : 24, now)
      writeComputerGrant(sessionId, grant)
      return { allow: true, grant, saved: null, savedError: null, permissionUpdates: NO_UPDATES }
    }
    case 'sovereign': {
      if (isSovereignDisabled()) {
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

  usePermissionRequestLogging(toolUseConfirm)

  const input = toolUseConfirm.input as { action?: string; clipboard?: boolean }
  const clipboard = input.action === 'read' && input.clipboard === true
  const challenge = challengeAsk((toolUseConfirm.permissionResult as { suggestions?: AskSuggestion[] }).suggestions)
  const mode = useAppState(state => state.toolPermissionContext.mode)
  const bypassAvailable = useAppState(state => state.toolPermissionContext.isBypassPermissionsModeAvailable)
  const sovereignOn = postureBypassesAsks({ mode, isBypassPermissionsModeAvailable: bypassAvailable })
  const options = (challenge ? COMPUTER_CHALLENGE_CHOICES : clipboard ? computerClipboardChoicesFor(sovereignOn) : computerAskChoicesFor(sovereignOn)).map(choice => ({ label: choice.label, value: choice.value }))

  function handleChange(value: ComputerAskChoice): void {
    const effect = applyComputerAskChoice(value, conversationIdHere(), Date.now(), challenge || clipboard)
    if (!effect.allow) {
      if (challenge) toolUseConfirm.onReject(CAPTCHA_OPERATOR_COMPLETES)
      else toolUseConfirm.onReject()
      onReject()
      onDone()
      return
    }
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
        {!clipboard && !challenge && <Text>{computerAskAppLine(judged)}</Text>}
        {!clipboard && !challenge && <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />}
        {!clipboard && !challenge && <Text dimColor>{COMPUTER_ASK_NOTE}</Text>}
        {challenge && <Text>{computerChallengeAppLine(judged)}</Text>}
        {challenge && <Text dimColor>{COMPUTER_CHALLENGE_NOTE}</Text>}
        <Text bold>{clipboard ? 'Allow Mercury to read the clipboard text?' : challenge ? COMPUTER_CHALLENGE_QUESTION : COMPUTER_ASK_QUESTION}</Text>
        <Select options={options} onChange={handleChange} onCancel={() => handleChange('no')} />
      </Box>
    </PermissionDialog>
  )
}
