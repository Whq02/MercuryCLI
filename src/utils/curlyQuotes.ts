import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export const LEFT_SINGLE_CURLY_QUOTE: Unbuilt = unbuilt('src/utils/curlyQuotes.ts:1')
export const RIGHT_SINGLE_CURLY_QUOTE: Unbuilt = unbuilt('src/utils/curlyQuotes.ts:2')
export const LEFT_DOUBLE_CURLY_QUOTE: Unbuilt = unbuilt('src/utils/curlyQuotes.ts:3')
export const RIGHT_DOUBLE_CURLY_QUOTE: Unbuilt = unbuilt('src/utils/curlyQuotes.ts:4')

export function straightenQuotes(text: string): string {
  return notBuilt('src/utils/curlyQuotes.ts:6')
}
