export type MatcherShape = 'everything' | 'names' | 'regex'

export function matcherShape(matcher: string | undefined): MatcherShape {
  if (!matcher || matcher === '*') return 'everything'
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) return 'names'
  return 'regex'
}

export function matcherCompiles(matcher: string | undefined): boolean {
  if (matcherShape(matcher) !== 'regex') return true
  try {
    new RegExp(matcher as string)
    return true
  } catch {
    return false
  }
}
