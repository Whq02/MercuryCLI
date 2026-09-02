
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useFluxMountMark } from '../hooks/useFluxMountMark.js'
import { Box, Text, flushPendingSyncWork } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import { isScribeModeOn } from '../utils/scribeMode.js'
import type { StreamingTailStore } from '../utils/messages/streamingTailStore.js'
import { StreamingMarkdown } from './Markdown.js'
import {
  MercuryStreamingNameplate,
  ScribeStreamingNameplate,
} from './messages/ChatLine.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { cockpitEngine } from '../render-engine/cockpit/engineMount.js'
import { useAppState, type AppState } from '../state/AppState.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'

const subscribeFocusedTailModel = subscribeThroughFocused((connector, listener) =>
  connector.subscribeModel(listener),
)
const getFocusedTailModel = (): string => getFocusedSessionConnector().modelFacts().effective

export function openFenceOf(prefix: string): string | null {
  let open: { char: string; len: number; line: string } | null = null
  for (const line of prefix.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    const marker = m[1]!
    const char = marker[0]!
    const rest = m[2]!
    if (open === null) {
      if (char === '`' && rest.includes('`')) continue
      open = { char, len: marker.length, line: line.trimStart() }
    } else if (char === open.char && marker.length >= open.len && rest.trim() === '') {
      open = null
    }
  }
  return open ? open.line : null
}

export function boundTailForInline(
  text: string,
  rows: number,
  columns: number,
): { text: string; truncated: boolean; openFence: string | null } {
  const capRows = Math.max(4, rows - 6)
  const width = Math.max(20, columns - 4)
  let used = 0
  let end = text.length
  let cut = text.length
  let linesRemain = true
  while (linesRemain && used < capRows) {
    const nl = end === 0 ? -1 : text.lastIndexOf('\n', end - 1)
    const lineStart = nl + 1
    used += Math.max(1, Math.ceil((end - lineStart) / width))
    cut = lineStart
    if (nl === -1) linesRemain = false
    else end = nl
  }
  if (!linesRemain) return { text, truncated: false, openFence: null }
  return { text: text.slice(cut), truncated: true, openFence: openFenceOf(text.slice(0, cut)) }
}

export const SETTLE_LINGER_MS = 2000

const TEXT_FLOWING = 'text-flowing'

export function LiveStreamingTail({
  store,
  settledShown = false,
  publishedShown = false,
  textSuppressed = false,
}: {
  store: StreamingTailStore
  textSuppressed?: boolean
  settledShown?: boolean
  publishedShown?: boolean
}): React.ReactNode {
  fluxMark('render:tail')
  useFluxMountMark('tail')
  const subscribe = useCallback(
    (cb: () => void) =>
      store.subscribe(() => {
        cb()
        if (!textSuppressed && store.read() !== null) flushPendingSyncWork()
      }),
    [store, textSuppressed],
  )
  const readPhase = useCallback(
    () => (store.getSnapshot() === null ? null : TEXT_FLOWING),
    [store],
  )
  const published = useSyncExternalStore(subscribe, textSuppressed ? readPhase : store.getSnapshot)
  const { rows, columns } = useTerminalSize()
  const turnActive = useAppState((s: AppState) => s.foregroundTurnActive)
  const settled = !textSuppressed && published === null ? store.readSettled() : null
  const [lingerExpired, setLingerExpired] = useState(false)
  useEffect(() => {
    if (settled === null) {
      setLingerExpired(false)
      return
    }
    if (settledShown || turnActive) return
    const timer = setTimeout(() => setLingerExpired(true), SETTLE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [settled, settledShown, turnActive])
  const ghost = settled !== null && !settledShown && (turnActive || !lingerExpired)
  const rawText = textSuppressed
    ? null
    : ((publishedShown ? null : published) ?? (ghost ? settled : null))
  useEffect(() => {
    if (settled !== null && (settledShown || (!turnActive && lingerExpired))) store.dropSettled()
  }, [store, settled, settledShown, turnActive, lingerExpired])
  const engine = cockpitEngine()
  if (engine && rawText) engine.streamBody.update(rawText, Math.max(20, columns - 4))
  const bounded =
    rawText && !isFullscreenActive()
      ? boundTailForInline(rawText, rows, columns)
      : { text: rawText, truncated: false, openFence: null }
  const text =
    bounded.truncated && bounded.openFence && bounded.text
      ? `${bounded.openFence}\n${bounded.text}`
      : bounded.text
  const liveModel = useSyncExternalStore(
    subscribeFocusedTailModel,
    getFocusedTailModel,
    getFocusedTailModel,
  )
  if (!text) {
    const quiet = !textSuppressed || published === null
    if (turnActive && quiet && declaredRouteOf(liveModel) === 'openai') {
      return (
        <Box marginTop={1} width="100%">
          <Text dimColor>thinking</Text>
        </Box>
      )
    }
    return null
  }
  return (
    <Box marginTop={1} width="100%" flexDirection="column">
      {bounded.truncated ? (
        <Text dimColor>… the reply continues above-fold at settle</Text>
      ) : null}
      {isScribeModeOn() ? (
        <StreamingMarkdown leadingInline={<ScribeStreamingNameplate />}>
          {text}
        </StreamingMarkdown>
      ) : (
        <StreamingMarkdown leadingInline={<MercuryStreamingNameplate />}>
          {text}
        </StreamingMarkdown>
      )}
    </Box>
  )
}
