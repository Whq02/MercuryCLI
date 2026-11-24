import { isTopOverlayNow, useRegisterOverlay } from '../overlays/overlayHooks.js';
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../effects/effects.js'
import { Box, Text, useInput } from '../themedRenderer.js'
import type { SuggestionItem } from './ComposerFooterSuggestions.js'
import TextInput from './text-input/TextInput.js'
import { CommandCenter, EmptyState } from '../widgets/components.js'
import { displayWidth, GLYPH, truncateToWidth } from '../theme/glyphs.js'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { applyNavMotion, decodeNavKey } from '../widgets/navSemantics.js'
import { cockpitBottomSlotReserve, viewportRows } from '../widgets/geometry.js'
import { useOpenEventGate } from '../widgets/useOpenEventGate.js'


type FileLoader = (query: string) => Promise<SuggestionItem[]>

export function runFileOpenLoad(
  query: string,
  loadFiles: FileLoader,
): Promise<{ results: SuggestionItem[]; error: string | null }> {
  return loadFiles(query)
    .then(results => ({ results, error: null }))
    .catch((error: unknown) => ({
      results: [],
      error: `could not list files (${error instanceof Error ? error.message : String(error)}) — edit the filter or retry`,
    }))
}

const defaultLoadFiles: FileLoader = async query => {
  const { generateFileSuggestions } = await import('./typeahead/fileSuggestions.js')
  return generateFileSuggestions(query, true)
}

const PATH_WIDTH = 52
const QUERY_WIDTH = 56
const MAX_ROWS = 12
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
  loadFiles?: FileLoader
}): React.ReactNode {
  const overlayToken = useRegisterOverlay('file-open');
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const termRows = useTerminalSize().rows
  const cockpitActive = React.useContext(CockpitActiveContext)
  const rowCap = viewportRows(termRows, {
    reserve: cockpitActive ? cockpitBottomSlotReserve(termRows) : HEIGHT_RESERVE,
    min: MIN_ROWS,
    cap: MAX_ROWS,
  })
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(0)
  const [results, setResults] = useState<SuggestionItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const genRef = useRef(0)

  useLoad(signal => {
    setResults(null)
    setLoadError(null)
    const gen = ++genRef.current
    void runFileOpenLoad(query, loadFiles).then(outcome => {
      if (signal.aborted || gen !== genRef.current) return
      setResults(outcome.results)
      setLoadError(outcome.error)
    })
  }, [query, loadFiles])

  const listRows = (results?.length ?? 0) > rowCap ? Math.max(1, rowCap - 1) : rowCap
  const shown = useMemo(() => (results ?? []).slice(0, listRows), [results, listRows])
  const loading = results === null
  const footer = loading
    ? 'indexing files…'
    : loadError !== null
      ? loadError
      : `${results?.length ?? 0} ${(results?.length ?? 0) === 1 ? 'file' : 'files'} · ↑↓ move · ↵ insert @path`

  const pastOpenEvent = useOpenEventGate()

  const clampedSel = Math.min(sel, Math.max(0, shown.length - 1))
  if (sel !== clampedSel) setSel(clampedSel)

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
        const target = applyNavMotion(action, clampedSel, shown.length, { orientation: 'vertical' })
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
        <TextInput
          value={query}
          onChange={q => {
            setQuery(q.replace(/[\r\n\t]+/g, ' '))
            setSel(0)
          }}
          onSubmit={() => {
            if (!pastOpenEvent()) return
            const it = shown[clampedSel]
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
      ) : loadError !== null ? (
        <Box marginTop={1}>
          <Text color={tokens.warning}>{loadError}</Text>
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
            const here = i === clampedSel
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
