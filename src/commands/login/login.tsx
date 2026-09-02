import * as React from 'react'
import { useRef } from 'react'
import { Box } from '../../ink.js'
import { ConsoleOAuthFlow, type LoginFamilyFocus } from '../../components/ConsoleOAuthFlow.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { resetCostState } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import { refreshFeatureGates } from '../../services/analytics/featureGates.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
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

/**
 * The OAuth flow with cancellation owned WHERE the state is known: the flow
 * cancels through its onCancel channel from its own screens (menu · opening
 * the browser · waiting · error), and each provider leg owns its esc (back
 * out of a key screen, cancel a device wait). A container-level esc/← here
 * would register EARLIER on the input chain than every later-mounted leg and
 * so preempt them all — closing the card on the ← that moves a caret inside
 * a pasted key. Input capture stays off so the flow keeps its own text/paste
 * handling.
 */
export function Login({
  onDone,
  onOpenaiDone,
  startingMessage,
  initialFocus,
}: {
  onDone: (success: boolean, mainLoopModel: string) => void
  /** Settles the command for the engine legs (OpenAI subscription/key ·
   *  OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek) — a
   *  different post-login path than the Anthropic credential swap. */
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  /** Pre-focus a provider row on the opening menu (/logins <family>). */
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

/** The post-login refresh set. Keep in sync with the onboarding path. */
async function runPostLoginRefresh(context: LocalJSXCommandContext): Promise<void> {
  resetCostState()
  void refreshRemoteManagedSettings().catch(logError)
  void refreshPolicyLimits().catch(logError)
  // User data resets BEFORE the gate refresh so it picks up the fresh
  // credentials.
  resetUserCache()
  await refreshFeatureGates()
  resetBypassPermissionsCheck()
  void checkAndDisableBypassPermissionsIfNeeded(
    context.getAppState().toolPermissionContext,
    context.setAppState,
  ).catch(logError)
  // Auth-dependent hooks (MCP servers, …) key on this counter.
  context.setAppState(prev => ({ ...prev, authVersion: (prev.authVersion ?? 0) + 1 }))
}

/** The family vocabulary a caller may pre-focus (/logins <family>): the
 *  provider-family ids plus their household spellings, mapped onto the
 *  opening menu's own row values. Unknown words open the menu unfocused. */
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
    // The vendors' own names beside the route ids: Kimi is Moonshot's
    // product, GLM is Z.AI's model line.
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
  // `--return=/cmd` (machine-built by chooser surfaces): whatever way this
  // login settles — success, interruption, an engine-leg receipt — the named
  // command is submitted next, so the operator lands back where the pick
  // began instead of on a dead end. Slash commands only.
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
      // The provider signs thinking/connector blocks against the credential
      // in use; replaying them under a new credential is refused, so they
      // must not be carried forward.
      context.setMessages(prev => stripSignatureBlocks(prev))
      if (success) {
        await runPostLoginRefresh(context)
        const shadow = loginShadowWarning()
        onDone(shadow ? `Login successful\n${shadow}` : 'Login successful', chain)
      } else {
        // esc from the menu or out of a leg alike: nothing signed in, nothing
        // changed — the receipt says that, never "interrupted" for a deliberate
        // close.
        onDone('Login closed — no credential changed', chain)
      }
      void mainLoopModel
    })()
  }
  // The engine legs (OpenAI · OpenRouter · Gemini) change no Anthropic
  // credential: signature blocks stay valid and the Anthropic-scoped refresh
  // set does not apply. Auth-dependent hooks still re-read (the account
  // roster changed).
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
