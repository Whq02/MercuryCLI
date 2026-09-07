import { flagEnv } from '../../substrate/flagRegistry.js'
import { apiTimeoutMsOverride } from '../../utils/envValidation.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export type PatienceMode = 'normal' | 'patient' | 'custom'

export interface PatienceNumbers {
  streamIdleMs: number
  quietStreamIdleMs: number
  fallbackCeilingMs: number
  recoveryBudgetMinutes: number
}

export const PATIENCE_NORMAL: Readonly<PatienceNumbers> = Object.freeze({
  streamIdleMs: 90_000,
  quietStreamIdleMs: 15 * 60_000,
  fallbackCeilingMs: 15 * 60_000,
  recoveryBudgetMinutes: 20,
})

export const PATIENCE_PATIENT: Readonly<PatienceNumbers> = Object.freeze({
  streamIdleMs: PATIENCE_NORMAL.streamIdleMs * 2,
  quietStreamIdleMs: PATIENCE_NORMAL.quietStreamIdleMs * 2,
  fallbackCeilingMs: PATIENCE_NORMAL.fallbackCeilingMs * 2,
  recoveryBudgetMinutes: PATIENCE_NORMAL.recoveryBudgetMinutes * 2,
})

export interface PatienceCustomSetting {
  streamIdleSeconds?: number
  quietStreamIdleSeconds?: number
  fallbackCeilingSeconds?: number
  recoveryBudgetMinutes?: number
}

export type PatienceSetting = 'normal' | 'patient' | PatienceCustomSetting

export interface Patience {
  mode: PatienceMode
  numbers: PatienceNumbers
}

const STREAM_IDLE_FLOOR_SECONDS = 1

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function patienceOf(setting: unknown): Patience {
  if (setting === 'patient') return { mode: 'patient', numbers: { ...PATIENCE_PATIENT } }
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    return { mode: 'normal', numbers: { ...PATIENCE_NORMAL } }
  }
  const custom = setting as PatienceCustomSetting
  const idleSeconds = positiveNumber(custom.streamIdleSeconds)
  const quietSeconds = positiveNumber(custom.quietStreamIdleSeconds)
  const ceilingSeconds = positiveNumber(custom.fallbackCeilingSeconds)
  const budgetMinutes =
    typeof custom.recoveryBudgetMinutes === 'number' && Number.isFinite(custom.recoveryBudgetMinutes) && custom.recoveryBudgetMinutes >= 0
      ? custom.recoveryBudgetMinutes
      : undefined
  return {
    mode: 'custom',
    numbers: {
      streamIdleMs: idleSeconds !== undefined && idleSeconds >= STREAM_IDLE_FLOOR_SECONDS ? Math.round(idleSeconds * 1000) : PATIENCE_NORMAL.streamIdleMs,
      quietStreamIdleMs:
        quietSeconds !== undefined && quietSeconds >= STREAM_IDLE_FLOOR_SECONDS ? Math.round(quietSeconds * 1000) : PATIENCE_NORMAL.quietStreamIdleMs,
      fallbackCeilingMs: ceilingSeconds !== undefined ? Math.round(ceilingSeconds * 1000) : PATIENCE_NORMAL.fallbackCeilingMs,
      recoveryBudgetMinutes: budgetMinutes ?? PATIENCE_NORMAL.recoveryBudgetMinutes,
    },
  }
}

export function currentPatience(): Patience {
  return patienceOf((getInitialSettings() as { patience?: unknown }).patience)
}

export function customPatienceSetting(numbers: PatienceNumbers): PatienceCustomSetting {
  return {
    streamIdleSeconds: Math.round(numbers.streamIdleMs / 1000),
    quietStreamIdleSeconds: Math.round(numbers.quietStreamIdleMs / 1000),
    fallbackCeilingSeconds: Math.round(numbers.fallbackCeilingMs / 1000),
    recoveryBudgetMinutes: numbers.recoveryBudgetMinutes,
  }
}

export function nonstreamingFallbackCeilingMs(): number {
  return apiTimeoutMsOverride() ?? currentPatience().numbers.fallbackCeilingMs
}

export function recoveryBudgetMinutesSetting(): number {
  return currentPatience().numbers.recoveryBudgetMinutes
}

export function patienceSeconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`
}

export function patienceWords(numbers: PatienceNumbers): string {
  const budget = numbers.recoveryBudgetMinutes === 0 ? 'no retry budget' : `retry budget ${patienceSeconds(numbers.recoveryBudgetMinutes * 60_000)}`
  return `idle ${patienceSeconds(numbers.streamIdleMs)} (OpenAI ${patienceSeconds(numbers.quietStreamIdleMs)}) · fallback ${patienceSeconds(numbers.fallbackCeilingMs)} · ${budget}`
}

export function patienceEnvPins(): string[] {
  const pins: string[] = []
  for (const env of ['MERCURY_STREAM_IDLE_TIMEOUT_MS', 'MERCURY_API_TIMEOUT_MS', 'MERCURY_RECOVERY_BUDGET_MINUTES'] as const) {
    const raw = flagEnv(env)
    if (raw !== undefined && raw.trim() !== '') pins.push(`${env}=${raw.trim()}`)
  }
  return pins
}
