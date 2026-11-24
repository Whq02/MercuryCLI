import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text, useInput } from '../../screen/themedRenderer.js'
import { ConsoleOAuthFlow, type LoginFamilyFocus } from '../../models/sign-in/flow-cards/SignInFlow.js'
import { PopupForm } from '../../screen/overlays/PopupForm.js'
import { usePopupCompact } from '../../screen/overlays/popupFormContext.js'
import type { ScrollBoxHandle } from '../../screen/renderer/elements/ScrollBox.js'
import { closeSettingsPopup, openSettingsPopup, type SettingsPopupGeometry } from '../../screen/cockpit/settingsPopup.js'
import { resetCostState } from '../../boot/process-state/processState.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../catalogue/command.js'
import { getOauthAccountInfo, loginShadowWarning } from '../../models/sign-in/credentials/auth.js'
import { loginSuccessReceipt } from '../../models/sign-in/account-ledger/loginReceipt.js'
import { logError } from '../../platform/logs/errorLog.js'
import { stripSignatureBlocks } from '../../engine/messages/messages.js'
import {
  checkAndDisableSovereignIfNeeded,
  resetSovereignCheck,
} from '../../permissions/rules/sovereignKillswitch.js'
import { resetUserCache } from '../../platform/environment/user.js'
import { loginFamilyFocusFor } from '../../models/sign-in/flow-cards/loginFamilyRows.js'

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
  onDone: (success: boolean) => void
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  initialFocus?: LoginFamilyFocus
}): React.ReactNode {
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
    onDone(success)
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

export function parseFamilyFocus(token: string | undefined): LoginFamilyFocus | undefined {
  if (token?.startsWith('compat/')) return loginFamilyFocusFor(token)
  switch ((token ?? '').toLowerCase()) {
    case 'anthropic':
    case 'claude':
    case 'claudeai':
    case 'console':
      return 'anthropic'
    case 'openai':
    case 'chatgpt':
    case 'gpt':
      return 'openai'
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
    case 'minimax':
      return 'minimax'
    case 'together':
      return 'together'
    case 'cohere':
      return 'cohere'
    case 'groq':
      return 'groq'
    case 'melious':
      return 'melious'
    case 'orcarouter':
      return 'orcarouter'
    case 'cerebras':
      return 'cerebras'
    case 'fireworks':
      return 'fireworks'
    case 'qwen':
      return 'qwen'
    default:
      return undefined
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const tokens = (args ?? '').trim().split(/\s+/).filter(token => token !== '')
  const returnCommand = tokens.find(token => token.startsWith('--return='))?.slice('--return='.length)
  const chain: Parameters<LocalJSXCommandOnDone>[1] =
    returnCommand !== undefined && returnCommand.startsWith('/') ? { nextInput: returnCommand, submitNextInput: true } : {}
  const initialFocus = parseFamilyFocus(tokens.find(token => !token.startsWith('--')))

  const complete = async (success: boolean): Promise<void> => {
    if (!success) {
      onDone('/logins closed — no credential changed', chain)
      return
    }
    context.onChangeAPIKey()
    context.setMessages(prev => stripSignatureBlocks(prev))
    resetCostState()
    resetUserCache()
    resetSovereignCheck()
    checkAndDisableSovereignIfNeeded(context.getAppState().toolPermissionContext, context.setAppState).catch(logError)
    context.setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }))
    const shadowWarning = loginShadowWarning()
    const receipt = loginSuccessReceipt(getOauthAccountInfo()?.emailAddress)
    onDone(shadowWarning ? `${receipt}\n${shadowWarning}` : receipt, chain)
  }

  const scrollRef = React.createRef<ScrollBoxHandle>()
  openSettingsPopup({
    view: 'logins',
    scrollRef,
    width: 100,
    rows: 29,
    line: '',
    hint: 'esc or click outside closes',
    bodyOwnsEscape: true,
    body: geometry => (
      <Login
        geometry={geometry}
        scrollRef={scrollRef}
        onDone={success => {
          closeSettingsPopup()
          void complete(success)
        }}
        onOpenaiDone={result => {
          closeSettingsPopup()
          context.setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }))
          onDone(result.receipt, chain)
        }}
        {...(initialFocus === undefined ? {} : { initialFocus })}
      />
    ),
  })
  return null
}
