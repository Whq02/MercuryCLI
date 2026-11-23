
import { operatorKeyId } from './operatorKey.js'
import type { Principal } from './principal.js'
import { hostEnv } from '../../environment/hostEnv.js'

export function operatorPrincipal(): Principal {
  return { id: operatorKeyId(), kind: 'operator', name: hostEnv().USER || hostEnv().USERNAME || 'operator' }
}

export function assistantPrincipal(): Principal {
  return { id: 'agent-mercury', kind: 'agent', name: 'Mercury' }
}
