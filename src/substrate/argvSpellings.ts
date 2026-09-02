
export const BANKED_FLAG_SPELLINGS: Readonly<Record<string, string>> = Object.freeze({
  '-chat': '--chat',
  '-concourse-off': '--concourse-off',
  '-concourse-on': '--concourse-on',
})

export const DEBUG_FLAG_SPELLINGS: Readonly<Record<string, string>> = Object.freeze({
  '-d2e': '--d2e',
})

export function normalizeBankedFlagSpellings(
  argv: readonly string[],
  table: Readonly<Record<string, string>> = BANKED_FLAG_SPELLINGS,
): string[] {
  const out: string[] = []
  let optionsEnded = false
  for (const token of argv) {
    if (optionsEnded) {
      out.push(token)
      continue
    }
    if (token === '--') {
      optionsEnded = true
      out.push(token)
      continue
    }
    out.push(table[token] ?? token)
  }
  return out
}

export function applyBankedFlagSpellings(
  argv: string[],
  table: Readonly<Record<string, string>> = BANKED_FLAG_SPELLINGS,
): void {
  const head = argv.slice(0, 2)
  const rest = normalizeBankedFlagSpellings(argv.slice(2), table)
  argv.splice(0, argv.length, ...head, ...rest)
}
