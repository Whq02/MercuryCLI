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
