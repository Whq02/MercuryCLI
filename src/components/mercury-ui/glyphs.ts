
import type { Task } from '../../utils/tasks.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth as rigorousTruncateToWidth } from '../../utils/truncate.js'
import { AMBER, FAINT, SECOND, TEAL } from '../mercuryPalette.js'

export const GLYPH = {
  sep: '│',
  dot: '·',
  branch: '⌥',
  mission: '◆',
  lease: '⌁',
  leaseHeld: '⊟',
  prompt: '❯',
  caretBlock: '▌',
  turns: '⤳',
  conflict: '⨯',
  fail: '✕',
  ok: '●',
  warn: '▲',
  read: '◌',
  handoff: '⇄',
  trace: '⟡',
  spark: '✶',
  sparkBright: '✦',
  sparkFaint: '✧',
  cloud: '⊛',
  cursor: '▸',
  tokens: '◈',
  pending: '○',
  inProgress: '◐',
  done: '●',
  idle: '·',
  busy: '◐',
  drifting: '◓',
  check: '✓',
  typing: '✎',
  circledBullet: '◉',
  fisheye: '⦿',
  diamond: '◇',
  squareOpen: '□',
  circledDash: '⊝',
  circledSlash: '⊘',
  uptri: '▲',
  barFull: '█',
  barEmpty: '░',
  ownSubstrate: '◆',
  ownUpstream: '·',
  ownHybrid: '⊞',
  chevronDown: '⌄',
  chevronRight: '›',
  modeDefault: '◦',
  modeImplement: '±',
  modeStrategy: '◇',
  modeFlow: '✦',
  modeDontAsk: '¬',
  modeSovereign: '⊠',
  modeAutopilot: '⌖',
  modeScribe: '✎',
  modeApollo: '∵',
  modeManager: '∷',
} as const

export const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export const STATUS_GLYPH: Record<Task['status'], { glyph: string; color: string }> = {
  pending: { glyph: GLYPH.pending, color: FAINT },
  in_progress: { glyph: GLYPH.inProgress, color: TEAL },
  completed: { glyph: GLYPH.done, color: TEAL },
}

export const HEALTH_GLYPH: Record<string, { glyph: string; color: string }> = {
  idle: { glyph: GLYPH.idle, color: FAINT },
  busy: { glyph: GLYPH.busy, color: TEAL },
  drifting: { glyph: GLYPH.drifting, color: AMBER },
}

export const OWNERSHIP_GLYPH: Record<'substrate' | 'upstream' | 'hybrid', { glyph: string; color: string; label: string }> = {
  substrate: { glyph: GLYPH.ownSubstrate, color: SECOND, label: 'substrate' },
  upstream: { glyph: GLYPH.ownUpstream, color: FAINT, label: 'upstream' },
  hybrid: { glyph: GLYPH.ownHybrid, color: AMBER, label: 'hybrid' },
}


export function charWidth(ch: string): number {
  return stringWidth(ch)
}

export function displayWidth(s: string): number {
  return stringWidth(s)
}

export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return ''
  return rigorousTruncateToWidth(s, max)
}

export function padTo(s: string, w: number): string {
  if (displayWidth(s) > w) s = truncateToWidth(s, w)
  const width = displayWidth(s)
  if (width >= w) return s
  return s + ' '.repeat(w - width)
}

export function padStartTo(s: string, w: number): string {
  if (displayWidth(s) > w) s = truncateToWidth(s, w)
  const width = displayWidth(s)
  if (width >= w) return s
  return ' '.repeat(w - width) + s
}
