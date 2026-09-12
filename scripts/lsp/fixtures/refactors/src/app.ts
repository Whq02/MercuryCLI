import { makeGreeting, shoutGreeting } from './core/index.js'
import { loudness } from './core/greeting.js'
import { shout } from './core/loud.js'

const label = 'makeGreeting'

export function greetCrew(names: string[]): string[] {
  return names.map(n => shoutGreeting(makeGreeting(n)))
}

export function makeBanner(name: string): string {
  return `${label}: ${shout(makeGreeting(name))} x${loudness}`
}
