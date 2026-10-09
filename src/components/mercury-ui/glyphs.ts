
import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth as rigorousTruncateToWidth } from '../../utils/truncate.js'

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
  info: '○',
  read: '◌',
  handoff: '⇄',
  trace: '⟡',
  spark: '✶',
  star: '★',
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
  modeFlow: '✦',
  modeDontAsk: '¬',
  modeSovereign: '⊠',
  modeScribe: '✎',
  modeApollo: '◇',
  modeManager: '∷',
} as const

export const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const


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

export function branchChip(name: string): string {
  return `${GLYPH.branch} ${name}`
}

export function branchChipWidth(name: string): number {
  return stringWidth(branchChip(name))
}
