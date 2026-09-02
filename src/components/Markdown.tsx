// Markdown rendering for settled transcript prose: a marker-sampled
// fast path that skips the lexer for plain output, a hash-keyed LRU token
// cache (content keys retained full bodies — a measured memory regression),
// table tokens as layout components, and a leading inline nameplate applied
// OUTSIDE the memo so its identity cannot bust the lexer cache.

import stripAnsi from 'strip-ansi'
import React, { useEffect, useMemo, useState } from 'react'
import type { Token, Tokens } from 'marked'
import { marked } from 'marked'
import { Box, Text } from '../ink.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useAppState } from '../state/AppState.js'
import {
  configureMarked,
  formatToken,
  hasMarkdownMarkers,
} from '../utils/markdown.js'
import { stripPromptXMLTags, stripPromptXMLTagsKeepEdges } from '../utils/messages.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { hashContent } from '../utils/hash.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../utils/cliHighlight.js'
import { MarkdownTable } from './MarkdownTable.js'

// The marker gate (utils/markdown.js) scans the WHOLE text — one linear
// regex pass, orders cheaper than the lexer it skips. The 500-char sample
// it replaced unrendered every message whose markdown began past the
// sample.

// ── the token cache: hash-keyed, LRU-promoted, bounded ─────────────────────
const TOKEN_CACHE_LIMIT = 500
const tokenCache = new Map<string, Token[]>()

function lexCached(stripped: string): Token[] {
  configureMarked()
  const key = hashContent(stripped)
  const hit = tokenCache.get(key)
  if (hit) {
    // Promote to most-recently-used.
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(stripped)
  tokenCache.set(key, tokens)
  if (tokenCache.size > TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value
    if (oldest !== undefined) tokenCache.delete(oldest)
  }
  return tokens
}

/** The lazily-loaded highlighter; the same body renders unhighlighted while
 *  it loads. Disabled in settings ⇒ the loader is skipped entirely. */
function useCliHighlight(disabled: boolean): CliHighlight | null {
  const [highlight, setHighlight] = useState<CliHighlight | null>(null)
  useEffect(() => {
    if (disabled) return
    let live = true
    void getCliHighlightPromise().then(api => {
      if (live && api) setHighlight(api)
    })
    return () => {
      live = false
    }
  }, [disabled])
  return disabled ? null : highlight
}

type Rendered = { elements: React.ReactNode[]; firstIsProse: boolean }

function renderTokens(
  tokens: Token[],
  themeName: Parameters<typeof formatToken>[1],
  highlight: CliHighlight | null,
  dimColor: boolean,
  color: string | undefined,
): Rendered {
  const elements: React.ReactNode[] = []
  let pending = ''
  let firstIsProse: boolean | null = null

  const flush = (): void => {
    const trimmed = pending.trim()
    pending = ''
    // A whitespace-only segment is dropped, never emitted: a zero-height
    // element still attracts the column gap and paints a phantom blank row.
    if (trimmed === '') return
    if (firstIsProse === null) firstIsProse = true
    elements.push(
      <Text
        key={`text-${elements.length}`}
        color={color ?? 'text'}
        dimColor={dimColor}
        wrap="wrap"
      >
        {trimmed}
      </Text>,
    )
  }

  for (const token of tokens) {
    if (token.type === 'table') {
      flush()
      if (firstIsProse === null) firstIsProse = false
      elements.push(
        <MarkdownTable
          key={`table-${elements.length}`}
          token={token as Tokens.Table}
          highlight={highlight}
        />,
      )
      continue
    }
    pending += formatToken(token, themeName, 0, null, null, highlight)
  }
  flush()
  return { elements, firstIsProse: firstIsProse ?? true }
}

export function Markdown({
  children,
  dimColor = false,
  color,
  leadingInline,
  trailingInline,
}: {
  children: string
  dimColor?: boolean
  color?: string
  leadingInline?: React.ReactNode
  /** Appended INSIDE the last prose/code element's wrap flow (the write-head
   *  caret while streaming); after a trailing non-text block (a table) it
   *  becomes its own row. Applied outside the memo, exactly like
   *  leadingInline, so its identity cannot bust the lexer cache. */
  trailingInline?: React.ReactNode
}): React.ReactNode {
  const [themeName] = useTheme()
  // The accent is a MEMO DEPENDENCY: the theme name alone does not change
  // when the accent does, and historical markdown must not keep a stale
  // accent.
  const { accent } = useSessionAccent()
  const highlightingDisabled = useAppState(
    state => state.settings.syntaxHighlightingDisabled === true,
  )
  const highlight = useCliHighlight(highlightingDisabled)

  const { elements, firstIsProse } = useMemo<Rendered>(() => {
    // Persisted control bytes replay INERT: a historical OSC/CSI/C0 in the
    // source text must never reach the terminal (title writes, 2J clears,
    // OSC 52 clipboard exfil). Escapes are stripped at the source boundary;
    // newline and tab survive.
    const sanitized = stripAnsi(children).replace(
      // eslint-disable-next-line no-control-regex -- the control filter is the point
      /[\u0000-\u0008\u000b-\u001f\u007f]/g,
      '',
    )
    const stripped = stripPromptXMLTags(sanitized)
    if (!hasMarkdownMarkers(stripped)) {
      // One paragraph, NOT cached: reconstruction is one allocation and
      // caching would retain the content several times over.
      const trimmed = stripped.trim()
      return {
        elements:
          trimmed === ''
            ? []
            : [
                <Text key="plain" color={color ?? 'text'} dimColor={dimColor} wrap="wrap">
                  {trimmed}
                </Text>,
              ],
        firstIsProse: true,
      }
    }
    return renderTokens(lexCached(stripped), themeName, highlight, dimColor, color)
  }, [children, dimColor, color, highlight, themeName, accent])

  if (elements.length === 0) {
    return leadingInline ? <Text>{leadingInline}</Text> : null
  }

  // The trailing inline node rides the LAST prose/code element's own wrap
  // flow so the write head sits where the next glyph will land; a trailing
  // table (no inline flow to join) gets it as one row below. New array —
  // the memoized elements stay untouched across renders.
  let flowElements = elements
  if (trailingInline) {
    const last = elements[elements.length - 1]
    if (
      React.isValidElement(last) &&
      last.type === Text
    ) {
      const el = last as React.ReactElement<{ children?: React.ReactNode }>
      flowElements = [
        ...elements.slice(0, -1),
        React.cloneElement(el, {}, el.props.children, trailingInline),
      ]
    } else {
      flowElements = [
        ...elements,
        <Text key="trailing-inline">{trailingInline}</Text>,
      ]
    }
  }

  // The leading inline node shares the FIRST prose element's wrap flow (a
  // gutter column would hang every continuation line); before a non-inline
  // first block it becomes its own line. Applied outside the memo.
  if (leadingInline) {
    const [first, ...rest] = flowElements
    if (firstIsProse) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={color ?? 'text'} dimColor={dimColor} wrap="wrap">
            {leadingInline}
            {(first as React.ReactElement<{ children?: React.ReactNode }>).props
              ?.children ?? first}
          </Text>
          {rest}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text>{leadingInline}</Text>
        {flowElements}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {flowElements}
    </Box>
  )
}

// ── streaming ──────────────────────────────────────────────────────────────

/** Advance the stable boundary to the last completed top-level block: lex
 *  only the suffix, find the last non-space token, and advance by the raw
 *  lengths of everything before it. Never retreats. A marker-free suffix is
 *  one growing paragraph — the lexer is skipped entirely (this matters at
 *  ~25 publishes/second); the marker test covers the WHOLE suffix because a
 *  code fence can open far past any fixed sample window. */
export function advanceStableBoundary(
  stripped: string,
  boundary: number,
): number {
  const suffix = stripped.slice(boundary)
  if (suffix === '') return boundary
  if (!hasMarkdownMarkers(suffix)) return boundary
  configureMarked()
  const tokens = marked.lexer(suffix)
  let lastContentIndex = -1
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i]!.type !== 'space') {
      lastContentIndex = i
      break
    }
  }
  if (lastContentIndex <= 0) return boundary
  let advance = 0
  for (let i = 0; i < lastContentIndex; i++) {
    advance += tokens[i]!.raw.length
  }
  return boundary + advance
}

/** The seam between the settled and live halves must render exactly the
 *  separator the settled single render would produce. Derived from the real
 *  formatter: count the stable half's last block's trailing newline run and
 *  render run − 1 blank rows (never negative); a trailing table separates by
 *  exactly one row (the container gap). */
export function computeSeamRows(
  stablePrefix: string,
  theme: Parameters<typeof formatToken>[1],
): number {
  if (stablePrefix === '') return 0
  configureMarked()
  const tokens = marked.lexer(stablePrefix)
  let last: Token | null = null
  const trailingSpaces: Token[] = []
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i]!.type === 'space') {
      trailingSpaces.unshift(tokens[i]!)
      continue
    }
    last = tokens[i]!
    break
  }
  if (!last) return 0
  // A table renders as an element (no trailing newlines of its own): one
  // separating row.
  if (last.type === 'table') return 1
  // The separator follows the FORMATTED tail: the last painted token's
  // trailing newlines (paragraph '\n', heading '\n\n') plus each trailing
  // space token AS FORMATTED ('\n' per blank-line run, not its raw) paint
  // n-1 blank rows in the settled render.
  let tail = formatToken(last, theme, 0, null, null, null)
  for (const spaceToken of trailingSpaces) {
    tail += formatToken(spaceToken, theme, 0, null, null, null)
  }
  const run = tail.match(/\n*$/)?.[0]?.length ?? 0
  return Math.max(0, run - 1)
}

/** Trailing lines of the live tail that the markdown render drops (the
 *  whitespace-only tail after the last non-blank line), capped so a run of
 *  blank lines cannot grow the pending area unboundedly. */
export function pendingRowsOf(live: string): number {
  const m = live.match(/((?:\n[ \t]*)+)$/)
  if (!m) return 0
  const rows = (m[1]!.match(/\n/g) ?? []).length
  // Cap 2: a fence's blank line + its pending next row both paint; a prose
  // paragraph gap transiently shows at most one extra row before the
  // boundary advance folds it into the stable seam.
  return Math.min(rows, 2)
}

/** The write-head caret (streaming only): U+258D LEFT FIVE EIGHTHS BLOCK —
 *  tall enough to read as a caret, narrower than a full block so it reads as
 *  a write head, never a selection. The settled render re-parses the full
 *  text and never shows it. */
export const STREAM_CARET = '▍'

export function StreamingMarkdown({
  children,
  leadingInline,
}: {
  children: string
  leadingInline?: React.ReactNode
}): React.ReactNode {
  const [themeName] = useTheme()
  // Deliberately reads and writes refs during render: the boundary only
  // moves forward, so a double render lands on the same boundary. This
  // component opts out of automatic memoisation.
  const boundaryRef = React.useRef(0)
  const prefixRef = React.useRef('')
  const seamRef = React.useRef(0)

  // EDGES KEPT (never the trimming strip): the live text's trailing
  // "\n"+indent run is the reveal signal — pendingRowsOf and the write-head
  // caret read it, and a trimmed edge freezes the rendered tail for every
  // whitespace delta (the 96-128ms invisible-beat class measured on the
  // wire; the settled render's own flush still trims for display).
  const stripped = stripPromptXMLTagsKeepEdges(children)
  if (!stripped.startsWith(prefixRef.current)) {
    // Stripping removed more (a closing XML tag arrived): reset and re-lex
    // once.
    boundaryRef.current = 0
    prefixRef.current = ''
    seamRef.current = 0
  }
  boundaryRef.current = advanceStableBoundary(stripped, boundaryRef.current)
  const stable = stripped.slice(0, boundaryRef.current)
  const live = stripped.slice(boundaryRef.current)
  if (stable !== prefixRef.current) {
    prefixRef.current = stable
    seamRef.current = computeSeamRows(stable, themeName)
  }

  // The write head. The reveal's residual invisible class is the trailing
  // whitespace run: after a code line completes, the NEXT line's 2-8 indent
  // spaces arrive over 2-4 publishes, and a row of spaces composes
  // byte-identical to a blank row — nothing painted for 96-128ms against the
  // ux-parity 70ms p99 gap budget (the paint-gap cost centre of the repl
  // overhaul's verification). The caret makes every publish move one REAL
  // cell: inline after the partial line's last glyph while mid-word, at the
  // arriving indent's column on the head row during whitespace runs.
  // ON by default (operator ratified: "keep it on" — smoothness);
  // MERCURY_STREAM_CARET=0 stands it down, restoring the pending-row reveal
  // alone — byte-identical to the pre-caret streaming look.
  const caretArmed = flagEnabled('MERCURY_STREAM_CARET')
  const headRun = (live.match(/[ \t]*$/)?.[0] ?? '').slice(0, 40)
  const caretOnHeadRow =
    caretArmed && (/(?:\n[ \t]*)$/.test(live) || live.trim() === '')
  const caret = (
    <Text color="text" dimColor>
      {STREAM_CARET}
    </Text>
  )
  // The head row replaces the LAST pending row (the write head IS that row);
  // earlier pending rows (a blank line inside a fence) stay blank above it.
  const pendingBlankRows = caretOnHeadRow
    ? Math.max(0, pendingRowsOf(live) - 1)
    : pendingRowsOf(live)

  return (
    <Box flexDirection="column">
      {stable !== '' ? (
        <Markdown leadingInline={leadingInline}>{stable}</Markdown>
      ) : null}
      {stable !== '' && seamRef.current > 0 ? (
        <Box height={seamRef.current} />
      ) : null}
      {live.trim() !== '' ? (
        <Markdown
          leadingInline={stable === '' ? leadingInline : undefined}
          trailingInline={
            caretArmed && !caretOnHeadRow ? (
              <Text>
                {headRun}
                {caret}
              </Text>
            ) : undefined
          }
        >
          {live}
        </Markdown>
      ) : null}
      {/* Pending rows: while streaming, trailing lines the renderer drops
          (an open fence's blank/indent-only tail lines — the lexer trims
          them) each paint as one blank row NOW, so the scroll advances on
          the newline beat instead of holding until the next line's first
          word lands. The settled render re-parses whole and never shows
          them (measured: the trim made ~1 in 7 canonical-stream publishes
          byte-invisible — the 80-120ms stutter beats of the ux-parity
          study; the COUNT matters because a blank code line adds a second
          trailing newline that a binary check cannot see). */}
      {live.trim() !== '' && pendingBlankRows > 0 ? (
        <Box height={pendingBlankRows} />
      ) : null}
      {caretOnHeadRow ? (
        <Text>
          {headRun}
          {caret}
        </Text>
      ) : null}
    </Box>
  )
}

export default Markdown
