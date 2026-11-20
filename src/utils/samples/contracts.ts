import { flagEnabled } from '../../substrate/flagRegistry.js'

export interface SampleItem {
  id: string
  title: string
  version: number
  url: string
  ask?: string
}

export type SampleState = 'open' | 'approved' | 'changes-needed'

export interface SampleVersionV1 {
  n: number
  createdAt: string
}

export interface SampleRecordV1 {
  id: string
  slug: string
  title: string
  sessionId: string
  createdAt: string
  updatedAt: string
  latestVersion: number
  state: SampleState
  glyph: string
  versions: SampleVersionV1[]
}

export type SampleVerdict = 'approve' | 'changes-needed' | null

export interface SamplePinV1 {
  x: number
  y: number
  target: string
  text: string
}

export interface SampleMarksV1 {
  version: number
  pins: SamplePinV1[]
  note: string
  verdict: SampleVerdict
}

export interface SampleShellInput {
  record: SampleRecordV1
  versions: SampleVersionV1[]
  token: string | null
  inline?: boolean
  versionHtml?: Record<number, string>
}

export type SampleHtmlSource = 'product' | 'doc'

export const SAMPLE_PART_KINDS = ['verdict', 'section', 'cards', 'table', 'diff', 'terminal', 'figure', 'checklist', 'question'] as const
export type SamplePartKind = (typeof SAMPLE_PART_KINDS)[number]

export const SAMPLE_VERDICT_STATUSES = ['approved', 'changes-needed', 'warning', 'info', 'halted'] as const
export type SampleVerdictStatus = (typeof SAMPLE_VERDICT_STATUSES)[number]

export const SAMPLE_TONES = ['default', 'ok', 'warn', 'danger', 'accent'] as const
type SampleTone = (typeof SAMPLE_TONES)[number]

export const SAMPLE_CELL_TONES = ['default', 'ok', 'warn', 'danger', 'mono', 'accent'] as const
export type SampleCellTone = (typeof SAMPLE_CELL_TONES)[number]

export const SAMPLE_LINE_TONES = ['default', 'dim', 'add', 'del', 'warn', 'accent'] as const
export type SampleLineTone = (typeof SAMPLE_LINE_TONES)[number]

export const SAMPLE_CHECK_STATES = ['done', 'pending', 'failed', 'skipped'] as const
export type SampleCheckState = (typeof SAMPLE_CHECK_STATES)[number]

interface SamplePartBaseV1 {
  id?: string
  heading?: string
  numeral?: string
}

export interface SampleVerdictPartV1 {
  kind: 'verdict'
  status: SampleVerdictStatus
  label: string
  summary: string
  detail?: string
}

export interface SampleSectionPartV1 extends SamplePartBaseV1 {
  kind: 'section'
  prose: string[]
  items: string[]
  note?: string
}

export interface SampleCardV1 {
  label?: string
  value?: string
  title?: string
  body?: string
  tone: SampleTone
}

export interface SampleCardsPartV1 extends SamplePartBaseV1 {
  kind: 'cards'
  columns: 2 | 3 | 4
  items: SampleCardV1[]
}

export interface SampleCellV1 {
  text: string
  tone: SampleCellTone
}

export interface SampleTablePartV1 extends SamplePartBaseV1 {
  kind: 'table'
  caption?: string
  columns: string[]
  rows: SampleCellV1[][]
}

export interface SampleDiffSideV1 {
  label: string
  meta?: string
  start: number
  lines: string[]
}

export interface SampleDiffPartV1 extends SamplePartBaseV1 {
  kind: 'diff'
  caption?: string
  before: SampleDiffSideV1
  after: SampleDiffSideV1
}

export interface SampleTermLineV1 {
  text: string
  tone: SampleLineTone
}

export interface SampleTerminalPartV1 extends SamplePartBaseV1 {
  kind: 'terminal'
  title: string
  command?: string
  lines: SampleTermLineV1[]
  caption?: string
}

export interface SampleStepV1 {
  label: string
  text?: string
  detail?: string
}

export interface SampleFigurePartV1 extends SamplePartBaseV1 {
  kind: 'figure'
  steps: SampleStepV1[]
  svg?: string
  src?: string
  alt: string
  caption?: string
}

export interface SampleCheckV1 {
  text: string
  state: SampleCheckState
  detail?: string
}

export interface SampleChecklistPartV1 extends SamplePartBaseV1 {
  kind: 'checklist'
  items: SampleCheckV1[]
}

export interface SampleOptionV1 {
  label: string
  description?: string
  recommended: boolean
}

export interface SampleQuestionPartV1 extends SamplePartBaseV1 {
  kind: 'question'
  heading: string
  prompt?: string
  options: SampleOptionV1[]
}

export type SamplePartV1 =
  | SampleVerdictPartV1
  | SampleSectionPartV1
  | SampleCardsPartV1
  | SampleTablePartV1
  | SampleDiffPartV1
  | SampleTerminalPartV1
  | SampleFigurePartV1
  | SampleChecklistPartV1
  | SampleQuestionPartV1

export interface SampleDocV1 {
  title?: string
  subtitle?: string
  eyebrow?: string
  meta: string[]
  parts: SamplePartV1[]
}

export const SAMPLE_GLYPH_DEFAULT = '⧉'
export const SAMPLE_MARKS_BODY_CAP_BYTES = 256 * 1024
export const SAMPLE_HTML_CAP_BYTES = 8 * 1024 * 1024
export const SAMPLE_VERSIONS_POLL_MS = 2000

export function stateAfterVerdict(current: SampleState, verdict: SampleVerdict): SampleState {
  if (verdict === 'approve') return 'approved'
  if (verdict === 'changes-needed') return 'changes-needed'
  return current
}

export function sampleStateWord(state: SampleState): string {
  return state === 'changes-needed' ? 'changes needed' : state
}

export function samplesEnabled(): boolean {
  return flagEnabled('MERCURY_SAMPLES')
}
