import { homedir } from 'node:os'
import { getCwd } from '../../utils/cwd.js'
import { hostEnv } from '../../utils/hostEnv.js'
export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []
  const env = hostEnv()
  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
    if (expr === 'workspaceFolder') return getCwd()
    if (expr === 'userHome') return homedir()
    const defaultAt = expr.indexOf(':-')
    const rawName = defaultAt === -1 ? expr : expr.slice(0, defaultAt)
    const defaultValue = defaultAt === -1 ? undefined : expr.slice(defaultAt + 2)
    const varName = rawName.startsWith('env:') ? rawName.slice(4) : rawName
    const resolved = env[varName]
    if (resolved !== undefined) return resolved
    if (defaultValue !== undefined) return defaultValue
    if (!missingVars.includes(varName)) missingVars.push(varName)
    return match
  })
  return { expanded, missingVars }
}
