// Fixture with a deliberate type error (TS2322) + an unused import (TS6133-
// class quickfix target). prove-lsp-e2e asserts diagnostics + codeActions here.
import { makeGreeting } from './lib.js'

export const wrongType: number = 'not a number'

export function unusedGreetingPath(): string {
  return 'no greeting here'
}
