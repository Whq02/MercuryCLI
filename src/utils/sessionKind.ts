import { deleteFlagEnv, flagEnv } from '../substrate/flagRegistry.js'

export type SessionKind = 'oculus' | 'headless'

export const SESSION_KINDS: readonly SessionKind[] = ['oculus', 'headless']

export const SESSION_KIND_ENV = 'MERCURY_SESSION_KIND'

export function parseSessionKind(raw: unknown): SessionKind | undefined {
  return raw === 'oculus' || raw === 'headless' ? raw : undefined
}

function isOperatorAsker(by: string | undefined): boolean {
  return by === 'operator' || (typeof by === 'string' && by.startsWith('operator:'))
}

export function sessionKindOfAsker(by: string | undefined): SessionKind {
  return isOperatorAsker(by) ? 'oculus' : 'headless'
}

export function sessionKindWords(kind: SessionKind): string {
  return kind === 'oculus'
    ? 'oculus — a screen belongs to this session: the operator is there and may switch away and come back; an ask waits for the screen without expiry'
    : 'headless — unattended: an ask nobody answers expires on its clock, and a question nobody can answer ends the run as blocked'
}

let consumed: { kind: SessionKind | undefined; raw: string | undefined } | null = null

export function consumeSessionKindPin(): { kind: SessionKind | undefined; raw: string | undefined } {
  const raw = flagEnv(SESSION_KIND_ENV)
  deleteFlagEnv(SESSION_KIND_ENV)
  if (consumed !== null) return consumed
  consumed = { kind: parseSessionKind(raw), raw }
  return consumed
}

export function resetSessionKindPinForTest(): void {
  consumed = null
}
