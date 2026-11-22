import React from 'react'
import { Box, Text } from '../ink.js'
import type { DiagnosticFile } from '../utils/diagnosticTracking.js'
import { getCwd } from '../utils/cwd.js'
import { relative } from 'path'
import { plural } from '../utils/stringUtils.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { MessageResponse } from './MessageResponse.js'
import { GLYPH } from '../utils/glyphs.js'
import { notBuilt } from '../pi/holes.js'

function splitUri(uri: string): { path: string; scheme: string } {
  if (uri.startsWith('file://')) {
    return { path: uri.slice('file://'.length), scheme: 'file://' }
  }
  const colon = uri.indexOf(':')
  return { path: uri, scheme: colon > 0 ? uri.slice(0, colon) : uri }
}

const SEVERITY_SYMBOLS: Record<string, { glyph: string; color?: string }> = {
  Error: { glyph: '✗', color: 'error' },
  Warning: { glyph: GLYPH.warn, color: 'warning' },
  Info: { glyph: GLYPH.info },
  Hint: { glyph: '·' },
}

export function DiagnosticsDisplay(arg0: {
  attachment: { files: DiagnosticFile[]; isNew: boolean }
  verbose: boolean
}): React.ReactNode {
  return notBuilt('src/components/DiagnosticsDisplay.tsx:27')
}

export default DiagnosticsDisplay
