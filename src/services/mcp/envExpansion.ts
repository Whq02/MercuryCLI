export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []
  const expanded = value.replace(/\$\{([^}]+)\}/g, (reference, inner: string) => {
    const at = inner.indexOf(':-')
    const name = at === -1 ? inner : inner.slice(0, at)
    const defaultValue = at === -1 ? undefined : inner.slice(at + 2)
    const envValue = process.env[name as string]
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue
    missingVars.push(name as string)
    return reference as string
  })
  return { expanded, missingVars }
}
