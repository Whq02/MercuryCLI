import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

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
  return !isEnvDefinedFalsy(flagEnv('MERCURY_SAMPLES'))
}
