
import { operatorKeyId } from './operatorKey.js'
import type { Principal } from './principal.js'

export function operatorPrincipal(): Principal {
  return { id: operatorKeyId(), kind: 'operator', name: process.env.USER || 'operator' }
}

export function assistantPrincipal(): Principal {
  return { id: 'agent-mercury', kind: 'agent', name: 'Mercury' }
}
