import { existsSync, globSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function normalizeGlobPattern(pattern: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return pattern
  return pattern.replace(/\\/g, '/')
}

export function splitGrepGlobField(field: string, platform: NodeJS.Platform = process.platform): string[] {
  const values: string[] = []
  for (const token of field.split(/\s+/).filter(Boolean)) {
    if (token.includes('{') && token.includes('}')) {
      values.push(normalizeGlobPattern(token, platform))
    } else {
      for (const piece of token.split(',').filter(Boolean)) {
        values.push(normalizeGlobPattern(piece, platform))
      }
    }
  }
  return values
}

export function resolveSearchGlob(pattern: string, root: string, intoMixed = true): string[] {
  if (pattern.startsWith('!')) return [pattern]
  const parts = pattern.split('/')
  let prefix = root
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (/[*?{\\]/.test(part)) break
    prefix = join(prefix, part)
    if (part.includes('[')) {
      if (!existsSync(prefix)) break
      parts[i] = part.replace(/[\[\]]/g, bracket => (bracket === '[' ? '[[]' : '[]]'))
    }
  }
  const escaped = parts.join('/')
  if (escaped.includes('**')) return [escaped]
  let matches: string[]
  try {
    matches = [...globSync(escaped.replace(/^\//, ''), { cwd: root })]
  } catch {
    return [escaped]
  }
  const directories = matches.filter(path => {
    try { return statSync(join(root, path)).isDirectory() } catch { return false }
  })
  if (directories.length === 0 || (!intoMixed && directories.length < matches.length)) return [escaped]
  const recursive = `${escaped.replace(/\/$/, '')}/**`
  return directories.length === matches.length ? [recursive] : [escaped, recursive]
}

export function globSearchDepth(patterns: readonly string[]): number | undefined {
  const positive = patterns.filter(pattern => !pattern.startsWith('!'))
  if (positive.length === 0 || positive.some(pattern => pattern.includes('**'))) return undefined
  return Math.max(...positive.map(pattern => {
    let depth = 1
    const alternatives: { start: number; max: number }[] = []
    const relative = pattern.replace(/^(?:\.\/|\/)/, '')
    for (let i = 0; i < relative.length; i++) {
      const char = relative[i]
      if (char === '\\') {
        i++
      } else if (char === '{') {
        alternatives.push({ start: depth, max: depth })
      } else if (char === ',' && alternatives.length > 0) {
        const branch = alternatives[alternatives.length - 1]!
        branch.max = Math.max(branch.max, depth)
        depth = branch.start
      } else if (char === '}' && alternatives.length > 0) {
        depth = Math.max(depth, alternatives.pop()!.max)
      } else if (char === '/') {
        depth++
      }
    }
    return depth
  }))
}
