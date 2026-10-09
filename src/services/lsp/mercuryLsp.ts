
import { flagEnv } from '../../substrate/flagRegistry.js'

export function mercuryLspEnabled(): boolean {
  
  return flagEnv('MERCURY_LSP') !== '0'
}

export function isLspToolCatalogEnabled(): boolean {
  return mercuryLspEnabled()
}

export function mercuryLspWriteOpsEnabled(): boolean {
  return mercuryLspEnabled()
}

export function mercuryLspServersEnv(): string | undefined {
  if (!mercuryLspEnabled()) return undefined
  const raw = flagEnv('MERCURY_LSP_SERVERS')
  return raw && raw.trim().length > 0 ? raw : undefined
}
