import { pathTailLabel } from '../utils/pathLabel.js'
import * as React from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, measureElement, useInput } from '../ink.js'
import type { DOMElement } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  useIsInsideModal,
  useModalOrTerminalSize,
  useModalScrollRef,
} from '../context/modalContext.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { pokeTelemetry, useTelemetry } from '../state/telemetryBus.js'
import { useCwdState } from '../hooks/useCwdState.js'
import { formatFreshness } from '../utils/cockpit/freshness.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { CockpitEmbeddedContext, ProductLockup, useNowTick } from './mercury-ui/components.js'
import { packFooter } from './mercury-ui/footerHint.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { Deck } from './Deck.js'
import { FleetMonitor } from './FleetMonitor.js'
import { TraceView } from './TraceView.js'
import { SubstratePanel } from './SubstratePanel.js'
import { PolicyPanel } from './PolicyPanel.js'


type Tab = {
  key: string
  label: string
  Comp: React.ComponentType<{ onClose: () => void; mode?: string }>
}

function TabChip({
  label,
  active,
  accent,
  onClick,
}: {
  label: string
  active: boolean
  accent: string
  onClick: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <InteractiveRow id={`cockpit:tab:${label}`} directActivate onActivate={onClick} flexShrink={0}>
      {hover => (
        <Box backgroundColor={active ? tokens.surface2 : undefined} paddingX={1} marginRight={1}>
          {active ? (
            <Text bold>
              <Text color={accent}>{'▸ '}</Text>
              <Text color={tokens.textPrimary}>{label}</Text>
            </Text>
          ) : (
            <Text color={hover ? tokens.textSecondary : tokens.textMuted}>{label}</Text>
          )}
        </Box>
      )}
    </InteractiveRow>
  )
}

const TABS: Tab[] = [
  { key: 'deck', label: 'Deck', Comp: Deck },
  { key: 'fleet', label: 'Fleet', Comp: FleetMonitor },
  { key: 'trace', label: 'Trace', Comp: TraceView },
  { key: 'substrate', label: 'Substrate', Comp: SubstratePanel },
  { key: 'policy', label: 'Policy', Comp: PolicyPanel },
]

export function CockpitView({
  onClose,
  initial,
  mode,
}: {
  onClose: () => void
  initial?: string
  mode?: string
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const found = initial ? TABS.findIndex(t => t.key === initial) : -1
  const [idx, setIdx] = useState(found >= 0 ? found : 0)
  const { refreshedAt } = useTelemetry()
  const now = useNowTick()
  const pastOpenEvent = useOpenEventGate()
  const N = TABS.length
  const { rows: termRows, columns: termCols } = useTerminalSize()
  const slot = useModalOrTerminalSize({ rows: termRows, columns: termCols })
  const insideModal = useIsInsideModal()
  const bodyRef = useRef<ScrollBoxHandle>(null)
  const bodyBoxRef = useRef<DOMElement | null>(null)
  const [bodyOverflows, setBodyOverflows] = useState(false)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const box = bodyBoxRef.current
    if (!body || !box) return
    const viewport = measureElement(box).height
    const overflows = viewport > 0 && body.getFreshScrollHeight() > viewport
    if (overflows !== bodyOverflows) setBodyOverflows(overflows)
  })
  const modalScrollRef = useModalScrollRef()
  useLayoutEffect(() => {
    if (!modalScrollRef) return
    modalScrollRef.current = bodyRef.current
    return () => {
      modalScrollRef.current = null
    }
  }, [modalScrollRef])
  const bodyScrolls = TABS[idx]!.key !== 'fleet'
  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (bodyScrolls && bodyOverflows && (key.upArrow || key.downArrow)) {
      bodyRef.current?.scrollBy(key.upArrow ? -1 : 1)
      return
    }
    if (key.tab && key.shift) {
      setIdx(i => (i - 1 + N) % N)
      return
    }
    if (key.tab || key.rightArrow) {
      setIdx(i => (i + 1) % N)
      return
    }
    if (key.leftArrow) {
      setIdx(i => (i - 1 + N) % N)
      return
    }
    if (input === 'r' && pastOpenEvent()) {
      pokeTelemetry()
      return
    }
    const digit = Number(input)
    if (Number.isInteger(digit) && digit >= 1 && digit <= N) {
      setIdx(digit - 1)
      return
    }
  })

  const Active = TABS[idx]!.Comp
  const dir = pathTailLabel(useCwdState())
  const footerText = packFooter(
    [
      dir,
      'tab/←→ switch',
      `1-${N} jump`,
      ...(bodyScrolls && bodyOverflows ? ['↑↓ scroll'] : []),
      'r refresh',
      `updated ${formatFreshness(now, refreshedAt)}`,
      'esc close',
    ].join(' · '),
    Math.max(0, slot.columns - 4),
  )

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderStrong}
      paddingX={1}
      {...(insideModal ? { maxHeight: slot.rows, overflow: 'hidden' as const } : {})}
    >
      {
}
      {
}
      <Box flexShrink={0} flexDirection="column">
        <ProductLockup view="cockpit" />
      </Box>

      {
}
      <Box marginTop={1} flexShrink={0}>
        {TABS.map((t, i) => (
          <TabChip
            key={t.key}
            label={t.label}
            active={i === idx}
            accent={accent}
            onClick={() => setIdx(i)}
          />
        ))}
      </Box>

      {
}
      <Box ref={bodyBoxRef} marginTop={1} flexDirection="column" flexShrink={1} minHeight={0}>
        {insideModal ? (
          <ScrollBox ref={bodyRef} flexDirection="column" flexGrow={1}>
            <CockpitEmbeddedContext.Provider value={true}>
              <Active onClose={onClose} mode={mode} />
            </CockpitEmbeddedContext.Provider>
          </ScrollBox>
        ) : (
          <CockpitEmbeddedContext.Provider value={true}>
            <Active onClose={onClose} mode={mode} />
          </CockpitEmbeddedContext.Provider>
        )}
      </Box>

      <Box marginTop={1} flexShrink={0}>
        <Text color={FAINT} wrap="truncate-end">
          {footerText}
        </Text>
      </Box>
    </Box>
  )
}
