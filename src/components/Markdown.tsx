import stripAnsi from 'strip-ansi'
import React, { useMemo, useState } from 'react'
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
import { notBuilt } from '../pi/holes.js'


const TOKEN_CACHE_LIMIT = 500

function useCliHighlight(disabled: boolean): CliHighlight | null {
  const [highlight, setHighlight] = useState<CliHighlight | null>(null)
  useLoad(() => {
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

export function Markdown(arg0: {
  children: string
  dimColor?: boolean
  color?: string
  leadingInline?: React.ReactNode
  trailingInline?: React.ReactNode
}): React.ReactNode {
  return notBuilt('src/components/Markdown.tsx:111')
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

export function StreamingMarkdown(arg0: {
  children: string
  leadingInline?: React.ReactNode
  color?: string
}): React.ReactNode {
  return notBuilt('src/components/Markdown.tsx:268')
}

export default Markdown
