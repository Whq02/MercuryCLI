import { straightenQuotes } from './curlyQuotes.js'

export const TYPOGRAPHIC_DASHES = /[\u2010-\u2015\u2212]/g
export const TYPOGRAPHIC_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

export function plainDashes(text: string): string {
  return text.replace(TYPOGRAPHIC_DASHES, '-')
}

export function plainSpaces(text: string): string {
  return text.replace(TYPOGRAPHIC_SPACES, ' ')
}

export function plainTypography(text: string): string {
  return plainSpaces(plainDashes(straightenQuotes(text)))
}
