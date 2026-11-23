
import React, { useCallback, useState, useSyncExternalStore } from 'react'
import { usePublish, useTimer } from '../effects/effects.js'
import { useFluxMountMark } from './useFluxMountMark.js'
import { Box, Text, flushPendingSyncWork } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { isFullscreenActive } from '../fullscreen-layout/fullscreen.js'
import type { StreamingTailStore } from '../../engine/message-shapes/streamingTailStore.js'
import { StreamingMarkdown } from './Markdown.js'
import { MercuryStreamingNameplate } from './ChatLine.js'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export function openFenceOf(prefix: string): string | null {
  const open = foldFenceRange(prefix, 0, prefix.length, null)
  return open ? open.line : null
}

type OpenFence = { char: string; len: number; line: string }
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

function foldFenceLine(open: OpenFence | null, line: string): OpenFence | null {
  const m = FENCE_LINE.exec(line)
  if (!m) return open
  const marker = m[1]!
  const char = marker[0]!
  const rest = m[2]!
  if (open === null) {
    if (char === '`' && rest.includes('`')) return null
    return { char, len: marker.length, line: line.trimStart() }
  }
  if (char === open.char && marker.length >= open.len && rest.trim() === '') return null
  return open
}

function canOpenFence(text: string, from: number, to: number): boolean {
  let i = from
  while (i < to && i - from < 3 && text.charCodeAt(i) === 32) i++
  if (i >= to) return false
  const c = text.charCodeAt(i)
  return c === 96 || c === 126
}

function foldFenceRange(text: string, from: number, to: number, open: OpenFence | null): OpenFence | null {
  let at = from
  while (at < to) {
    let end = text.indexOf('\n', at)
    if (end === -1 || end > to) end = to
    fenceFoldCensus.lines++
    if (canOpenFence(text, at, end)) open = foldFenceLine(open, text.slice(at, end))
    at = end + 1
  }
  return open
}

export const fenceFoldCensus = { lines: 0, carries: 0, resets: 0 }

const fenceCarry: { text: string; cut: number; open: OpenFence | null } = { text: '', cut: 0, open: null }

function openFenceBefore(text: string, cut: number): string | null {
  let from = 0
  let open: OpenFence | null = null
  if (cut >= fenceCarry.cut && text.startsWith(fenceCarry.text)) {
    from = fenceCarry.cut
    open = fenceCarry.open
    fenceFoldCensus.carries++
  } else {
    fenceFoldCensus.resets++
  }
  open = foldFenceRange(text, from, cut, open)
  fenceCarry.text = text
  fenceCarry.cut = cut
  fenceCarry.open = open
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
  return { text: text.slice(cut), truncated: true, openFence: openFenceBefore(text, cut) }
}

export const SETTLE_LINGER_MS = 2000

const TEXT_FLOWING = 'text-flowing'

export function LiveStreamingTail({
  store,
  textSuppressed = false,
}: {
  store: StreamingTailStore
  textSuppressed?: boolean
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
  const settled = !textSuppressed && published === null ? store.readSettled() : null
  const settledSince = settled !== null ? store.readSettledSinceMs() : null
  const [lingerExpired, setLingerExpired] = useState(false)
  useTimer(() => {
    if (settled === null) {
      setLingerExpired(false)
      return
    }
    const age = settledSince === null ? 0 : Math.max(0, performance.now() - settledSince)
    const timer = startTimeout(() => setLingerExpired(true), Math.max(0, SETTLE_LINGER_MS - age))
    return () => stopTimeout(timer)
  }, [settled, settledSince])
  const ghost = settled !== null && !lingerExpired
  const rawText = textSuppressed ? null : (published ?? (ghost ? settled : null))
  usePublish(() => {
    if (settled !== null && lingerExpired) store.dropSettled()
  }, [store, settled, lingerExpired])
  const phases = store.readPhases()
  const phase = rawText === null ? null : published !== null ? phases.current : phases.settled
  const ink = phase === 'commentary' ? 'subtle' : undefined
  const bounded =
    rawText && !isFullscreenActive()
      ? boundTailForInline(rawText, rows, columns)
      : { text: rawText, truncated: false, openFence: null }
  const text =
    bounded.truncated && bounded.openFence && bounded.text
      ? `${bounded.openFence}\n${bounded.text}`
      : bounded.text
  if (!text) return null
  return (
    <Box marginTop={1} width="100%" flexDirection="column">
      {bounded.truncated ? (
        <Text dimColor>… the reply continues above-fold at settle</Text>
      ) : null}
      <StreamingMarkdown leadingInline={<MercuryStreamingNameplate />} color={ink}>
        {text}
      </StreamingMarkdown>
    </Box>
  )
}
