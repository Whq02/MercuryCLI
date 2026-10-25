export function escapeForPowershellSingleQuotes(text: string): string {
  return text.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')
}
