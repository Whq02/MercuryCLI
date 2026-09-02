
import { join } from 'node:path'
import { getMercuryHome, isEnvTruthy } from '../envUtils.js'
import { sanitizePath } from '../sessionStoragePortable.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function isTabulaEnabled(): boolean {
  if (flagEnv('MERCURY_TABULA') === '0') return false
  return true
}

export function isMinervaEnabled(): boolean {
  if (!isTabulaEnabled()) return false
  return isEnvTruthy(flagEnv('MERCURY_TABULA_MINERVA'))
}

export function tabulaRoot(): string {
  const override = flagEnv('MERCURY_TABULA_DIR')
  if (override && override.trim().length > 0) return override
  return join(getMercuryHome(), 'tabula')
}

export function tabulaProjectDir(projectPath: string): string {
  return join(tabulaRoot(), sanitizePath(projectPath.normalize('NFC')))
}
