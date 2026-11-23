import stripAnsi from 'strip-ansi'
import React, { useMemo, useRef, useState } from 'react'
import type { Token, Tokens } from 'marked'
import { marked } from 'marked'
import { Box, Text } from '../ink.js'
import { useLoad } from '../hooks/effects.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useAppState } from '../state/AppState.js'
import {
  configureMarked,
  formatToken,
  hasMarkdownMarkers,
} from '../utils/markdown.js'
import { stripPromptXMLTags, stripPromptXMLTagsKeepEdges } from '../services/messages.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { hashContent } from '../utils/hash.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../utils/cliHighlight.js'
import { MarkdownTable } from './MarkdownTable.js'
const TOKEN_CACHE_LIMIT = 500
const tokenCache = new Map<string, Token[]>()

function lexMarkdown(text: string): Token[] {
  const key = hashContent(text)
  const cached = tokenCache.get(key)
  if (cached !== undefined) {
    tokenCache.delete(key)
    tokenCache.set(key, cached)
    return cached
  }
  configureMarked()
  const tokens = marked.lexer(text)
  tokenCache.set(key, tokens)
  if (tokenCache.size > TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value
    if (oldest !== undefined) tokenCache.delete(oldest)
  }
  return tokens
}
function useCliHighlight(disabled: boolean): CliHighlight | null {
  const [highlight, setHighlight] = useState<CliHighlight | null>(null)
  useLoad(signal => {
    if (disabled) return
    void getCliHighlightPromise().then(api => {
      if (!signal.aborted && api) setHighlight(api)
    })
  }, [disabled])
  return disabled ? null : highlight
}

function stripControls(text: string): string {
  return stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

type Rendered = { elements: React.ReactNode[]; firstIsProse: boolean }

type MarkdownBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'table'; token: Tokens.Table }

function buildMarkdownBlocks(
  cleaned: string,
  theme: Parameters<typeof formatToken>[1],
  highlight: CliHighlight | null,
): MarkdownBlock[] {
  if (!hasMarkdownMarkers(cleaned)) {
    const trimmed = cleaned.trim()
    return trimmed === '' ? [] : [{ kind: 'prose', text: trimmed }]
  }
  const tokens = lexMarkdown(cleaned)
  const blocks: MarkdownBlock[] = []
  let proseBuf = ''
  const flushProse = (): void => {
    const trimmed = proseBuf.trim()
    if (trimmed !== '') blocks.push({ kind: 'prose', text: trimmed })
    proseBuf = ''
  }
  for (const token of tokens) {
    if (token.type === 'table') {
      flushProse()
      blocks.push({ kind: 'table', token: token as Tokens.Table })
    } else {
      proseBuf += formatToken(token, theme, 0, null, null, highlight)
    }
  }
  flushProse()
  return blocks
}

function renderBlocks(
  blocks: readonly MarkdownBlock[],
  textColor: string,
  dimColor: boolean,
  highlight: CliHighlight | null,
  leadingInline: React.ReactNode,
  trailingInline: React.ReactNode,
): Rendered {
  const firstIsProse = blocks.length > 0 && blocks[0]!.kind === 'prose'
  const lastIsProse =
    blocks.length > 0 && blocks[blocks.length - 1]!.kind === 'prose'
  const hasLeading =
    leadingInline !== undefined && leadingInline !== null && leadingInline !== false
  const hasTrailing =
    trailingInline !== undefined &&
    trailingInline !== null &&
    trailingInline !== false

  const elements: React.ReactNode[] = []
  if (hasLeading && !firstIsProse) {
    elements.push(
      <Text key="leading" color={textColor} dimColor={dimColor} wrap="wrap">
        {leadingInline}
      </Text>,
    )
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.kind === 'table') {
      elements.push(
        <MarkdownTable key={`t-${i}`} token={block.token} highlight={highlight} />,
      )
    } else {
      const includeLeading = i === 0 && hasLeading
      const includeTrailing = i === blocks.length - 1 && hasTrailing
      elements.push(
        <Text key={`p-${i}`} color={textColor} dimColor={dimColor} wrap="wrap">
          {includeLeading ? leadingInline : null}
          {block.text}
          {includeTrailing ? trailingInline : null}
        </Text>,
      )
    }
  }
  if (hasTrailing && !lastIsProse) {
    elements.push(
      <Text key="trailing" color={textColor} dimColor={dimColor} wrap="wrap">
        {trailingInline}
      </Text>,
    )
  }
  return { elements, firstIsProse }
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
  trailingInline?: React.ReactNode
}): React.ReactNode {
  const [theme] = useTheme()
  const accent = useSessionAccent()
  const syntaxOff = useAppState(s => s.settings.view?.syntaxOff) === true
  const highlight = useCliHighlight(syntaxOff)
  const textColor = color ?? 'text'

  const cleaned = useMemo(
    () => stripPromptXMLTags(stripControls(children)),
    [children],
  )

  const blocks = useMemo(
    () => buildMarkdownBlocks(cleaned, theme, highlight),
    [cleaned, theme, accent.accent, highlight],
  )

  if (blocks.length === 0) {
    if (
      leadingInline !== undefined &&
      leadingInline !== null &&
      leadingInline !== false
    ) {
      return (
        <Text color={textColor} dimColor={dimColor} wrap="wrap">
          {leadingInline}
        </Text>
      )
    }
    return null
  }

  const { elements } = renderBlocks(
    blocks,
    textColor,
    dimColor,
    highlight,
    leadingInline,
    trailingInline,
  )

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  )
}

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
  if (last.type === 'table') return 1
  let tail = formatToken(last, theme, 0, null, null, null)
  for (const spaceToken of trailingSpaces) {
    tail += formatToken(spaceToken, theme, 0, null, null, null)
  }
  const run = tail.match(/\n*$/)?.[0]?.length ?? 0
  return Math.max(0, run - 1)
}

export function pendingRowsOf(live: string): number {
  const m = live.match(/((?:\n[ \t]*)+)$/)
  if (!m) return 0
  const rows = (m[1]!.match(/\n/g) ?? []).length
  return Math.min(rows, 2)
}

const STREAM_CARET = '▍'

export function StreamingMarkdown({
  children,
  leadingInline,
  color,
}: {
  children: string
  leadingInline?: React.ReactNode
  color?: string
}): React.ReactNode {
  const [theme] = useTheme()
  const stripped = stripPromptXMLTagsKeepEdges(stripControls(children))
  const progressRef = useRef<{ stable: string; seam: number }>({
    stable: '',
    seam: 0,
  })

  let boundary = progressRef.current.stable.length
  if (!stripped.startsWith(progressRef.current.stable)) {
    boundary = 0
  }
  boundary = advanceStableBoundary(stripped, boundary)
  const stable = stripped.slice(0, boundary)
  let seam = progressRef.current.seam
  if (stable !== progressRef.current.stable) {
    seam = stable === '' ? 0 : computeSeamRows(stable, theme)
    progressRef.current = { stable, seam }
  }
  const live = stripped.slice(boundary)

  const hasStable = stable !== ''
  const liveHasText = live.trim() !== ''
  const caretArmed = flagEnabled('MERCURY_STREAM_CARET')
  const headRun = (live.match(/[ \t]*$/)?.[0] ?? '').slice(0, 40)
  const caretOnHeadRow =
    caretArmed && (/(?:\n[ \t]*)$/.test(live) || !liveHasText)
  const pendingRows = liveHasText
    ? caretOnHeadRow
      ? Math.max(0, pendingRowsOf(live) - 1)
      : pendingRowsOf(live)
    : 0

  if (!hasStable && !liveHasText && !caretOnHeadRow) {
    return null
  }

  return (
    <Box flexDirection="column">
      {hasStable ? (
        <Markdown leadingInline={leadingInline} color={color}>
          {stable}
        </Markdown>
      ) : null}
      {hasStable && (liveHasText || caretOnHeadRow) && seam > 0 ? (
        <Box height={seam} />
      ) : null}
      {liveHasText ? (
        <Markdown
          leadingInline={hasStable ? undefined : leadingInline}
          trailingInline={
            caretArmed && !caretOnHeadRow ? (
              <>
                {headRun}
                <Text dimColor>{STREAM_CARET}</Text>
              </>
            ) : undefined
          }
          color={color}
        >
          {live}
        </Markdown>
      ) : null}
      {pendingRows > 0 ? <Box height={pendingRows} /> : null}
      {caretOnHeadRow ? (
        <Text dimColor>{`${headRun}${STREAM_CARET}`}</Text>
      ) : null}
    </Box>
  )
}

export default Markdown
