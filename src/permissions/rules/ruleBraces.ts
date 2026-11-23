export const RULE_BRACE_BOUND = 256

function classEnd(text: string, at: number): number {
  const close = text.indexOf(']', at + 2)
  return close === -1 ? at : close
}

function braceGroup(text: string): { open: number; close: number; commas: number[] } | null {
  for (let open = 0; open < text.length; open++) {
    const char = text[open]
    if (char === '\\') {
      open++
      continue
    }
    if (char === '[') {
      open = classEnd(text, open)
      continue
    }
    if (char !== '{') continue
    const commas: number[] = []
    let depth = 0
    for (let at = open + 1; at < text.length; at++) {
      const inner = text[at]
      if (inner === '\\') at++
      else if (inner === '[') at = classEnd(text, at)
      else if (inner === '{') depth++
      else if (inner === ',' && depth === 0) commas.push(at)
      else if (inner === '}') {
        if (depth > 0) depth--
        else if (commas.length > 0) return { open, close: at, commas }
        else break
      }
    }
  }
  return null
}

export function starredBraces(pattern: string): string {
  let text = pattern
  for (let group = braceGroup(text); group !== null; group = braceGroup(text)) {
    if (text.slice(group.open, group.close).includes('/')) return `${text.slice(0, group.open)}*`
    text = `${text.slice(0, group.open)}*${text.slice(group.close + 1)}`
  }
  return text
}

export function expandRuleBraces(pattern: string, wide = false): string[] {
  const done: string[] = []
  const pending = [pattern]
  while (pending.length > 0) {
    const text = pending.pop()!
    const group = braceGroup(text)
    if (group === null) done.push(text)
    else {
      const cuts = [group.open, ...group.commas, group.close]
      for (let part = cuts.length - 2; part >= 0; part--) pending.push(`${text.slice(0, group.open)}${text.slice(cuts[part]! + 1, cuts[part + 1]!)}${text.slice(group.close + 1)}`)
    }
    if (done.length + pending.length > RULE_BRACE_BOUND) return [wide ? starredBraces(pattern) : pattern]
  }
  return [...new Set(done)]
}

export function ruleBracesPastBound(pattern: string): boolean {
  return braceGroup(pattern) !== null && expandRuleBraces(pattern).length === 1 && expandRuleBraces(pattern)[0] === pattern
}
