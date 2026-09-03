// The diagnostics attachment: every line rides the response wrapper so the
// whole block sits under the indented connector. Collapsed: one dimmed
// count line with the expand affordance. Verbose: per file, the path
// relative to the working directory with the scheme in parentheses, then
// each diagnostic with severity, position, message, code and source.

import React from 'react'
import { Box, Text } from '../ink.js'
import type { DiagnosticFile } from '../services/diagnosticTracking.js'
import { getCwd } from '../utils/cwd.js'
import { relative } from 'path'
import { plural } from '../utils/stringUtils.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { MessageResponse } from './MessageResponse.js'
import { GLYPH } from './mercury-ui/glyphs.js'

/** Contract data — the IDE diff-view URI prefix for the right-hand side. */
const IDE_RIGHT_PREFIX = '_claude_fs_right:'

function splitUri(uri: string): { path: string; scheme: string } {
  if (uri.startsWith('file://')) {
    return { path: uri.slice('file://'.length), scheme: 'file://' }
  }
  if (uri.startsWith(IDE_RIGHT_PREFIX)) {
    return { path: uri.slice(IDE_RIGHT_PREFIX.length), scheme: 'claude_fs_right' }
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

export function DiagnosticsDisplay({
  attachment,
  verbose,
}: {
  attachment: { files: DiagnosticFile[]; isNew: boolean }
  verbose: boolean
}): React.ReactNode {
  const files = attachment.files
  if (files.length === 0) return null
  const total = files.reduce((sum, file) => sum + file.diagnostics.length, 0)

  if (!verbose) {
    return (
      <MessageResponse height={1}>
        <Text dimColor wrap="wrap">
          Found <Text bold>{total}</Text> new {plural(total, 'diagnostic')} in{' '}
          {files.length} {plural(files.length, 'file')} <CtrlOToExpand />
        </Text>
      </MessageResponse>
    )
  }

  return (
    <Box flexDirection="column">
      {files.map(file => {
        const { path, scheme } = splitUri(file.uri)
        const rel = relative(getCwd(), path)
        const display = rel.startsWith('..') ? path : rel
        return (
          <Box key={file.uri} flexDirection="column">
            <MessageResponse height={1}>
              <Text wrap="wrap">
                <Text bold>{display}</Text>
                <Text dimColor> ({scheme})</Text>
              </Text>
            </MessageResponse>
            {file.diagnostics.map((diagnostic, index) => {
              const severity =
                SEVERITY_SYMBOLS[diagnostic.severity] ?? SEVERITY_SYMBOLS.Hint!
              return (
                <MessageResponse key={index} height={1}>
                  <Text wrap="wrap">
                    {'  '}
                    <Text color={severity.color}>{severity.glyph}</Text>{' '}
                    <Text dimColor>
                      [Line {diagnostic.range.start.line + 1}:
                      {diagnostic.range.start.character + 1}]
                    </Text>{' '}
                    {diagnostic.message}
                    {diagnostic.code ? <Text dimColor> [{diagnostic.code}]</Text> : null}
                    {diagnostic.source ? (
                      <Text dimColor> ({diagnostic.source})</Text>
                    ) : null}
                  </Text>
                </MessageResponse>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}

export default DiagnosticsDisplay
