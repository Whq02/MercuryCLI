type Rule = { allow: boolean; path: string }
type Group = { agents: string[]; rules: Rule[] }

function normalized(path: string): string {
  return path.replace(/[^\x00-\x7F]/gu, char => encodeURIComponent(char)).replace(/%([0-9a-f]{2})/gi, (whole, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16))
    return /^[A-Za-z0-9._~-]$/.test(char) ? char : whole.toUpperCase()
  })
}

function matches(path: string, rule: string): boolean {
  const exact = rule.endsWith('$')
  const pieces = (exact ? rule.slice(0, -1) : rule).split('*')
  if (!path.startsWith(pieces[0]!)) return false
  let at = pieces[0]!.length
  if (pieces.length === 1) return !exact || path.length === at
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i]!
    const last = i === pieces.length - 1
    const index = exact && last ? path.length - piece.length : path.indexOf(piece, at)
    if (index < at || !path.startsWith(piece, index)) return false
    at = index + piece.length
  }
  return !exact || at === path.length
}

export function robotsAllows(text: string, url: string): boolean {
  const groups: Group[] = []
  let current: Group | undefined
  let hadRule = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'user-agent') {
      if (!current || hadRule) {
        current = { agents: [], rules: [] }
        groups.push(current)
        hadRule = false
      }
      current.agents.push(value.toLowerCase())
    } else if (current && (field === 'allow' || field === 'disallow')) {
      hadRule = true
      if (value.startsWith('/')) current.rules.push({ allow: field === 'allow', path: normalized(value) })
    }
  }
  const specific = groups.filter(group => group.agents.includes('mercury'))
  const chosen = specific.length ? specific : groups.filter(group => group.agents.includes('*'))
  const parsed = new URL(url)
  const path = normalized(parsed.pathname + parsed.search)
  let length = -1
  let allowed = true
  for (const rule of chosen.flatMap(group => group.rules)) {
    if (!matches(path, rule.path)) continue
    const specificity = rule.path.replace(/[*$]/g, '').replace(/%[0-9A-F]{2}/g, 'x').length
    if (specificity > length || (specificity === length && rule.allow)) {
      length = specificity
      allowed = rule.allow
    }
  }
  return allowed
}
