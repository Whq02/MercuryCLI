import { homedir } from 'node:os'
import { getCwd } from '../../utils/cwd.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { notBuilt } from '../../pi/holes.js'

export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  return notBuilt('src/services/mcp/envExpansion.ts:5')
}
