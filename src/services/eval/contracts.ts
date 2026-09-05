
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'

export type EvalLanguage = 'py' | 'js'

export const EVAL_LANGUAGES: readonly EvalLanguage[] = ['py', 'js']

export function evalEnabled(): boolean {
  return flagEnabled('MERCURY_EVAL')
}

export function evalLanguageEnabled(language: EvalLanguage): boolean {
  return language === 'py' ? flagEnabled('MERCURY_EVAL_PY') : flagEnabled('MERCURY_EVAL_JS')
}

export function evalPythonOverride(): string | undefined {
  const value = flagEnv('MERCURY_EVAL_PYTHON')?.trim()
  return value ? value : undefined
}


export const EVAL_DEFAULT_TIMEOUT_SECONDS = 30
export const EVAL_MAX_TIMEOUT_SECONDS = 600
export const EVAL_WALL_CEILING_MS = 30 * 60_000
export const EVAL_INTERRUPT_ESCALATION_MS = 2_000
export const EVAL_SHUTDOWN_GRACE_MS = 1_500
export const EVAL_IDLE_TTL_MS = 15 * 60_000
export const EVAL_IDLE_SWEEP_MS = 60_000


export const EVAL_HEAD_BYTES = 24_000
export const EVAL_TAIL_BYTES = 8_000
export const EVAL_MAX_LINE_CHARS = 2_000
export const EVAL_MAX_DISPLAY_CHARS = 10_000
export const EVAL_SPILL_MAX_BYTES = 8 * 1024 * 1024


export interface EvalCellInput {
  language: EvalLanguage
  code: string
  title?: string
  timeoutSeconds?: number
  reset?: boolean
}

export interface EvalDisplay {
  mime: 'text/plain' | 'text/markdown' | 'application/json' | 'image/png' | 'image/jpeg'
  data: string
  b64?: boolean
}

export type EvalCellStatus = 'ok' | 'error' | 'cancelled'

export interface EvalStreamCapture {
  text: string
  truncated: boolean
  totalBytes: number
  totalLines: number
}

export interface EvalCellOutcome {
  status: EvalCellStatus
  stdout: EvalStreamCapture
  stderr: EvalStreamCapture
  displays: EvalDisplay[]
  resultRepr?: string
  error?: { name: string; value: string; traceback: string }
  spillPath?: string
  annotations: string[]
  runtimeMs: number
  bridgeMs: number
  executionCount: number
}


export interface EvalLanguageAvailability {
  language: EvalLanguage
  available: boolean
  interpreterPath?: string
  version?: string
  whyNot?: string
  probing?: true
}

export function unavailableLanguageMessage(
  requested: string,
  alternatives: EvalLanguageAvailability[],
): string {
  const usable = alternatives.filter(a => a.available).map(a => a.language)
  const alt = usable.length > 0 ? ` Available: ${usable.join(', ')}.` : ' No eval language is currently available.'
  return `Eval language '${requested}' is not available in this session.${alt}`
}
