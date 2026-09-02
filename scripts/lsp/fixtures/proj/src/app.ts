// Fixture app — exercises cross-file definition/references/rename targets.
import { makeGreeting, shoutGreeting } from './lib.js'

export function greetCrew(names: string[]): string[] {
  return names.map(n => shoutGreeting(makeGreeting(n)))
}

export function greetOne(name: string): string {
  const g = makeGreeting(name)
  return shoutGreeting(g)
}
