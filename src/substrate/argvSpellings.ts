// ============================================================================
//  substrate/argvSpellings — the banked single-dash spellings of two boot
//  switches (the operator's word:
//  `mercury -chat` · `mercury -concourse-off`).
//
//  The estate's argv grammar is commander's: long switches are `--name`, and
//  a single dash introduces SHORT switches that combine — so `-chat` would
//  parse as `-c -h -a -t` (= --continue + --help + two unknowns), never as
//  the operator's word. Both spellings admit: this pure pass rewrites the
//  banked single-dash tokens to their `--` form, exact-token only (`-c`
//  alone stays --continue; `-chatty` is untouched), and stops at `--` (end
//  of options — an operand spelled `-chat` after it is the operand). The
//  cli entry applies it to process.argv in place, before commander and
//  before anything reads argv, so every reader sees the estate's form.
// ============================================================================

/** The banked spellings and the estate's forms they admit as. */
export const BANKED_FLAG_SPELLINGS: Readonly<Record<string, string>> = Object.freeze({
  '-chat': '--chat',
  '-concourse-off': '--concourse-off',
  '-concourse-on': '--concourse-on',
})

/** The operator's short debug flag. commander ≥13 refuses a multi-character
 *  single-dash flag in the option table (a single dash introduces combining
 *  short switches), so `-d2e` admits through the same pure pass as its
 *  canonical `--d2e` — kept apart from the banked boot switches above, whose
 *  table is the operator's three words and pinned as such. */
export const DEBUG_FLAG_SPELLINGS: Readonly<Record<string, string>> = Object.freeze({
  '-d2e': '--d2e',
})

/** Pure: a copy of `argv` with every banked single-dash token (before the
 *  `--` sentinel) rewritten to its `--` form. */
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

/** Apply in place: process.argv's option tokens (index 2 on) take their
 *  estate form; the node binary and the script path never change. */
export function applyBankedFlagSpellings(
  argv: string[],
  table: Readonly<Record<string, string>> = BANKED_FLAG_SPELLINGS,
): void {
  const head = argv.slice(0, 2)
  const rest = normalizeBankedFlagSpellings(argv.slice(2), table)
  argv.splice(0, argv.length, ...head, ...rest)
}
