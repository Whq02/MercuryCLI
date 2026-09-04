
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


const TOKEN_CACHE_LIMIT = 500
const tokenCache = new Map<string, Token[]>()

function lexCached(stripped: string): Token[] {
  configureMarked()
  const key = hashContent(stripped)
  const hit = tokenCache.get(key)
  if (hit) {
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
  trailingInline?: React.ReactNode
}): React.ReactNode {
  const [themeName] = useTheme()
  const { accent } = useSessionAccent()
  const highlightingDisabled = useAppState(
    state => state.settings.syntaxHighlightingDisabled === true,
  )
  const highlight = useCliHighlight(highlightingDisabled)

  const { elements, firstIsProse } = useMemo<Rendered>(() => {
    const sanitized = stripAnsi(children).replace(
      // eslint-disable-next-line no-control-regex -- the control filter is the point
      /[\u0000-\u0008\u000b-\u001f\u007f]/g,
      '',
    )
    const stripped = stripPromptXMLTags(sanitized)
    if (!hasMarkdownMarkers(stripped)) {
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

export const STREAM_CARET = '▍'

export function StreamingMarkdown({
  children,
  leadingInline,
  color,
}: {
  children: string
  leadingInline?: React.ReactNode
  color?: string
}): React.ReactNode {
  const [themeName] = useTheme()
  const boundaryRef = React.useRef(0)
  const prefixRef = React.useRef('')
  const seamRef = React.useRef(0)

  const stripped = stripPromptXMLTagsKeepEdges(children)
  if (!stripped.startsWith(prefixRef.current)) {
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

  const caretArmed = flagEnabled('MERCURY_STREAM_CARET')
  const headRun = (live.match(/[ \t]*$/)?.[0] ?? '').slice(0, 40)
  const caretOnHeadRow =
    caretArmed && (/(?:\n[ \t]*)$/.test(live) || live.trim() === '')
  const caret = (
    <Text color="text" dimColor>
      {STREAM_CARET}
    </Text>
  )
  const pendingBlankRows = caretOnHeadRow
    ? Math.max(0, pendingRowsOf(live) - 1)
    : pendingRowsOf(live)

  return (
    <Box flexDirection="column">
      {stable !== '' ? (
        <Markdown leadingInline={leadingInline} color={color}>{stable}</Markdown>
      ) : null}
      {stable !== '' && seamRef.current > 0 ? (
        <Box height={seamRef.current} />
      ) : null}
      {live.trim() !== '' ? (
        <Markdown
          color={color}
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
      {
}
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
