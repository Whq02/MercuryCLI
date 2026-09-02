// Fixture library — positions in this file are load-bearing for the proofs.
// Line/character coordinates below are asserted by prove-lsp-e2e.ts; edit
// with care and update the proof's POSITIONS table together.

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
