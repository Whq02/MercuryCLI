import { adoptiveProjectPath } from '../utils/projectStoreAdoption.js'
import { join } from 'node:path'
import { getCwd } from '../utils/cwd.js'
import { flagEnv } from './flagRegistry.js'

export function routerStateDir(): string {
  return flagEnv('MERCURY_ROUTER_STATE_DIR')?.trim() || adoptiveProjectPath(getCwd(), 'router')
}
