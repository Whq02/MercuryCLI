import React, {
  useCallback,
  useRef,
  useState,
} from 'react'
import { useLayoutClaim, useLoad } from '../../../screen/effects/effects.js'
import { Box, Text } from '../../../screen/themedRenderer.js'
import { SetupFrameBody } from '../../../boot/first-run/MercurySetupFrame.js'
import { useSettingsPopupFrameIfAny } from '../../../screen/settings/Settings.js'
import { Spinner } from '../../../screen/spinner/Spinner.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import { PopupFormContext, usePopupCompact, usePopupMarker } from '../../../screen/overlays/popupFormContext.js'
import { PopupFrameContext } from '../../../screen/overlays/PopupGutter.js'
import { settingsPopupMarker } from '../../../screen/cockpit/settingsPopup.js'
import { escapeFromOutsidePress } from '../../../screen/renderer/recessLayer.js'
import { LoginAccountCard } from './LoginAccountCard.js'
import { useSignInEpoch } from '../account-ledger/useSignInEpoch.js'
import { useCatalogueEpoch } from '../../../screen/model-picker/useCatalogueEpoch.js'
import { useNotifications } from '../../../screen/notifications/notifications.js'
import { useInput } from '../../../screen/themedRenderer.js'
import { useAnthropicLoginModel } from '../../../screen/widgets/faces/anthropicLoginModel.js'
import { CompatConnect } from './CompatConnect.js'
import { DEVIN_EXTERNAL_AGENT_VALUE, localRoadOpen, loginFamilyRows, SIGN_IN_LATER_ROW, TENSORFOLD_FAMILY_VALUE, type LoginFamilyValue, type TensorFoldOffer } from './loginFamilyRows.js'
import { DevinCliCard } from '../../../screen/boot-face/logins/DevinCliCard.js'
import { localDiscoverySummary } from '../../roads/local/localCatalogue.js'
import { refreshLocalDiscovery } from '../../roads/local/localDiscovery.js'
import { armFaceDoorDeepLink, armTensorFoldDeepLink, disarmTensorFoldDeepLink } from '../../../platform/substrate/splashHandover.js'
import { type EngineLeg, legCard } from './legCard.js'
import { type LoginFamilyFocus, idleCard, waitingCard, successCard, errorCard } from './flowCards.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

export { MORE_BELOW_ROW, READINESS_ROWS } from './readiness.js'
export { type LoginFamilyFocus, type SignInCardFit, signInCardFit } from './flowCards.js'

const KNOWN_ENGINE_LEGS = new Set<string>([
  'anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai',
  'deepseek', 'xai', 'meta', 'mistral', 'nous', 'zen', 'minimax', 'together',
  'cohere', 'groq', 'melious', 'orcarouter', 'cerebras', 'fireworks', 'qwen',
])

function toEngineLeg(value: string): EngineLeg | null {
  if (value.startsWith('compat/')) return value as `compat/${string}`
  return KNOWN_ENGINE_LEGS.has(value) ? (value as EngineLeg) : null
}

export function ConsoleOAuthFlow({
  tensorfold,
  onAccountChange,
  onDone,
  onCancel,
  onOpenaiDone,
  startingMessage,
  mode,
  forceLoginMethod,
  initialFocus,
  onSkip,
  onAbandonLeg,
  externalAgents,
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
  externalAgents?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const popup = React.useContext(PopupFormContext)
  const { compact } = usePopupCompact()
  const popupFrame = React.useContext(PopupFrameContext)
  const setupBody = React.useContext(SetupFrameBody)
  const settingsPopup = useSettingsPopupFrameIfAny()
  const { addNotification } = useNotifications()
  useSignInEpoch()
  useCatalogueEpoch()

  const hasSkip = onSkip !== undefined
  const [localRoad, setLocalRoad] = useState<ReturnType<typeof localDiscoverySummary> | null>(() =>
    hasSkip ? localDiscoverySummary() : null,
  )
  useLoad(signal => {
    if (!hasSkip) return
    void refreshLocalDiscovery()
      .then(() => {
        if (!signal.aborted) setLocalRoad(localDiscoverySummary())
      })
      .catch(passedOverAs(undefined))
  }, [hasSkip])

  const setupToken = mode === 'setup-token'
  const model = useAnthropicLoginModel(
    {
      ...(mode !== undefined ? { mode } : {}),
      ...(forceLoginMethod !== undefined ? { forceLoginMethod } : {}),
      onDone,
    },
    { notify: addNotification },
  )

  const [leg, setLeg] = useState<EngineLeg | null>(null)
  const [accountFamily, setAccountFamily] = useState<LoginFamilyValue | null>(null)
  const [externalAgent, setExternalAgent] = useState<'devin' | null>(null)
  const [code, setCodeState] = useState('')
  const codeRef = useRef('')
  const setCode = useCallback((next: string): void => {
    codeRef.current = next
    setCodeState(next)
  }, [])
  const [codeCursor, setCodeCursor] = useState(0)
  const [menuFocus, setMenuFocus] = useState(0)
  const [rosterVisibleTo, setRosterVisibleTo] = useState<number | null>(null)

  const engineLegs = onOpenaiDone !== undefined && !setupToken
  const familyRows = loginFamilyRows({ engineLegs, tensorfold, ...(externalAgents === true ? { externalAgents: true } : {}) })
  const totalMenuRows = familyRows.length + (hasSkip ? 1 : 0)
  const onIdleMenu = accountFamily === null && leg === null && externalAgent === null && model.flow.name === 'idle'
  const showingSelectionList =
    externalAgent === null && model.flow.name === 'idle' && (leg === null || leg === 'anthropic' || leg === 'openai')
  useLayoutClaim(() => {
    if (!settingsPopup) return
    if (!showingSelectionList) {
      settingsPopup.setHint(null)
      return
    }
    settingsPopup.setHint('↑↓ move · pgup/pgdn page · ↵ select · esc back · click outside closes')
    return () => {
      settingsPopup.setHint(null)
    }
  }, [settingsPopup, showingSelectionList])

  usePopupMarker(
    compact && onIdleMenu ? settingsPopupMarker(menuFocus + 1, totalMenuRows) : null,
  )

  const skipLater = useCallback((): void => {
    disarmTensorFoldDeepLink()
    if (localRoadOpen(localRoad)) armFaceDoorDeepLink('model')
    onSkip?.()
  }, [localRoad, onSkip])

  const settleLeg = useCallback(
    (result: { ok: boolean; receipt: string }): void => {
      setLeg(null)
      onOpenaiDone?.(result)
    },
    [onOpenaiDone],
  )

  const submitCode = useCallback(
    (raw: string): void => {
      if (!model.submitCode(raw)) {
        setCode('')
        setCodeCursor(0)
      }
    },
    [model, setCode],
  )

  const startFamily = useCallback(
    (value: string): void => {
      if (value === TENSORFOLD_FAMILY_VALUE) {
        armTensorFoldDeepLink()
        onSkip?.()
        return
      }
      if (value === SIGN_IN_LATER_ROW.value) {
        skipLater()
        return
      }
      disarmTensorFoldDeepLink()
      if (value === DEVIN_EXTERNAL_AGENT_VALUE) {
        setExternalAgent('devin')
        return
      }
      const nextLeg = toEngineLeg(value)
      if (nextLeg !== null) setLeg(nextLeg)
    },
    [onSkip, skipLater],
  )

  useInput((input, key, event) => {
    if (key.escape && popup && escapeFromOutsidePress()) {
      event.stopImmediatePropagation()
      if (model.flow.name === 'success') onDone()
      else onCancel?.()
      return
    }
    if (
      key.escape &&
      accountFamily === null &&
      leg === null &&
      externalAgent === null &&
      (model.flow.name === 'ready' || model.flow.name === 'waiting' || model.flow.name === 'error')
    ) {
      event.stopImmediatePropagation()
      model.reset()
      if (onAbandonLeg !== undefined) onAbandonLeg()
      else onCancel?.()
      return
    }
    if (
      accountFamily === null &&
      leg === null &&
      externalAgent === null &&
      model.flow.name === 'waiting' &&
      model.pastePromptUp &&
      codeRef.current === '' &&
      input === 'c' &&
      !key.ctrl &&
      !key.meta &&
      !key.shift
    ) {
      event.stopImmediatePropagation()
      model.copyUrl()
      return
    }
    if (
      onIdleMenu &&
      onSkip !== undefined &&
      input === 's' &&
      !key.ctrl &&
      !key.meta &&
      !key.shift
    ) {
      event.stopImmediatePropagation()
      skipLater()
    }
  })

  const title = setupToken ? 'Set up a long-lived token' : 'Sign in'
  const frame = (children: React.ReactNode): React.ReactNode => {
    const content = (
      <Box flexDirection="column" gap={compact ? 0 : 1}>
        {compact ? null : <Text bold>{title}</Text>}
        {children}
      </Box>
    )
    if (popup) return content
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.borderSubtle}
        paddingX={1}
      >
        {content}
      </Box>
    )
  }

  if (accountFamily !== null) {
    return frame(
      <LoginAccountCard
        family={accountFamily}
        onSignIn={() => {
          const family = accountFamily
          setAccountFamily(null)
          startFamily(family)
        }}
        onBack={() => setAccountFamily(null)}
        onChanged={receipt => {
          onAccountChange?.(receipt)
        }}
      />,
    )
  }

  if (externalAgent === 'devin') {
    return frame(<DevinCliCard compact={compact} onBack={() => setExternalAgent(null)} />)
  }

  if (leg !== null) {
    if (leg.startsWith('compat/')) {
      return frame(
        <CompatConnect
          name={leg.slice('compat/'.length)}
          onResult={settleLeg}
          onBack={() => setLeg(null)}
        />,
      )
    }
    return legCard({
      leg,
      frame,
      compact,
      setLeg,
      model,
      onDone,
      onOpenaiDone,
      settleLeg,
    })
  }

  switch (model.flow.name) {
    case 'idle':
      return idleCard({
        frame, compact, familyRows, onSkip, localRoad, initialFocus, popup, setupBody,
        startingMessage, columns, rows, popupFrame, menuFocus, rosterVisibleTo, tensorfold,
        setMenuFocus, setRosterVisibleTo, setAccountFamily, startFamily, onCancel,
      })
    case 'ready':
      return frame(<Text dimColor>Opening your browser…</Text>)
    case 'waiting':
      return waitingCard({
        state: model.flow, frame, compact, model, columns, tokens,
        pastePromptUp: model.pastePromptUp, copied: model.copied,
        code, setCode, submitCode, codeCursor, setCodeCursor,
      })
    case 'creating-key':
      return frame(<Box><Spinner /><Text> Minting the key…</Text></Box>)
    case 'success':
      return successCard({
        state: model.flow, frame, compact, onDone, tokens, setupToken,
        accountLabel: model.accountLabel, shadowWarning: model.shadowWarning,
      })
    case 'error':
      return errorCard({ state: model.flow, frame, compact, model, tokens, setCode, setCodeCursor })
    case 'about-to-retry':
      return frame(<Text dimColor>Retrying…</Text>)
  }
}

export default ConsoleOAuthFlow
