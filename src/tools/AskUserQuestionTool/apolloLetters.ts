// The Apollo poll letter grammar: in Apollo
// Mode every interview poll shows its authored options as A–D and the
// automatic free-text "Other" option as E — E is a STABLE identity ("E =
// type my own"), so it stays E even when fewer than four options were
// authored.
//
// One owner for the grammar. The letters ride the select owner's ordinal
// channel (`indexLabel` on OptionWithDescription — they REPLACE the numeric
// "1."–"5." prefixes); option labels and values stay raw, so answers,
// drafts and re-asked-question identity never carry a letter.

export const APOLLO_OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const

export const APOLLO_CUSTOM_LETTER = 'E'

/** The display ordinal for the authored option at `index`: 'A.'–'D.'.
 *  Indices past the tool's four-option cap yield undefined (the numeric
 *  prefix shows) — the schema forbids a fifth authored option, so this is
 *  shape-tolerance, not a fifth letter. */
export function apolloIndexLabel(index: number): string | undefined {
  const letter = APOLLO_OPTION_LETTERS[index]
  return letter === undefined ? undefined : `${letter}.`
}

/** The display ordinal for the automatic free-text "Other" option: 'E.'. */
export function apolloCustomIndexLabel(): string {
  return `${APOLLO_CUSTOM_LETTER}.`
}
