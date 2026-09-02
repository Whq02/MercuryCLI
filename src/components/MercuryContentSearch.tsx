import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import TextInput from './TextInput.js'
import { CommandCenter } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { MercuryThemeTokens } from '../utils/mercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

// ============================================================================
//  MercuryContentSearch — the warm-ink CONTENT search (fork, ctrl+x g). The third
//  quick-open surface: grep file CONTENTS across the repo and INSERT `@file#Lline `
//  at the cursor (a line-anchored @-mention — safe, reversible, never auto-runs).
//  Completes the QUICK_SEARCH suite (command · file · content) Mercury lost to DCE.
//  Reuses the proven ripGrepStream + parseRipgrepLine, loaded LAZILY (dynamic import
//  behind a `loadMatches` prop) so the module stays render-proof loadable. One
//  useInput owns the query + clamped nav; an AbortController + gen-guard cancel/drop
//  stale searches; a 2-char floor keeps grep off noise. Flag-gated at the call site.
// ============================================================================

export type SearchMatch = { file: string; line: number; text: string }
type SearchLoader = (query: string, signal: AbortSignal) => Promise<SearchMatch[]>

const MAX_MATCHES = 200
const MIN_QUERY = 2
const FILE_WIDTH = 34
const QUERY_WIDTH = 56
const MAX_ROWS = 12
const HEIGHT_RESERVE = 26
const MIN_ROWS = 4

// Parse an `rg -n --no-heading` line "path:line:text" → match. Non-greedy file so a
// Windows drive letter ("C:\…") doesn't split early (the `\d+` after the FIRST ':'
// fails on the backslash and backtracks). Inlined (NOT imported from the DCE'd
// GlobalSearchDialog where the upstream copy lives).
function parseRgLine(line: string): SearchMatch | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line)
  if (!m) return null
  const [, file, lineStr, text] = m
  const ln = Number(lineStr)
  if (!file || !Number.isFinite(ln)) return null
  return { file, line: ln, text }
}

// Lazy default: the dynamic import is bundle-cached → instant in dist, and the
// render-proof injects a mock loader so it never touches the real ripgrep chain.
const defaultLoad: SearchLoader = async (query, signal) => {
  const [{ ripGrepStream }, { getCwd }] = await Promise.all([
    import('../utils/ripgrep.js'),
    import('../utils/cwd.js'),
  ])
  // rg with an absolute target prints absolute paths; relativize to the cwd so the
  // rows read cleanly and the inserted mention is `@file#L` not `@/Users/…/file#L`.
  const cwd = getCwd()
  const rel = (f: string) => (f.startsWith(cwd) ? f.slice(cwd.length).replace(/^[/\\]/, '') : f)
  const out: SearchMatch[] = []
  await ripGrepStream(
    ['-n', '--no-heading', '-i', '-m', '4', '-F', '-e', query],
    cwd,
    signal,
    lines => {
      for (const l of lines) {
        if (out.length >= MAX_MATCHES) break
        const m = parseRgLine(l)
        if (m) out.push({ ...m, file: rel(m.file) })
      }
    },
  )
  return out
}

// Bold the matched substring of `text` (case-insensitive) — the same affordance as
// the command palette's name highlight, for grep hits.
function HighlightHit({
  text,
  query,
  here,
  tokens,
}: {
  text: string
  query: string
  here: boolean
  tokens: MercuryThemeTokens
}): React.ReactNode {
  const base = here ? tokens.textPrimary : tokens.textSecondary
  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (idx < 0) return <Text color={base}>{text}</Text>
  return (
    <Text>
      <Text color={base}>{text.slice(0, idx)}</Text>
      <Text color={here ? tokens.accent : tokens.textPrimary} bold>
        {text.slice(idx, idx + query.length)}
      </Text>
      <Text color={base}>{text.slice(idx + query.length)}</Text>
    </Text>
  )
}

export function MercuryContentSearch({
  onPick,
  onClose,
  isActive = true,
  loadMatches = defaultLoad,
}: {
  onPick: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
  /** Injectable for the deterministic render-proof; defaults to the real grep. */
  loadMatches?: SearchLoader
}): React.ReactNode {
  // class kill: register with the overlay registry so
  // PromptInput's isModalOverlayActive covers this surface structurally —
  // the hand-maintained OR-chain is belt-and-suspenders, not the only gate.
  const overlayToken = useRegisterOverlay('content-search');
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const termRows = useTerminalSize().rows
  // The ONE viewport contract (MINI-TEMPER item 4 sibling sweep): the min is
  // aspirational — it can never manufacture rows the terminal lacks.
  // LUSTRE L4: the cockpit bottom slot is HALF the terminal — the flat home
  // reserve over-granted rows there (the same squeeze class the palette had).
  const cockpitActive = React.useContext(CockpitActiveContext)
  const rowCap = viewportRows(termRows, {
    reserve: cockpitActive ? cockpitBottomSlotReserve(termRows) : HEIGHT_RESERVE,
    min: MIN_ROWS,
    cap: MAX_ROWS,
  })
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  // Grapheme cursor for the REAL query editor (MINI-TEMPER item 2).
  const [cursorOffset, setCursorOffset] = useState(0)
  const [matches, setMatches] = useState<SearchMatch[] | null>(null)
  const genRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // Abort the in-flight grep + drop stale result sets (gen-guard). A <2-char query
  // is honest-empty (grep on 1 char is all-noise); no work issued.
  useEffect(() => {
    const gen = ++genRef.current
    abortRef.current?.abort()
    const q = query.trim()
    if (q.length < MIN_QUERY) {
      setMatches([])
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    let alive = true
    setMatches(null)
    void loadMatches(q, controller.signal)
      .then(items => {
        if (alive && gen === genRef.current) setMatches(items)
      })
      .catch(() => {
        if (alive && gen === genRef.current) setMatches([])
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [query, loadMatches])

  // The '+N more' line spends one cap row when it renders (LUSTRE L4 — the
  // palette's counter-squeeze law).
  const listRows = (matches?.length ?? 0) > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const shown = useMemo(() => (matches ?? []).slice(0, listRows), [matches, listRows])
  const searching = matches === null
  const tooShort = query.trim().length < MIN_QUERY
  const hitCount = matches?.length ?? 0
  const footer = tooShort
    ? 'type ≥2 chars to grep file contents'
    : searching
      ? 'searching…'
      : `${hitCount}${hitCount >= MAX_MATCHES ? '+' : ''} ${hitCount === 1 ? 'hit' : 'hits'} · ↑↓ move · ↵ insert @file#L`

  // Swallow the launching chord's trailing key (ctrl+x g → a stray 'g') so it
  // can't seed the query — as a open-event seq gate (event identity, not wall-clock), not the old
  // setTimeout→setState flag whose parked commit could swallow the first
  // keypress for seconds (§STALE-PAINT idle-parked-commits;
  // swept). esc/arrows respond ungated per the doctrine; only the
  // keys that ACT (↵ · backspace · typing) wait out the buffer.
  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, shown.length - 1)))
  }, [shown.length])

  // List nav through the ONE semantic vocabulary; handled keys consumed
  // (MINI-TEMPER item 2). Typing/editing belongs to the query editor below.
  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical' })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action === 'movePrevious' || action === 'moveNext') {
        event.stopImmediatePropagation()
        const target = applyNavMotion(action, sel, shown.length, { orientation: 'vertical' })
        if (target !== null) setSel(target)
        return
      }
    },
    { isActive },
  )

  return (
    <CommandCenter view="search" elevated onClose={onClose} captureInput={false} footer={footer}>
      <Box marginTop={1}>
        <Text color={accent}>{GLYPH.prompt} </Text>
        {/* The query is Mercury's ONE editor machinery (MINI-TEMPER item 2) —
            same contract as the command palette's field. */}
        <TextInput
          value={query}
          onChange={q => {
            setQuery(q.replace(/[\r\n\t]+/g, ' '))
            setSel(0)
          }}
          onSubmit={() => {
            if (!pastOpenEvent()) return
            const it = shown[Math.min(sel, Math.max(0, shown.length - 1))]
            if (it) onPick(`@${it.file}#L${it.line} `)
          }}
          focus={isActive}
          showCursor={true}
          multiline={false}
          disableCursorMovementForUpDownKeys={true}
          disableEscapeDoublePress={true}
          disablePageKeyCursorMovement={true}
          inputFilter={input => (pastOpenEvent() ? input : '')}
          columns={QUERY_WIDTH}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          placeholder="grep the working tree for…"
        />
      </Box>

      {tooShort ? (
        <Box marginTop={1}>
          <Text color={tokens.textMuted}>keep typing — content search needs at least 2 characters</Text>
        </Box>
      ) : searching ? (
        <Box marginTop={1}>
          <Text color={tokens.textMuted}>scanning file contents…</Text>
        </Box>
      ) : shown.length === 0 ? (
        <Box marginTop={1}>
          <Text color={tokens.textMuted}>no matches for "{truncateToWidth(query, 30)}" — backspace to widen</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {shown.map((it, i) => {
            const here = i === sel
            const loc = `${truncateToWidth(it.file, FILE_WIDTH)}:${it.line}`
            const pad = ' '.repeat(Math.max(0, FILE_WIDTH + 6 - displayWidth(loc)))
            return (
              <Text key={`${it.file}:${it.line}:${i}`}>
                <Text color={here ? accent : tokens.textMuted}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
                <Text color={here ? tokens.textPrimary : tokens.textSecondary}>{loc}</Text>
                {pad}
                <HighlightHit text={truncateToWidth(it.text.trimStart(), 40)} query={query.trim()} here={here} tokens={tokens} />
              </Text>
            )
          })}
          {hitCount > shown.length ? (
            <Text color={tokens.textMuted}>  +{hitCount - shown.length} more — keep typing to narrow</Text>
          ) : null}
        </Box>
      )}
    </CommandCenter>
  )
}
