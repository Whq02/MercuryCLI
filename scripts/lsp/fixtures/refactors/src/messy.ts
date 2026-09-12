import { shoutGreeting } from './core/index.js'
import { loudness } from './core/greeting.js'
import { makeGreeting } from './core/index.js'

export function messy(name: string): string {
  return shoutGreeting(makeGreeting(name))
}

export const untouched = ['keep', 'this', 'body', 'exactly']
