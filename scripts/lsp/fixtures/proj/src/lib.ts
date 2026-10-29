
export interface Greeting {
  message: string
  emphatic: boolean
}

export function makeGreeting(name: string): Greeting {
  return { message: `storm-front hails ${name}`, emphatic: false }
}

export function shoutGreeting(g: Greeting): string {
  return g.emphatic ? g.message.toUpperCase() : g.message
}
