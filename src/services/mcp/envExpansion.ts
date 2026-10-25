import { homedir } from 'node:os'
import { getCwd } from '../../utils/cwd.js'

export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []
  const expanded = value.replace(/\$\{([^}]+)\}/g, (reference, inner: string) => {
    if (inner === 'workspaceFolder') return getCwd()
    if (inner === 'userHome') return homedir()
    const at = inner.indexOf(':-')
    const rawName = at === -1 ? inner : inner.slice(0, at)
    const name = rawName.startsWith('env:') ? rawName.slice('env:'.length) : rawName
    const defaultValue = at === -1 ? undefined : inner.slice(at + 2)
    const envValue = process.env[name as string]
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue
    missingVars.push(name as string)
    return reference as string
  })
  return { expanded, missingVars }
}
