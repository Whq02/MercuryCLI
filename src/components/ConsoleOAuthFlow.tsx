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
import { notBuilt } from '../pi/holes.js'

export { MORE_BELOW_ROW, READINESS_ROWS } from './consoleOAuth/readiness.js'
export { type LoginFamilyFocus, type SignInCardFit, signInCardFit } from './consoleOAuth/flowCards.js'

export function ConsoleOAuthFlow(arg0: {
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
  return notBuilt('src/components/ConsoleOAuthFlow.tsx:35')
}

export default ConsoleOAuthFlow
