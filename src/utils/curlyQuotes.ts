export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

export function straightenQuotes(text: string): string {
  return text
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}
