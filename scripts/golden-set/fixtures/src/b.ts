import { parseRow } from './a.ts'

export const greeting = 'hello'

export function greet(row: string): string {
  return `${greeting}: ${parseRow(row).join('|')}`
}
