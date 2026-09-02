import { flagEnv } from '../flagRegistry.js'


export type ThemisLevel = 'off' | 'warn' | 'enforce'

export const THEMIS_DEFAULT_LEVEL: ThemisLevel = 'enforce'

export function themisLevel(): ThemisLevel {
  const raw = flagEnv('MERCURY_THEMIS')
  if (raw === 'warn') return 'warn'
  if (raw === 'enforce') return 'enforce'
  if (raw === 'off' || raw === '0') return 'off'
  return THEMIS_DEFAULT_LEVEL
}

export function themisActive(): boolean {
  return themisLevel() !== 'off'
}
