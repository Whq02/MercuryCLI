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
