import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { ConsoleOAuthFlow, type LoginFamilyFocus } from '../../components/ConsoleOAuthFlow.js'
import { SIGN_IN_WORDS } from '../../components/Onboarding.js'
import { PopupForm } from '../../components/PopupForm.js'
import { usePopupCompact } from '../../context/popupFormContext.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { closeSettingsPopup, openSettingsPopup, type SettingsPopupGeometry } from '../../utils/cockpit/settingsPopup.js'
import { resetCostState } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getOauthAccountInfo, loginShadowWarning } from '../../utils/auth.js'
import { loginSuccessReceipt } from '../../utils/accounts/loginReceipt.js'
import { landingWords, takeLastLanding } from '../../utils/accounts/signInPockets.js'
import { familyDisplayName } from '../../services/providers/accountSlots.js'
import { accountIdentityShown } from '../../services/wallet/identityWords.js'
import { everySignInRoster, forgetSignIn, projectSignInRefusalWords, projectSignInRefusals, roadsWords, signInWords, useDefaultSignIn, useSignIn } from '../../services/providers/signInRoster.js'
import { logError } from '../../utils/log.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableSovereignIfNeeded,
  resetSovereignCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

export function Login({
  onDone,
  onOpenaiDone,
  startingMessage,
  initialFocus,
  geometry,
  scrollRef,
}: {
  geometry: SettingsPopupGeometry
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  onDone: (success: boolean, engineModel: string) => void
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  initialFocus?: LoginFamilyFocus
}): React.ReactNode {
  const engineModel = useAppState(state => state.engineModel)
  const settledRef = useRef(false)
  const accountReceipt = useRef<string | null>(null)
  const [receipt, setReceipt] = useState<{ ok: boolean; receipt: string } | null>(null)
  const settle = (success: boolean): void => {
    if (!success && accountReceipt.current !== null && onOpenaiDone) {
      settleOpenai({ ok: true, receipt: accountReceipt.current })
      return
    }
    if (settledRef.current) return
    settledRef.current = true
    onDone(success, engineModel ?? '')
  }
  const settleOpenai = (result: { ok: boolean; receipt: string }): void => {
    if (settledRef.current) return
    settledRef.current = true
    onOpenaiDone?.(result)
  }
  return (
    <PopupForm width={geometry.inner} rows={geometry.rowBudget} scrollRef={scrollRef}>
      <Box flexDirection="column">
        {receipt ? <LoginReceipt receipt={receipt.receipt} onDone={() => settleOpenai(receipt)} /> : (
          <ConsoleOAuthFlow
            onDone={() => settle(true)}
            onCancel={() => settle(false)}
            onAccountChange={message => { accountReceipt.current = message }}
            {...(onOpenaiDone !== undefined ? { onOpenaiDone: (result: { ok: boolean; receipt: string }) => result.ok ? setReceipt(result) : settleOpenai(result) } : {})}
            {...(startingMessage !== undefined ? { startingMessage } : {})}
            {...(initialFocus !== undefined ? { initialFocus } : {})}
          />
        )}
      </Box>
    </PopupForm>
  )
}

function LoginReceipt({ receipt, onDone }: { receipt: string; onDone: () => void }): React.ReactNode {
  useInput((_input, key) => { if (key.return || key.escape) onDone() })
  const { compact } = usePopupCompact()
  return <Box flexDirection="column" gap={compact ? 0 : 1}><Text>{receipt}</Text><Text dimColor>press Enter to continue</Text></Box>
}

function runPostLoginRefresh(context: LocalJSXCommandContext): void {
  resetCostState()
  resetUserCache()
  resetSovereignCheck()
  void checkAndDisableSovereignIfNeeded(
    context.getAppState().toolPermissionContext,
    context.setAppState,
  ).catch(logError)
  context.setAppState(prev => ({ ...prev, authVersion: (prev.authVersion ?? 0) + 1 }))
}

export function parseFamilyFocus(token: string | undefined): LoginFamilyFocus | undefined {
  switch ((token ?? '').toLowerCase()) {
    case 'anthropic':
    case 'claude':
    case 'claudeai':
      return 'claudeai'
    case 'openai':
    case 'chatgpt':
    case 'gpt':
      return 'openai'
    case 'console':
      return 'console'
    case 'openrouter':
      return 'openrouter'
    case 'gemini':
    case 'google':
      return 'gemini'
    case 'huggingface':
    case 'hf':
      return 'huggingface'
    case 'moonshot':
    case 'kimi':
      return 'moonshot'
    case 'zai':
    case 'z.ai':
    case 'glm':
      return 'zai'
    case 'deepseek':
      return 'deepseek'
    case 'xai':
    case 'x.ai':
    case 'grok':
      return 'xai'
    case 'meta':
    case 'muse':
      return 'meta'
    case 'mistral':
      return 'mistral'
    case 'nous':
    case 'nous-portal':
      return 'nous'
    case 'zen':
    case 'opencode':
      return 'zen'
    default:
      return undefined
  }
}

export function landingLine(): string | undefined {
  const landing = takeLastLanding()
  if (landing === undefined || landing.landed === 'first') return undefined
  return landingWords(landing, familyDisplayName(landing.family), accountIdentityShown())
}

export function withLandingWords(receipt: string): string {
  const line = landingLine()
  return line === undefined ? receipt : `${receipt}\n${line}`
}

function landingShadow(shadow: string | null | undefined): string | undefined {
  const lines = [landingLine(), shadow].filter((line): line is string => typeof line === 'string')
  return lines.length === 0 ? undefined : lines.join('\n')
}

export function signInChoiceVerb(verb: 'use' | 'forget' | 'list', rest: string[]): { words: string; changed: boolean } {
  const familyWord = rest.length >= 2 ? parseFamilyFocus(rest[0]) : undefined
  const family = familyWord === undefined ? undefined : familyWord === 'claudeai' || familyWord === 'console' ? 'anthropic' : familyWord
  const identity = rest.length >= 2 && familyWord !== undefined ? rest.slice(1).join(' ') : rest.join(' ')
  if (verb === 'list' || identity.trim() === '') {
    const rows = everySignInRoster()
    if (rows.length === 0) return { words: 'no sign-ins yet — /logins signs in', changed: false }
    const lines = rows.map(row => {
      const roads = roadsWords(row)
      return `${familyDisplayName(row.family)}: ${signInWords(row)}${row.isDefault ? ' · default' : ''}${row.inUse ? ' · in use' : ''}${roads === undefined ? '' : ` · roads: ${roads}`}`
    })
    const refusals = projectSignInRefusals().map(refusal => projectSignInRefusalWords(refusal))
    return { words: [...lines, ...refusals, '/logins use <identity> spends one this session · /logins forget <identity> drops a second sign-in'].join('\n'), changed: false }
  }
  if (verb === 'use') {
    if (identity.trim().toLowerCase() === 'default' && family !== undefined) return { words: useDefaultSignIn(family), changed: true }
    const outcome = useSignIn(identity, family)
    return { words: outcome.words, changed: outcome.ok }
  }
  const outcome = forgetSignIn(identity, family)
  return { words: outcome.words, changed: outcome.ok }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const returnToken = tokens.find(token => token.startsWith('--return='))
  const returnCommand = returnToken?.slice('--return='.length)
  const chain =
    returnCommand !== undefined && returnCommand.startsWith('/')
      ? { nextInput: returnCommand, submitNextInput: true as const }
      : {}
  const words = tokens.filter(token => !token.startsWith('--'))
  const verb = words[0]?.toLowerCase()
  if (verb === 'use' || verb === 'forget' || verb === 'list') {
    const outcome = signInChoiceVerb(verb, words.slice(1))
    if (outcome.changed) {
      context.onChangeAPIKey()
      context.setMessages(prev => stripSignatureBlocks(prev))
      runPostLoginRefresh(context)
    }
    onDone(outcome.words, chain)
    return null
  }
  const initialFocus = parseFamilyFocus(words[0])
  const complete = (success: boolean, engineModel: string): void => {
    void (async () => {
      context.onChangeAPIKey()
      context.setMessages(prev => stripSignatureBlocks(prev))
      if (success) {
        runPostLoginRefresh(context)
        const shadow = landingShadow(loginShadowWarning())
        const receipt = loginSuccessReceipt(getOauthAccountInfo()?.emailAddress)
        onDone(shadow ? `${receipt}\n${shadow}` : receipt, chain)
      } else {
        onDone('/logins closed — no credential changed', chain)
      }
      void engineModel
    })()
  }
  const completeOpenai = (outcome: { ok: boolean; receipt: string }): void => {
    context.setAppState(prev => ({ ...prev, authVersion: (prev.authVersion ?? 0) + 1 }))
    const result = outcome.ok ? { ...outcome, receipt: withLandingWords(outcome.receipt) } : outcome
    onDone(result.receipt, chain)
  }
  const scrollRef = React.createRef<ScrollBoxHandle>()
  openSettingsPopup({
    view: 'logins',
    scrollRef,
    width: 100,
    rows: 29,
    line: 'esc back · from the menu, esc closes /logins',
    hint: 'esc or click outside closes',
    bodyOwnsEscape: true,
    body: geometry => (
      <Login
        geometry={geometry}
        scrollRef={scrollRef}
        onDone={(success, model) => {
          closeSettingsPopup()
          complete(success, model)
        }}
        onOpenaiDone={result => {
          closeSettingsPopup()
          completeOpenai(result)
        }}
        startingMessage={SIGN_IN_WORDS.intro}
        {...(initialFocus !== undefined ? { initialFocus } : {})}
      />
    ),
  })
  return null
}
