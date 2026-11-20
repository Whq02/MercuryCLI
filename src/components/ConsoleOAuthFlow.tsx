import React, {
  useCallback,
  useRef,
  useState,
} from 'react'
import { useLayoutClaim, useLoad } from '../hooks/effects.js'
import { Box, Text } from '../ink.js'
import { SetupFrameBody } from './MercurySetupFrame.js'
import { useSettingsPopupFrameIfAny } from './Settings/Settings.js'
import { Spinner } from './Spinner.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { PopupFormContext, usePopupCompact, usePopupMarker } from '../context/popupFormContext.js'
import { PopupFrameContext } from './PopupGutter.js'
import { settingsPopupMarker } from '../utils/cockpit/settingsPopup.js'
import { escapeFromOutsidePress } from '../ink/recessLayer.js'
import { LoginAccountCard } from './LoginAccountCard.js'
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js'
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js'
import { useNotifications } from '../context/notifications.js'
import { useInput } from '../ink.js'
import { useAnthropicLoginModel } from './mercury-ui/screens/anthropicLoginModel.js'
import { CompatConnect } from './CompatConnect.js'
import { localRoadOpen, loginFamilyRows, SIGN_IN_LATER_ROW, TENSORFOLD_FAMILY_VALUE, type LoginFamilyValue, type TensorFoldOffer } from './loginFamilyRows.js'
import { localDiscoverySummary } from '../services/providers/local/localCatalogue.js'
import { refreshLocalDiscovery } from '../services/providers/local/localDiscovery.js'
import { armFaceDoorDeepLink, armTensorFoldDeepLink, disarmTensorFoldDeepLink } from '../substrate/splashHandover.js'
import { type EngineLeg, legCard } from './consoleOAuth/legCard.js'
import { type LoginFamilyFocus, idleCard, waitingCard, successCard, errorCard } from './consoleOAuth/flowCards.js'
import { passedOverAs } from '../utils/passedOver.js'

export { MORE_BELOW_ROW, READINESS_ROWS } from './consoleOAuth/readiness.js'
export { type LoginFamilyFocus, type SignInCardFit, signInCardFit } from './consoleOAuth/flowCards.js'

export function ConsoleOAuthFlow({
  onDone,
  onCancel,
  onOpenaiDone,
  startingMessage,
  mode = 'login',
  forceLoginMethod,
  initialFocus,
  onSkip,
  onAbandonLeg,
  onAccountChange,
  tensorfold,
}: {
  tensorfold?: TensorFoldOffer | null
  onAccountChange?: (receipt: string) => void
  onDone: () => void
  onCancel?: () => void
  onOpenaiDone?: (result: { ok: boolean; receipt: string }) => void
  startingMessage?: string
  mode?: 'login' | 'setup-token'
  forceLoginMethod?: 'claudeai' | 'console'
  initialFocus?: LoginFamilyFocus
  onSkip?: () => void
  onAbandonLeg?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const popup = React.useContext(PopupFormContext)
  const popupFrame = React.useContext(PopupFrameContext)
  const compact = usePopupCompact().compact && popup
  const setupBody = React.useContext(SetupFrameBody)
  const [rosterVisibleTo, setRosterVisibleTo] = useState<number | null>(null)
  const { addNotification } = useNotifications()
  const setupToken = mode === 'setup-token'

  const model = useAnthropicLoginModel(
    {
      onDone,
      ...(mode !== undefined ? { mode } : {}),
      ...(forceLoginMethod !== undefined ? { forceLoginMethod } : {}),
    },
    { notify: notice => addNotification(notice) },
  )
  const state = model.flow
  const pastePromptUp = model.pastePromptUp
  const copied = model.copied
  const shadowWarning = model.shadowWarning
  const accountLabel = model.accountLabel

  const [leg, setLeg] = useState<EngineLeg | null>(null)
  const [accountFamily, setAccountFamily] = useState<LoginFamilyValue | null>(null)
  const [menuFocus, setMenuFocus] = useState(0)
  useSignInEpoch()
  useCatalogueEpoch()
  const walkHost = onSkip !== undefined
  useLoad(() => {
    if (walkHost) void refreshLocalDiscovery().catch(passedOverAs(undefined))
  }, [walkHost])
  const localRoad = walkHost ? localDiscoverySummary() : null
  const menuUp = leg === null && accountFamily === null && state.name === 'idle'
  const settingsFrame = useSettingsPopupFrameIfAny()
  const listUp = menuUp || accountFamily !== null || leg === 'anthropic' || leg === 'openai'
  useLayoutClaim(() => {
    if (listUp) settingsFrame?.setHint('↑↓ move · pgup/pgdn page · ↵ select · esc back · click outside closes')
    else settingsFrame?.setHint(null)
    return () => settingsFrame?.setHint(null)
  }, [listUp, settingsFrame])
  const familyRows = loginFamilyRows({ engineLegs: onOpenaiDone !== undefined, tensorfold })
  const menuCount = familyRows.length + (onSkip !== undefined ? 1 : 0)
  usePopupMarker(compact && menuUp ? settingsPopupMarker(menuFocus + 1, menuCount) : null)
  const [code, setCodeState] = useState('')
  const codeRef = useRef('')
  const setCode = useCallback((next: string): void => {
    codeRef.current = next
    setCodeState(next)
  }, [])
  const [codeCursor, setCodeCursor] = useState(0)

  useInput(
    (_input, key, event) => {
      if (popup && key.escape && escapeFromOutsidePress()) {
        event.stopImmediatePropagation()
        if (state.name === 'success') onDone()
        else onCancel?.()
        return
      }
      if (key.escape && (state.name === 'ready' || state.name === 'waiting' || state.name === 'error')) (onAbandonLeg ?? onCancel)?.()
    },
    {
      isActive:
        (onAbandonLeg !== undefined || onCancel !== undefined) &&
        (popup || state.name === 'ready' || state.name === 'waiting' || state.name === 'error'),
    },
  )

  useInput(
    (input, key, event) => {
      if (
        input === 'c' &&
        !key.ctrl && !key.meta &&
        state.name === 'waiting' &&
        pastePromptUp &&
        codeRef.current === ''
      ) {
        event.stopImmediatePropagation()
        model.copyUrl()
      }
    },
    { isActive: state.name === 'waiting' && pastePromptUp },
  )

  useInput(
    (input, key, event) => {
      if (input === 's' && !key.ctrl && !key.meta && !key.shift) {
        event.stopImmediatePropagation()
        startFamily(SIGN_IN_LATER_ROW.value)
      }
    },
    { isActive: menuUp && onSkip !== undefined },
  )

  const submitCode = useCallback(
    (raw: string) => {
      if (!model.submitCode(raw)) {
        setCode('')
        setCodeCursor(0)
      }
    },
    [model],
  )

  const frame = (children: React.ReactNode): React.ReactNode => (
    <Box
      flexDirection="column"
      borderStyle={popup ? undefined : 'round'}
      borderColor={tokens.borderSubtle}
      paddingX={popup ? 0 : 1}
      gap={compact ? 0 : 1}
    >
      {compact ? null : <Text bold>{setupToken ? 'Set up a long-lived token' : 'Sign in'}</Text>}
      {children}
    </Box>
  )

  const settleLeg = (result: { ok: boolean; receipt: string }): void => {
    onOpenaiDone?.(result)
  }

  const startFamily = (value: string): void => {
    if (value === TENSORFOLD_FAMILY_VALUE) {
      armTensorFoldDeepLink()
      onSkip?.()
      return
    }
    disarmTensorFoldDeepLink()
    if (value === SIGN_IN_LATER_ROW.value) {
      if (localRoadOpen(localRoad)) armFaceDoorDeepLink('model')
      onSkip?.()
      return
    }
    if (value.startsWith('compat/') && loginFamilyRows({ engineLegs: true }).some(row => row.value === value)) { setLeg(value as `compat/${string}`); return }
    if (value === 'anthropic' || value === 'openai' || value === 'moonshot' || value === 'zai' || value === 'deepseek' || value === 'xai' || value === 'meta' || value === 'mistral' || value === 'zen' || value === 'minimax' || value === 'together' || value === 'cohere' || value === 'groq' || value === 'orcarouter' || value === 'melious' || value === 'cerebras' || value === 'fireworks' || value === 'qwen' || value === 'openrouter' || value === 'gemini' || value === 'huggingface' || value === 'nous') setLeg(value)
  }
  if (accountFamily !== null) return frame(
    <LoginAccountCard
      family={accountFamily}
      onBack={() => setAccountFamily(null)}
      onSignIn={() => { setAccountFamily(null); startFamily(accountFamily) }}
      onChanged={receipt => onAccountChange?.(receipt)}
    />,
  )

  if (leg?.startsWith('compat/')) return frame(<CompatConnect name={leg.slice(7)} onResult={settleLeg} onBack={() => setLeg(null)} />)
  if (leg !== null) {
    const legView = legCard({ leg, frame, compact, setLeg, model, onDone, onOpenaiDone, settleLeg })
    if (legView !== null) return legView
  }

  switch (state.name) {
    case 'idle': {
      return idleCard({ frame, compact, familyRows, onSkip, localRoad, initialFocus, popup, setupBody, startingMessage, columns, rows, popupFrame, menuFocus, rosterVisibleTo, tensorfold, setMenuFocus, setRosterVisibleTo, setAccountFamily, startFamily, onCancel })
    }

    case 'ready':
      return frame(<Text dimColor>Opening your browser…</Text>)

    case 'waiting': {
      return waitingCard({ state, frame, compact, model, columns, tokens, pastePromptUp, copied, code, setCode, submitCode, codeCursor, setCodeCursor })
    }

    case 'creating-key':
      return frame(
        <Box>
          <Spinner />
          <Text> Minting the key…</Text>
        </Box>,
      )

    case 'success':
      return successCard({ state, frame, compact, onDone, tokens, setupToken, accountLabel, shadowWarning })

    case 'error':
      return errorCard({ state, frame, compact, model, tokens, setCode, setCodeCursor })

    case 'about-to-retry':
      return frame(<Text dimColor>Retrying…</Text>)
  }
}

export default ConsoleOAuthFlow
