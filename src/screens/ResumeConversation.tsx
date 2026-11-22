import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useLoad } from '../hooks/effects.js'
import { useAppStateStore } from '../state/AppState.js'
import { LogSelector } from '../components/LogSelector.js'
import { SpinnerGlyph } from '../components/Spinner/SpinnerGlyph.js'
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js'
import { SurfaceRouter } from '../components/SurfaceRouter.js'
import { initializeSurfaceRoute, ROOT_CHAT_ROUTE } from '../context/surfaceRoute.js'
import { Box, Text, useInput } from '../ink.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { launcherAltHoldPending } from '../ink/launcherAltHold.js'
import { setClipboard } from '../ink/termio/osc.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Tool } from '../Tool.js'
import type { Command } from '../commands.js'
import type { SessionListing } from '../types/logs.js'
import { checkCrossProjectResume } from '../utils/crossProjectResume.js'
import { logError } from '../utils/log.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../utils/fullscreen.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import {
  enrichSessionListings,
  formatSessionReadFailures,
  mergeSessionReadFailures,
  sessionIdOfListing,
  listSessionsAcrossProjectsProgressive,
  listRepoSessionsProgressive,
  type SessionPage,
  type SessionReadFailures,
} from '../utils/sessionStorage/logs.js'
import { isCustomTitleEnabled } from '../utils/sessionStorage/paths.js'
import { Chat, type Props as ChatProps } from './Chat.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const LOAD_MORE_BATCH = 20

type Props = Unbuilt

function matchesPrFilter(log: SessionListing, filter: Props['filterByPr']): boolean {
  if (filter === undefined) return true
  const prNumber = (log as { prNumber?: number }).prNumber
  if (filter === true) return prNumber !== undefined
  if (typeof filter === 'number') return prNumber === filter
  if (typeof filter !== 'string') return false
  const asInt = /^\d+$/.test(filter) ? Number(filter) : undefined
  if (asInt !== undefined && asInt > 0) return prNumber === asInt
  const fromUrl = /\/pull\/(\d+)/.exec(filter)
  if (fromUrl) return prNumber === Number(fromUrl[1])
  return false
}

function SpinnerLine({ text }: { text: string }): React.ReactNode {
  const [ref, time] = useAnimationFrame(120)
  return (
    <Box ref={ref} gap={1}>
      <SpinnerGlyph frame={Math.floor(time / 120)} time={time} messageColor="systemSpinner" />
      <Text>{text}</Text>
    </Box>
  )
}

function ResumeWaitInner({ text, hint, onCancel }: { text: string; hint: string; onCancel: () => void }): React.ReactNode {
  useKeybinding('app:interrupt', onCancel)
  useInput((_input, key) => {
    if (key.escape) onCancel()
  })
  return (
    <Box flexDirection="column">
      <SpinnerLine text={text} />
      <Box paddingLeft={2}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}
function ResumeWait(props: { text: string; hint: string; onCancel: () => void }): React.ReactNode {
  return (
    <KeybindingSetup>
      <ResumeWaitInner {...props} />
    </KeybindingSetup>
  )
}

function GroundFill({ children }: { children: React.ReactNode }): React.ReactNode {
  const tokens = useMercuryTokens()
  const size = React.useContext(TerminalSizeContext)
  return (
    <Box
      flexDirection="column"
      height={size?.rows ?? 24}
      width="100%"
      backgroundColor={estateGroundBg(tokens)}
    >
      {children}
    </Box>
  )
}

function NoConversations({ readNotice }: { readNotice: string | null }): React.ReactNode {
  useKeybinding('app:interrupt', () => {
    process.exit(1)
  })
  return (
    <Box paddingX={1} flexDirection="column">
      {readNotice !== null ? (
        <Text color="warning" wrap="wrap">
          {readNotice}
        </Text>
      ) : null}
      <Text>No conversations to resume. Press ctrl+c to exit and start fresh.</Text>
    </Box>
  )
}

function LoadConversationsFailed({ error }: { error: string }): React.ReactNode {
  useKeybinding('app:interrupt', () => {
    process.exit(1)
  })
  return (
    <Box paddingX={1}>
      <Text color="error" wrap="wrap">
        Could not load conversations ({error}) — press ctrl+c to exit and start fresh.
      </Text>
    </Box>
  )
}

export function ResumeConversation(arg0: Props): React.ReactNode {
  return notBuilt('src/screens/ResumeConversation.tsx:142')
}
