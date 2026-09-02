// ============================================================================
//  routerPaths — the route-state root (ONE seam, cycle-free).
// ----------------------------------------------------------------------------
//  MERCURY_ROUTER_STATE_DIR is the hermetic-isolation override (proofs/render
//  fixtures — the daemonDir()/MERCURY_TABULA_DIR pattern), read LIVE per call
//  (the FileStore lazy-path contract). Both router stores + the posture file
//  live under this root; extracting it here keeps routerRunStore ↔
//  routerOutcomeStore acyclic.
// ============================================================================
import { adoptiveProjectPath } from '../utils/projectStoreAdoption.js'
import { join } from 'node:path'
import { getCwd } from '../utils/cwd.js'
import { flagEnv } from './flagRegistry.js'

export function routerStateDir(): string {
  return flagEnv('MERCURY_ROUTER_STATE_DIR')?.trim() || adoptiveProjectPath(getCwd(), 'router')
}
