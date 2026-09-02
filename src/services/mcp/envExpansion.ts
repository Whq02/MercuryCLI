/**
 * Environment expansion for MCP config strings: `${NAME}` and
 * `${NAME:-default}`.
 *
 * A reference is recognised only when it has at least one character between
 * the braces and contains no `}`; anything else is left literally in place.
 *
 * Resolution order per reference:
 *   1. the process environment (even an empty-string value counts as defined),
 *   2. the supplied default (an empty default substitutes the empty string),
 *   3. otherwise the name is recorded as missing and the original reference
 *      text stays literally in place (so the user can see it).
 *
 * Known quirk, preserved deliberately: the name/default split keeps only the
 * FIRST TWO `:-`-separated fields, so a default that itself contains `:-` is
 * truncated at that second separator — `${A:-x:-y}` yields `x`, not `x:-y`.
 * An empty name (`${:-x}`) looks up the empty environment name, finds
 * nothing, and substitutes the default.
 */
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
