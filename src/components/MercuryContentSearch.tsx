import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useLoad } from '../hooks/effects.js'
import TextInput from './TextInput.js'
import { CommandCenter } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from '../utils/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { MercuryThemeTokens } from '../utils/mercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { notBuilt } from '../pi/holes.js'


type SearchMatch = { file: string; line: number; text: string }
type SearchLoader = (query: string, signal: AbortSignal) => Promise<SearchMatch[]>

export function runContentSearch(
  query: string,
  signal: AbortSignal,
  loadMatches: SearchLoader,
): Promise<{ matches: SearchMatch[]; error: string | null } | null> {
  return loadMatches(query, signal)
    .then(matches => ({ matches, error: null }))
    .catch((error: unknown) => {
      if (signal.aborted) return null
      return {
        matches: [],
        error: `search could not run (${error instanceof Error ? error.message : String(error)}) — edit the query or retry`,
      }
    })
}

const MAX_MATCHES = 200
const MIN_QUERY = 2
const FILE_WIDTH = 34
const QUERY_WIDTH = 56
const MAX_ROWS = 12
const HEIGHT_RESERVE = 26
const MIN_ROWS = 4

function parseRgLine(line: string): SearchMatch | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line)
  if (!m) return null
  const [, file, lineStr, text] = m
  const ln = Number(lineStr)
  if (!file || !Number.isFinite(ln)) return null
  return { file, line: ln, text }
}

const defaultLoad: SearchLoader = async (query, signal) => {
  const [{ ripGrepStream }, { getCwd }] = await Promise.all([
    import('../utils/ripgrep.js'),
    import('../utils/cwd.js'),
  ])
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

export function MercuryContentSearch(arg0: {
  onPick: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
  loadMatches?: SearchLoader
}): React.ReactNode {
  return notBuilt('src/components/MercuryContentSearch.tsx:102')
}
