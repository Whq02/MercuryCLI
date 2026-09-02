export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []
  const expanded = value.replace(/\$\{([^}]+)\}/g, (reference, inner: string) => {
    const [name, defaultValue] = inner.split(':-')
    const envValue = process.env[name as string]
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue
    missingVars.push(name as string)
    return reference as string
  })
  return { expanded, missingVars }
}
