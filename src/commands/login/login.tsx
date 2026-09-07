import * as React from 'react'
import { useRef } from 'react'
import { Box } from '../../ink.js'
import { ConsoleOAuthFlow, type LoginFamilyFocus } from '../../components/ConsoleOAuthFlow.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { resetCostState } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { loginShadowWarning } from '../../utils/auth.js'
import { logError } from '../../utils/log.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableBypassPermissionsIfNeeded,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

export function Login({
  onDone,
  onOpenaiDone,
  startingMessage,
  initialFocus,
}: {
  onDone: (success: boolean, mainLoopModel: string) => void
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  initialFocus?: LoginFamilyFocus
}): React.ReactNode {
  const mainLoopModel = useAppState(state => state.mainLoopModel)
  const settledRef = useRef(false)
  const settle = (success: boolean): void => {
    if (settledRef.current) return
    settledRef.current = true
    onDone(success, mainLoopModel ?? '')
  }
  const settleOpenai = (result: { ok: boolean; receipt: string }): void => {
    if (settledRef.current) return
    settledRef.current = true
    onOpenaiDone?.(result)
  }
  return (
    <CommandCenter
      view="login"
      footer="esc back · from the menu, esc closes login"
      captureInput={false}
      onClose={() => settle(false)}
    >
      <Box flexDirection="column">
        <ConsoleOAuthFlow
          onDone={() => settle(true)}
          onCancel={() => settle(false)}
          {...(onOpenaiDone !== undefined ? { onOpenaiDone: settleOpenai } : {})}
          {...(startingMessage !== undefined ? { startingMessage } : {})}
          {...(initialFocus !== undefined ? { initialFocus } : {})}
        />
      </Box>
    </CommandCenter>
  )
}

function runPostLoginRefresh(context: LocalJSXCommandContext): void {
  resetCostState()
  resetUserCache()
  resetBypassPermissionsCheck()
  void checkAndDisableBypassPermissionsIfNeeded(
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
    default:
      return undefined
  }
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
  const initialFocus = parseFamilyFocus(tokens.find(token => !token.startsWith('--')))
  const complete = (success: boolean, mainLoopModel: string): void => {
    void (async () => {
      context.onChangeAPIKey()
      context.setMessages(prev => stripSignatureBlocks(prev))
      if (success) {
        runPostLoginRefresh(context)
        const shadow = loginShadowWarning()
        onDone(shadow ? `Login successful\n${shadow}` : 'Login successful', chain)
      } else {
        onDone('Login closed — no credential changed', chain)
      }
      void mainLoopModel
    })()
  }
  const completeOpenai = (result: { ok: boolean; receipt: string }): void => {
    context.setAppState(prev => ({ ...prev, authVersion: (prev.authVersion ?? 0) + 1 }))
    onDone(result.receipt, chain)
  }
  return (
    <Login
      onDone={complete}
      onOpenaiDone={completeOpenai}
      {...(initialFocus !== undefined ? { initialFocus } : {})}
    />
  )
}
