import * as React from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { paneWindow } from '../paneWindow.js'
import { padTo } from '../glyphs.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { CommandCenter } from '../components.js'
import { useSessionAccent } from '../sessionAccent.js'
import { truncateToWidth, GLYPH } from '../glyphs.js'
import { useAppStateMaybeOutsideOfProvider } from '../../../state/AppState.js'
import { scribeBusLiveEnabled } from '../../../utils/scribe/scribeGates.js'
import { daemonSnapshot } from '../../../utils/cockpit/daemonSnapshot.js'
import { isScribeModeOn } from '../../../utils/scribeMode.js'
import { userHandle } from '../../messages/TranscriptNameplate.js'
import {
  SCRIBE_CHAT_TABS,
  SCRIBE_CHAT_TAB_LABEL,
  scribeStreamName,
  rowsForTab,
  countForTab,
  buildScribeLedger,
  type ScribeAuthor,
  type ScribeLedgerStatus,
} from '../scribeChatTabs.js'

// ============================================================================
//  ChatTranscriptView — the /chat surface. The LIVE two-stream chat, navigable.
//  Tabs: General · Scribe · Implement · Trace · Ledger. Reads the live transcript
//  (AppState.scribeTranscript, mirrored from the REPL) so it shows the REAL
//  conversation — color-coded by stream (operator [<handle>] / Scribe [Mercury-Amanuensis]
//  / Implementer [Mercury-Implement]) — plus a dispatch→result Ledger derived from
//  the bus envelopes. Self-owned nav (←/→ or [/], 1-5, esc) so it works WITHOUT
//  the fullscreen deck. Honest: when the live bus is off it says so.
// ============================================================================

// The Ledger is a 5th view layered on the 4 message tabs.
const VIEW_TABS = [...SCRIBE_CHAT_TABS, 'ledger'] as const
type ViewTab = (typeof VIEW_TABS)[number]
const VIEW_TAB_LABEL: Record<ViewTab, string> = { ...SCRIBE_CHAT_TAB_LABEL, ledger: 'Ledger' }


function authorColor(a: ScribeAuthor, accent: string): string {
  return a === 'scribe' ? accent : a === 'implement' ? TEAL : SECOND
}

// Ledger status → spine glyph + colour. Glyphs route through the GLYPH vocabulary
// (no raw literals) so a vocab change can't desync this map; `failed` was a raw ×
// (U+00D7, EAW-ambiguous) the kit migrated away from.
const LEDGER_GLYPH: Record<ScribeLedgerStatus, { g: string; c: string }> = {
  dispatched: { g: GLYPH.pending, c: SECOND },
  started: { g: GLYPH.pending, c: SECOND },
  working: { g: GLYPH.inProgress, c: TEAL },
  done: { g: GLYPH.done, c: TEAL },
  blocked: { g: GLYPH.inProgress, c: AMBER },
  failed: { g: GLYPH.fail, c: CRIMSON },
  escalated: { g: GLYPH.fail, c: AMBER },
  superseded: { g: GLYPH.read, c: FAINT },
}

export function ChatTranscriptView({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const [tab, setTab] = React.useState<ViewTab>('general')
  const messages =
    (useAppStateMaybeOutsideOfProvider(
      (s: { scribeTranscript?: unknown[] } | undefined) => s?.scribeTranscript,
    ) as unknown[] | undefined) ?? []
  // Honest three-state banner:
  // the FLAG being on only ARMS the bus — "live" is claimed only when Scribe
  // Mode is actually engaged this session; flag-on-but-not-engaged is "armed".
  const busLive = scribeBusLiveEnabled()
  const scribeEngaged = isScribeModeOn()
  // HONESTY: flag+engaged alone claimed '● live'
  // with a DEAD daemon (the bus-write≠receipt cousin — messages would queue,
  // not flow). Fold in the daemon snapshot, whose 'live' is now RPC-verified.
  const daemonLive = daemonSnapshot().state === 'live'

  const cycle = (dir: 1 | -1) => {
    setSel(null) // a tab switch re-follows that tab's tail
    setTab(prev => {
      const i = VIEW_TABS.indexOf(prev)
      return VIEW_TABS[(i + dir + VIEW_TABS.length) % VIEW_TABS.length]!
    })
  }

  const { columns, rows: termRows } = useTerminalSize()
  const cols = columns || 80
  const innerW = Math.max(32, cols - 8)
  const ledger = tab === 'ledger' ? buildScribeLedger(messages) : []
  // The FULL stream (Sol 5.6 WS6 — the old view hard-capped at the last 14
  // one-line rows): scrollback windows over everything; the tail follows
  // live until the operator scrolls up.
  const rows = tab === 'ledger' ? [] : rowsForTab(messages, tab, 100_000)
  const N = rows.length

  // sel === null ⇒ FOLLOW the tail (live). ↑ detaches into scrollback; ↓ at
  // the tail re-attaches. anchorN remembers the stream length when the
  // operator detached, so the marker can say how many NEW messages arrived.
  const [sel, setSel] = React.useState<number | null>(null)
  const anchorN = React.useRef(0)
  const effSel = sel === null ? Math.max(0, N - 1) : Math.min(sel, Math.max(0, N - 1))
  const newSince = sel !== null ? Math.max(0, N - anchorN.current) : 0

  useInput((input, key) => {
    // ←/→ both navigate tabs (← back, → forward) as the footer + docstring
    // advertise; esc is the sole close key. Binding ← to onClose is the guarded class:
    // the advertised "←→ tabs" half goes dead and ← closes the view.
    if (key.escape) return onClose()
    if (key.rightArrow || key.tab || input === ']' || input === 'l') return cycle(1)
    if (key.leftArrow || input === '[' || input === 'h') return cycle(-1)
    if (key.upArrow) {
      setSel(s => {
        if (s === null) anchorN.current = N
        return Math.max(0, (s ?? N - 1) - 1)
      })
      return
    }
    if (key.downArrow) {
      setSel(s => {
        if (s === null) return null
        const next = s + 1
        return next >= N - 1 ? null : next
      })
      return
    }
    const n = Number.parseInt(input, 10)
    if (Number.isInteger(n) && n >= 1 && n <= VIEW_TABS.length) {
      setSel(null)
      setTab(VIEW_TABS[n - 1]!)
    }
  })

  // Height budget: brand row + tabs + bus line + markers + footer ≈ 10 rows.
  const visible = Math.max(4, Math.min(Math.max(N, 1), (termRows || 24) - 10))
  const win = paneWindow(N, effSel, visible)
  // Stable nameplate column: every row's name pads to one width, so the
  // message column never wobbles as authors change.
  const NAME_W = 16

  return (
    <CommandCenter
      view="chat"
      subtitle="two-stream"
      captureInput={false}
      onClose={onClose}
      footer="1-5 / ←→ tabs · ↑↓ scrollback"
    >
      {/* tab strip — active = accent bold + count; the Ledger sits at the end */}
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          {VIEW_TABS.map((tb, i) => {
            const on = tb === tab
            const n = tb === 'ledger' ? buildScribeLedger(messages).length : countForTab(messages, tb)
            return (
              <Text key={tb}>
                {i > 0 ? <Text color={FAINT}> │ </Text> : null}
                <Text color={FAINT}>{`${i + 1} `}</Text>
                <Text bold={on} color={on ? accent : FAINT}>
                  {VIEW_TAB_LABEL[tb]}
                </Text>
                {n > 0 ? <Text color={on ? accent : FAINT}>{` ${n}`}</Text> : null}
              </Text>
            )
          })}
        </Text>
      </Box>

      {/* honest bus state — explains an empty Implement/Ledger when off/armed */}
      <Box>
        <Text color={busLive && scribeEngaged && daemonLive ? TEAL : FAINT}>
          {busLive
            ? scribeEngaged
              ? daemonLive
                ? '● Implementer bus: live'
                : '◐ Implementer bus: engaged, daemon unreachable — dispatches queue until it returns'
              : '◐ Implementer bus: armed — engage Scribe Mode to connect the Implementer'
            : '○ Implementer bus: off — set MERCURY_SCRIBE_BUS_LIVE=1 to connect the Implementer'}
        </Text>
      </Box>

      {/* body — the live stream for the active tab, or the ledger */}
      <Box marginTop={1} flexDirection="column">
        {tab === 'ledger' ? (
          ledger.length === 0 ? (
            <Text color={FAINT}>
              no dispatches yet — work the Scribe sends to the Implementer logs here
            </Text>
          ) : (
            <>
            {ledger.length > visible ? <Text color={FAINT}>  ↑ {ledger.length - visible} earlier</Text> : null}
            {ledger.slice(-visible).map((e, i) => {
              const m = LEDGER_GLYPH[e.status]
              return (
                <Text key={i} wrap="truncate-end">
                  <Text color={m.c}>{m.g} </Text>
                  <Text color={IVORY}>{truncateToWidth(e.title, innerW - 24)}</Text>
                  <Text color={FAINT}>{`  ${e.status}`}</Text>
                  {e.detail ? <Text color={SECOND}>{` · ${truncateToWidth(e.detail, 28)}`}</Text> : null}
                </Text>
              )
            })}
            </>
          )
        ) : rows.length === 0 ? (
          <Text color={FAINT}>
            {tab === 'implement' ? 'no Implementer messages yet' : 'no messages yet'}
          </Text>
        ) : (
          <>
            {win.above > 0 ? <Text color={FAINT}>  ↑ {win.above} earlier</Text> : null}
            {rows.slice(win.start, win.end).map((r, wi) => {
              const gi = win.start + wi
              const on = gi === effSel
              const name = padTo(truncateToWidth(scribeStreamName(r.author, userHandle()), NAME_W), NAME_W)
              const text = r.text || (r.hasTool ? '· tool call' : '')
              // The SELECTED message renders expanded (full text, wrapped to
              // the terminal); the rest stay one-line with the stable
              // nameplate column.
              return on ? (
                <Box key={gi} flexDirection="column">
                  <Text>
                    <Text color={accent}>{'▸ '}</Text>
                    <Text bold color={authorColor(r.author, accent)}>{name}</Text>
                  </Text>
                  <Box paddingLeft={2} width={innerW}>
                    <Text color={IVORY} wrap="wrap">
                      {text}
                    </Text>
                  </Box>
                </Box>
              ) : (
                <Text key={gi} wrap="truncate-end">
                  <Text color={FAINT}>{'  '}</Text>
                  <Text color={authorColor(r.author, accent)}>{name}</Text>
                  <Text color={IVORY}> {truncateToWidth(text, Math.max(10, innerW - NAME_W - 3))}</Text>
                </Text>
              )
            })}
            {win.below > 0 || newSince > 0 ? (
              <Text color={newSince > 0 ? AMBER : FAINT}>
                {'  '}↓ {win.below} later{newSince > 0 ? ` · ${newSince} new since you scrolled — ↓ to follow` : ''}
              </Text>
            ) : null}
          </>
        )}
      </Box>
    </CommandCenter>
  )
}
