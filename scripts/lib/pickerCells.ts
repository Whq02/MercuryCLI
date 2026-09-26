export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function idCellPattern(id: string, shortest = 12): string {
  const whole = `${escapeRegExp(id)}(?=\\s|$)`
  const cuts = Array.from({ length: Math.max(0, id.length - shortest) }, (_, k) => escapeRegExp(id.slice(0, id.length - 1 - k)))
  return cuts.length === 0 ? whole : `(?:${whole}|(?:${cuts.join('|')})…)`
}

export const showsId = (screen: string, id: string): boolean => new RegExp(idCellPattern(id)).test(screen)

export const rowPattern = (alias: string, id: string): RegExp => new RegExp(`${escapeRegExp(alias)}\\s{2,}${idCellPattern(id)}`)

export const focusedRowPattern = (alias: string, id: string, after = ''): RegExp => new RegExp(`│ │ ${escapeRegExp(alias)}\\s{2,}${idCellPattern(id)}${after}`)
