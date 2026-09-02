
export const APOLLO_OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const

export const APOLLO_CUSTOM_LETTER = 'E'

export function apolloIndexLabel(index: number): string | undefined {
  const letter = APOLLO_OPTION_LETTERS[index]
  return letter === undefined ? undefined : `${letter}.`
}

export function apolloCustomIndexLabel(): string {
  return `${APOLLO_CUSTOM_LETTER}.`
}
