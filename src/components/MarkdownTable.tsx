import React from 'react'
import type { Tokens } from 'marked'
import wrapAnsi from 'wrap-ansi'
import { Box } from '../ink.js'
import { Ansi } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { applyMarkdown } from '../utils/markdown.js'
import type { CliHighlight } from '../utils/cliHighlight.js'
import { notBuilt } from '../pi/holes.js'

type Cell = { text: string }

function inlineText(
  raw: string,
  themeName: Parameters<typeof applyMarkdown>[1],
  highlight: CliHighlight | null | undefined,
): string {
  return applyMarkdown(raw, themeName, highlight, Number.POSITIVE_INFINITY)
    .replace(/\n+/g, ' ')
    .trim()
}

function longestWordWidth(text: string): number {
  let widest = 0
  for (const word of text.split(/\s+/)) {
    widest = Math.max(widest, stringWidth(word))
  }
  return widest
}

function padTo(text: string, width: number, align: string): string {
  const deficit = Math.max(0, width - stringWidth(text))
  if (align === 'right') return ' '.repeat(deficit) + text
  if (align === 'center') {
    const left = Math.floor(deficit / 2)
    return ' '.repeat(left) + text + ' '.repeat(deficit - left)
  }
  return text + ' '.repeat(deficit)
}

export function MarkdownTable(arg0: {
  token: Tokens.Table
  highlight?: CliHighlight | null
  forceWidth?: number
}): React.ReactNode {
  return notBuilt('src/components/MarkdownTable.tsx:69')
}

export default MarkdownTable
