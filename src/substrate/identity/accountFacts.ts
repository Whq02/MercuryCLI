
import { operatorPrincipal } from './identity.js'
import { ensureOperatorKey } from './operatorKey.js'
import type { Principal } from './principal.js'

export interface OperatorAccountFact {
  id: string
  credentialed: boolean
  label?: string
}

export interface OperatorAccountFacts {
  families: OperatorAccountFact[]
}

export async function operatorAccountFacts(): Promise<OperatorAccountFacts> {
  const { providerFamilyPresences } = await import('../../services/providers/providerUsage.js')
  return {
    families: providerFamilyPresences().map(f => ({
      id: f.id as string,
      credentialed: f.credentialed,
      ...(f.credentialLabel !== undefined ? { label: f.credentialLabel } : {}),
    })),
  }
}

export interface OperatorIdentityView {
  principal: Principal
  publicKey: string
  createdAt: number
  accounts: OperatorAccountFacts
}

export async function operatorIdentity(): Promise<OperatorIdentityView> {
  const key = ensureOperatorKey()
  return {
    principal: operatorPrincipal(),
    publicKey: key.publicKeyRaw.toString('base64url'),
    createdAt: key.createdAt,
    accounts: await operatorAccountFacts(),
  }
}
