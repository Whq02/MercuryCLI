import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { SuggestionItem } from './PromptInput/PromptInputFooterSuggestions.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

// ============================================================================
//  MercuryFileOpen — the warm-ink FILE quick-open (fork). The `@`-file half of the
//  command palette suite: a chord-invoked (ctrl+x f) overlay that fuzzy-finds repo
//  files and INSERTS `@path ` at the cursor (integrates with the existing @-mention
//  system — safe, reversible, no auto-run). Reuses the PROVEN async
//  generateFileSuggestions (the same index inline `@` + the base QuickOpenDialog use),
//  so there's no second file walker to drift or lag. A bare stamp's file quick-open
//  (feature('QUICK_SEARCH')) DCE-folds out of Mercury, so this is Mercury's only
//  one. ONE useInput owns the query + clamped row nav; a 120ms ready-buffer swallows
//  the launching chord's trailing key; an async gen-guard drops stale result sets.
//  Bounded + honest loading/empty states. Flag-gated at the call site.
// ============================================================================

// The heavy file index is loaded LAZILY (dynamic import) so this module stays
// loadable outside the bundler — `generateFileSuggestions` transitively imports a
// `feature()`-macro module that bun-run can't evaluate at static-import time (it's
// fine in the built dist). The dynamic import is bundle-cached → instant in dist,
// and the render-proof injects a mock `loadFiles` so it never touches the real chain.
type FileLoader = (query: string) => Promise<SuggestionItem[]>
const defaultLoadFiles: FileLoader = async query => {
  const { generateFileSuggestions } = await import('../hooks/fileSuggestions.js')
  return generateFileSuggestions(query, true)
}

const PATH_WIDTH = 52
const QUERY_WIDTH = 56
const MAX_ROWS = 12
// The bottom-slot overlay sits under the fixed-height home splash; clamp the list
// to the terminal so it never overflows the alt-screen + clips its own footer.
const HEIGHT_RESERVE = 26
const MIN_ROWS = 4

export function MercuryFileOpen({
  onPick,
  onClose,
  isActive = true,
  loadFiles = defaultLoadFiles,
}: {
  onPick: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
  /** Injectable for the deterministic render-proof; defaults to the real index. */
  loadFiles?: FileLoader
}): React.ReactNode {
  // class kill: register with the overlay registry so
  // PromptInput's isModalOverlayActive covers this surface structurally —
  // the hand-maintained OR-chain is belt-and-suspenders, not the only gate.
  const overlayToken = useRegisterOverlay('file-open');
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
  const [results, setResults] = useState<SuggestionItem[] | null>(null)
  const genRef = useRef(0)

  // Async file lookup, debounced-by-generation: each query bumps genRef; a result
  // set that arrives after a newer query was issued is dropped (no stale flash / no
  // out-of-order clobber). showOnEmpty=true → top files appear immediately on open.
  useEffect(() => {
    const gen = ++genRef.current
    let alive = true
    void loadFiles(query)
      .then(items => {
        if (alive && gen === genRef.current) setResults(items)
      })
      .catch(() => {
        if (alive && gen === genRef.current) setResults([])
      })
    return () => {
      alive = false
    }
  }, [query])

  // The '+N more' line spends one cap row when it renders (LUSTRE L4 — the
  // palette's counter-squeeze law).
  const listRows = (results?.length ?? 0) > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const shown = useMemo(() => (results ?? []).slice(0, listRows), [results, listRows])
  const loading = results === null
  const footer = loading
    ? 'indexing files…'
    : `${results?.length ?? 0} ${(results?.length ?? 0) === 1 ? 'file' : 'files'} · ↑↓ move · ↵ insert @path`

  // Swallow the launching chord's trailing key (ctrl+x f → a stray 'f') so it
  // can't seed the query — as a open-event seq gate (event identity, not wall-clock), not the old
  // setTimeout→setState flag whose parked commit could swallow the first
  // keypress for seconds (§STALE-PAINT idle-parked-commits;
  // swept). esc/arrows respond ungated per the doctrine; only the
  // keys that ACT (↵ · typed/pasted text via the editor's inputFilter) wait
  // out the buffer.
  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, shown.length - 1)))
  }, [shown.length])

  // List nav through the ONE semantic vocabulary; handled keys consumed
  // (MINI-TEMPER item 2). Typing/editing (←→ · Home/End · word chords ·
  // paste · backspace) belongs to the query editor below — declined here.
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
    <CommandCenter view="open file" elevated onClose={onClose} captureInput={false} footer={footer}>
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
            if (it) onPick(`@${it.displayText} `)
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
          placeholder="fuzzy-find a file to reference…"
        />
      </Box>

      {loading ? (
        <Box marginTop={1}>
          <Text color={tokens.textMuted}>scanning the working tree…</Text>
        </Box>
      ) : shown.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState
            title="no files"
            hint={query ? `nothing matches "${truncateToWidth(query, 30)}" — backspace to widen` : 'no files in the working tree'}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {shown.map((it, i) => {
            const here = i === sel
            const p = truncateToWidth(it.displayText, PATH_WIDTH)
            const pad = ' '.repeat(Math.max(0, PATH_WIDTH - displayWidth(p)))
            return (
              <Text key={it.id}>
                <Text color={here ? accent : tokens.textMuted}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
                <Text color={here ? accent : tokens.textSecondary}>@</Text>
                <Text color={here ? tokens.textPrimary : tokens.textSecondary}>{p}</Text>
                {pad}
                {it.description ? <Text color={tokens.textMuted}>{truncateToWidth(it.description, 16)}</Text> : null}
              </Text>
            )
          })}
          {(results?.length ?? 0) > shown.length ? (
            <Text color={tokens.textMuted}>  +{(results?.length ?? 0) - shown.length} more — keep typing to narrow</Text>
          ) : null}
        </Box>
      )}
    </CommandCenter>
  )
}
