import { notBuilt, unbuilt } from '../pi/holes.js'

export function isProviderManagedEnvVar(key: string): boolean {
  return notBuilt('src/utils/managedEnvConstants.ts:13')
}

export const SAFE_ENV_VARS: Set<string> = unbuilt('src/utils/managedEnvConstants.ts:17')
