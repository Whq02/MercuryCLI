
export interface ResolvedInvocation {
  executablePath: string
  args: string[]
  cwd?: string
}

export function parseLegacyCommandString(raw: string, cwd?: string): ResolvedInvocation {
  const tokens: string[] = []
  let cur = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else cur += c
      continue
    }
    if (c === '\\' && i + 1 < raw.length) {
      cur += raw[++i]!
      started = true
      continue
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      started = true
      continue
    }
    if (c === ' ' || c === '\t') {
      if (started || cur.length > 0) {
        tokens.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += c
    started = true
  }
  if (started || cur.length > 0) tokens.push(cur)
  return {
    executablePath: tokens[0] ?? '',
    args: tokens.slice(1),
    ...(cwd !== undefined ? { cwd } : {}),
  }
}
