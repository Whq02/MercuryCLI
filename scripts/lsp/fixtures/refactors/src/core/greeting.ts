export interface Greeting {
  message: string
  emphatic: boolean
}

export const loudness = 3

export function makeGreeting(name: string): Greeting {
  return { message: `storm-front hails ${name}`, emphatic: false }
}

export function shoutGreeting(g: Greeting): string {
  const shift = 1
  return g.emphatic ? g.message.toUpperCase() + '!'.repeat(shift + loudness) : g.message
}
