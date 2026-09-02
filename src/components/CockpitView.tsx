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

// ============================================================================
//  CockpitView — the "One Operator Tower": ONE shared command-center shell that
//  hosts the operator surfaces as TABS you flip between with Tab / ←→ (zero
//  reopen), esc to close. Each surface renders body-only via
//  CockpitEmbeddedContext (the tower owns the border/header/footer + all input),
//  so there is no double-chrome and no competing esc/← handler.
//
//  v1 hosts the 5 STATIC surfaces (Deck · Fleet · Trace · Substrate · Policy).
//  Deck/Trace/Substrate/Policy have no inner useInput; FleetMonitor has a row-nav
//  useInput but gates its esc/←→onClose on CockpitEmbeddedContext, so when hosted
//  it does NOT consume the tower's close/switch keys (only ↑↓/r stay live).
//  /monitor (NavigablePanes, arrow-navigable) stays standalone for now: its own
//  Tab/← nav would fight the tower's.
// ============================================================================

type Tab = {
  key: string
  label: string
  Comp: React.ComponentType<{ onClose: () => void; mode?: string }>
}

// One tab chip: active = tokens.surface2 fill + accent ▸ + IVORY-bold label;
// inactive = FAINT, warming to SECOND under the pointer.: rides the
// ONE kernel (directActivate — a tab is a single-purpose control); hover
// carries through the function child.
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
  /** Optional starting tab key (e.g. 'fleet'); defaults to the first tab. */
  initial?: string
  /** Live permission mode, threaded to the Policy tab (PolicyPanel). */
  mode?: string
}): React.ReactNode {
  // accent stays on the active tab's ▸ caret; the shell border is structure
  //
  const accent = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const found = initial ? TABS.findIndex(t => t.key === initial) : -1
  const [idx, setIdx] = useState(found >= 0 ? found : 0)
  // The tower subscribes to the shared telemetry bus so its footer can say
  // how fresh the hosted vitals are, and `r` forces a refresh (trust-cockpit
  // W2a). useNowTick keeps the stamp moving between refreshes.
  const { refreshedAt } = useTelemetry()
  const now = useNowTick()
  // NAV keys (esc/tab/←→) stay unbuffered: the idle-parked-commits doctrine
  // says they respond IMMEDIATELY (the old setTimeout→setState `ready` flag
  // gated ALL of them and could swallow the first keypress for seconds when
  // the commit parked — §STALE-PAINT; swept).
  // Only `r` — the one ACTION key — waits out the mount-timestamp buffer so
  // the keystroke that launched /cockpit can't fire it.
  const pastOpenEvent = useOpenEventGate()
  const N = TABS.length
  // The tower is hosted by the modal slot, so its height budget is the
  // slot's inner rows and its width the slot's inner columns — never the
  // raw terminal size. Sized from the terminal, a 24- or 30-row viewport
  // pushed the footer (every exit key) and the bottom border off-screen;
  // the body is the one region that yields, inside a scroll viewport. The
  // inline (sequential) path has native scrollback and takes no cap.
  const { rows: termRows, columns: termCols } = useTerminalSize()
  const slot = useModalOrTerminalSize({ rows: termRows, columns: termCols })
  const insideModal = useIsInsideModal()
  const bodyRef = useRef<ScrollBoxHandle>(null)
  const bodyBoxRef = useRef<DOMElement | null>(null)
  // Measured after layout (the rail-height idiom): the scroll hint is
  // advertised only while the body genuinely overflows its viewport.
  const [bodyOverflows, setBodyOverflows] = useState(false)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const box = bodyBoxRef.current
    if (!body || !box) return
    const viewport = measureElement(box).height
    const overflows = viewport > 0 && body.getFreshScrollHeight() > viewport
    if (overflows !== bodyOverflows) setBodyOverflows(overflows)
  })
  // The slot's scroll route: while a modal is up the ONE scroll handler
  // (PageUp/PageDown, ctrl+home/end, the wheel) targets the handle the
  // modal registers here — unbound, those keys land nowhere.
  const modalScrollRef = useModalScrollRef()
  useLayoutEffect(() => {
    if (!modalScrollRef) return
    modalScrollRef.current = bodyRef.current
    return () => {
      modalScrollRef.current = null
    }
  }, [modalScrollRef])
  // ↑↓ scroll the body by a row on the tabs that do not own the arrows
  // (Fleet's row-nav keeps them).
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
    // Digit jump: 1..N lands directly on that
    // tab — no cycling through the strip. Bounded to the real tab count so
    // stray digits are inert.
    const digit = Number(input)
    if (Number.isInteger(digit) && digit >= 1 && digit <= N) {
      setIdx(digit - 1)
      return
    }
  })

  const Active = TABS[idx]!.Comp
  // Rides the ground beat (Law 9): the footer's dir chip repaints on a repo
  // pick instead of waiting for the next unrelated re-render.
  const dir = pathTailLabel(useCwdState())
  // The footer packs to the live inner width (the CommandCenter law): the
  // close hint is reserved, optional segments shed from the right — a long
  // dir name would otherwise truncate `esc close` itself away at 80 columns.
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
    // No width="100%" (the SectionHeader rule in the kit): a percent width
    // resolves against the host's padded box and pushed the right border
    // off-screen; a column child stretches to the slot's inner width. The
    // height cap is the slot's row budget — the frame, tab strip and footer
    // keep their rows, the body yields. Spread, never maxHeight={undefined}:
    // the style applier keys on `'maxHeight' in style`, and an explicit
    // undefined lands as a cap of 0 — the tower vanished on the inline path.
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderStrong}
      paddingX={1}
      {...(insideModal ? { maxHeight: slot.rows, overflow: 'hidden' as const } : {})}
    >
      {/* THE shared lockup (UN-23; ramped main-header title since the
          ruling) — replaces this file's hand-composed copy (which
          still carried a fixed-FAINT view label from before the token layer). */}
      {/* Header, tab strip and footer never shrink (Box defaults to
          flexShrink 1, and under the height cap a one-row strip shrinks to
          nothing); only the body region below yields. */}
      <Box flexShrink={0} flexDirection="column">
        <ProductLockup view="cockpit" />
      </Box>

      {/* tab strip — REAL chips: the active tab sits on
          a tokens.surface2 fill with the accent ▸ caret (a physical tab, not a
          colored word); inactive tabs are FAINT and warm to SECOND on hover.
          Each tab is click-selectable (setIdx) as well as tab/←→ driven. The
          shell converged from the old left-rail-only border to the round
          CommandCenter chrome — ONE shell language across command surfaces. */}
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

      {/* active surface, body-only (embedded) — inside the modal slot the
          one region that yields to a short viewport: a bounded scroll
          viewport (wheel; ↑↓ on the tabs that do not own the arrows), never
          an overrun of the footer. Inline the body flows into scrollback. */}
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
