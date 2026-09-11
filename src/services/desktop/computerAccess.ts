import { flagEnv } from '../../substrate/flagRegistry.js'

export const COMPUTER_ACCESS_CHOICES = ['asks', 'sovereign'] as const
export type ComputerAccess = (typeof COMPUTER_ACCESS_CHOICES)[number]

export function computerAccess(): ComputerAccess {
  return (flagEnv('MERCURY_COMPUTER_ACCESS') ?? '').trim().toLowerCase() === 'sovereign' ? 'sovereign' : 'asks'
}

export function computerAccessWords(access: ComputerAccess = computerAccess()): string {
  return access === 'sovereign' ? 'sovereign mode' : 'asks'
}
